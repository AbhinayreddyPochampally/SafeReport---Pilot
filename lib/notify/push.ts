import "server-only"
import webpush from "web-push"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

/**
 * Server-side web-push dispatcher.
 *
 * Pulls subscriptions from the `push_subscriptions` table, sends each
 * a payload via the `web-push` library, and writes the outcome to
 * `notification_log`. Gated behind VAPID env presence — if the keys
 * aren't configured the dispatcher returns `{ skipped: true }` without
 * erroring, so Phase E code paths can call it unconditionally during
 * pilot runtime before VAPID keys are set.
 *
 * 410 / 404 responses from the push service mean the subscription has
 * expired on the user's device — we drop those rows automatically so
 * the table doesn't accumulate dead endpoints.
 */

type PushPayload = {
  title: string
  body: string
  url?: string
  tag?: string
}

let configured: boolean | null = null

function ensureConfigured(): boolean {
  if (configured !== null) return configured
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!pub || !priv || !subject) {
    configured = false
    return false
  }
  webpush.setVapidDetails(subject, pub, priv)
  configured = true
  return true
}

type TargetOpts =
  | { role: "manager"; sap_code: string }
  | { role: "ho"; user_id?: string } // user_id=undefined → all HO

type DispatchResult = {
  skipped?: true
  reason?: string
  attempted: number
  sent: number
  dropped: number
  failed: number
}

export async function dispatchPush(
  target: TargetOpts,
  payload: PushPayload,
  auditMeta: {
    report_id: string | null
    event_type: string
  },
): Promise<DispatchResult> {
  if (!ensureConfigured()) {
    return {
      skipped: true,
      reason: "VAPID env not configured",
      attempted: 0,
      sent: 0,
      dropped: 0,
      failed: 0,
    }
  }

  const admin = createSupabaseAdminClient()

  let q = admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("role", target.role)

  if (target.role === "manager") {
    q = q.eq("store_code", target.sap_code)
  } else if (target.role === "ho" && target.user_id) {
    q = q.eq("user_id", target.user_id)
  }

  const { data: subs, error } = await q
  if (error) {
    console.error("[notify/push] subscription lookup failed", error)
    return { attempted: 0, sent: 0, dropped: 0, failed: 0 }
  }
  if (!subs || subs.length === 0) {
    return { attempted: 0, sent: 0, dropped: 0, failed: 0 }
  }

  const serialised = JSON.stringify(payload)
  let sent = 0
  let dropped = 0
  let failed = 0
  const toDelete: string[] = []

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint as string,
          keys: {
            p256dh: sub.p256dh as string,
            auth: sub.auth_key as string,
          },
        },
        serialised,
      )
      sent += 1
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        // Subscription is dead — drop it.
        toDelete.push(sub.id as string)
        dropped += 1
      } else {
        failed += 1
        console.warn("[notify/push] send failed", {
          endpoint: (sub.endpoint as string).slice(0, 60),
          status,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  if (toDelete.length > 0) {
    await admin
      .from("push_subscriptions")
      .delete()
      .in("id", toDelete)
      .then(({ error: delErr }) => {
        if (delErr) console.warn("[notify/push] cleanup delete failed", delErr)
      })
  }

  // Write one audit row per dispatch, summarising the fanout. Deliberately
  // not one-row-per-endpoint — that'd be noisy for a low-value signal.
  await admin.from("notification_log").insert({
    report_id: auditMeta.report_id,
    recipient_type: target.role,
    recipient_identifier:
      target.role === "manager"
        ? (target as { sap_code: string }).sap_code
        : (target as { user_id?: string }).user_id ?? "all",
    channel: "push",
    event_type: auditMeta.event_type,
    payload: { payload, sent, dropped, failed, attempted: subs.length } as Record<
      string,
      unknown
    >,
    delivery_status: failed > 0 ? "failed" : sent > 0 ? "sent" : "pending",
  })

  return { attempted: subs.length, sent, dropped, failed }
}
