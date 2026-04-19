import "server-only"
import { NextRequest, NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getManagerSession } from "@/lib/manager-auth"
import { getHoSession } from "@/lib/ho-auth"

/**
 * POST /api/push/subscribe — register a web-push subscription.
 *
 * Body:
 *   {
 *     role:       'manager' | 'ho',
 *     sap_code?:  string,          // required for role=manager
 *     endpoint:   string,          // from PushSubscription#endpoint
 *     p256dh:     string,          // subscription.getKey('p256dh') — base64url
 *     auth:       string,          // subscription.getKey('auth')   — base64url
 *   }
 *
 * Auth: the caller must already have the matching surface session
 * (manager cookie for role=manager, HO Supabase Auth for role=ho).
 * We bind the subscription row to the store_code or user_id so the
 * dispatcher knows who to notify.
 *
 * Endpoint uniqueness is enforced at the DB level, so re-subscribing
 * (e.g. after the browser recycles the endpoint) upserts cleanly.
 */

const ROLES = new Set(["manager", "ho"])

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const role = typeof body.role === "string" ? body.role : ""
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : ""
  const p256dh = typeof body.p256dh === "string" ? body.p256dh : ""
  const auth = typeof body.auth === "string" ? body.auth : ""
  const sap_code = typeof body.sap_code === "string" ? body.sap_code.trim() : ""

  if (!ROLES.has(role)) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 })
  }
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json(
      { error: "Missing subscription keys." },
      { status: 400 },
    )
  }

  const admin = createSupabaseAdminClient()

  // `row` fields are mutated below based on role; the binding itself
  // never gets reassigned, so const is correct here.
  const row: Record<string, unknown> = {
    role,
    endpoint,
    p256dh,
    auth_key: auth,
  }

  if (role === "manager") {
    if (!sap_code) {
      return NextResponse.json(
        { error: "sap_code required for manager role." },
        { status: 400 },
      )
    }
    const session = await getManagerSession(sap_code)
    if (!session) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 })
    }
    row.store_code = sap_code
  } else {
    const session = await getHoSession()
    if (!session) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 })
    }
    row.user_id = session.user_id
  }

  // Upsert on `endpoint` — the unique constraint in the schema. If
  // this browser already has a subscription we simply refresh the
  // keys (which can rotate) and re-bind the role/store.
  const { error } = await admin
    .from("push_subscriptions")
    .upsert(row, { onConflict: "endpoint" })

  if (error) {
    console.error("[push/subscribe] upsert failed", error)
    return NextResponse.json({ error: "Could not save subscription." }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/push/subscribe — tear down a subscription (manager hits
 * this on sign-out so we don't buzz a device that's no longer logged
 * in).
 *
 * Body: { endpoint: string }
 */
export async function DELETE(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : ""
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint." }, { status: 400 })
  }

  const admin = createSupabaseAdminClient()
  const { error } = await admin
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)

  if (error) {
    console.error("[push/subscribe DELETE] failed", error)
    return NextResponse.json({ error: "Could not remove subscription." }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
