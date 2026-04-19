/**
 * Browser-side helpers for registering a push subscription.
 *
 * Designed to be called once after a user lands on an authenticated
 * surface (manager inbox, HO dashboard). All paths are defensive —
 * the function is safe to call repeatedly, and no-ops cleanly on:
 *   - browsers without Service Worker / Push support
 *   - iOS Safari in "standalone=false" mode (permission never granted)
 *   - missing VAPID env on the server
 *   - users who've already denied permission (we don't re-prompt)
 *
 * Never throws. Returns a status string for logging only.
 */

export type SubscribeStatus =
  | "subscribed"
  | "already_subscribed"
  | "permission_denied"
  | "unsupported"
  | "no_vapid"
  | "error"

type SubscribeOpts =
  | { role: "manager"; sap_code: string }
  | { role: "ho" }

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  // Allocate the underlying ArrayBuffer explicitly so the resulting view is
  // `Uint8Array<ArrayBuffer>` (not `ArrayBufferLike`), which is what
  // PushManager.subscribe's BufferSource parameter wants.
  const ab = new ArrayBuffer(rawData.length)
  const out = new Uint8Array(ab)
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i)
  return out
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return ""
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function ensurePushSubscription(
  opts: SubscribeOpts,
): Promise<SubscribeStatus> {
  try {
    if (typeof window === "undefined") return "unsupported"
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return "unsupported"
    }
    if (!("Notification" in window)) return "unsupported"

    // Get the VAPID public key FIRST — if the server has no key there's
    // no point prompting the user for a permission they can't act on.
    const keyResp = await fetch("/api/push/vapid-public-key", {
      cache: "no-store",
    })
    if (!keyResp.ok) return "error"
    const { public_key } = (await keyResp.json()) as { public_key: string }
    if (!public_key) return "no_vapid"

    // Register the SW. Repeated calls are idempotent.
    const registration =
      (await navigator.serviceWorker.getRegistration("/sw.js")) ??
      (await navigator.serviceWorker.register("/sw.js", { scope: "/" }))

    // Check for an existing subscription — skip the prompt if we already
    // have one that matches the current VAPID key.
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      await registerWithServer(existing, opts)
      return "already_subscribed"
    }

    // Prompt for permission only if the decision hasn't been made. If
    // the user previously denied, we respect that and skip.
    if (Notification.permission === "denied") return "permission_denied"
    if (Notification.permission === "default") {
      const decision = await Notification.requestPermission()
      if (decision !== "granted") return "permission_denied"
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    })

    await registerWithServer(subscription, opts)
    return "subscribed"
  } catch (e) {
    console.warn("[push-client] ensurePushSubscription failed", e)
    return "error"
  }
}

async function registerWithServer(
  subscription: PushSubscription,
  opts: SubscribeOpts,
): Promise<void> {
  const body: Record<string, unknown> = {
    role: opts.role,
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64Url(subscription.getKey("p256dh")),
    auth: arrayBufferToBase64Url(subscription.getKey("auth")),
  }
  if (opts.role === "manager") body.sap_code = opts.sap_code

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * Best-effort sign-out cleanup. Sends a DELETE to the server and
 * unsubscribes from the push manager. Does NOT throw.
 */
export async function clearPushSubscription(): Promise<void> {
  try {
    if (typeof window === "undefined") return
    if (!("serviceWorker" in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration("/sw.js")
    if (!reg) return
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
    await sub.unsubscribe().catch(() => {})
  } catch {
    /* swallow — cleanup is best-effort */
  }
}
