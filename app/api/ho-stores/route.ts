import "server-only"
import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getHoSession } from "@/lib/ho-auth"

/**
 * PATCH /api/ho-stores — update a single store's metadata (and optionally
 * reset its manager PIN).
 *
 * Body:
 *   {
 *     sap_code:       string            // REQUIRED — identifies the row
 *     name?:          string
 *     brand?:         string
 *     city?:          string
 *     state?:         string
 *     location?:      string | null
 *     manager_name?:  string | null
 *     manager_phone?: string | null
 *     status?:        'active' | 'temporarily_closed' | 'permanently_closed'
 *     new_pin?:       string | null     // if present, 4 digits — bcrypted server-side
 *   }
 *
 * Auth: requires any HO session. Scope filtering (region etc.) lands in
 * Phase E when we have > national-scope users.
 */

const STATUSES = new Set(["active", "temporarily_closed", "permanently_closed"])
const SAP_CODE = /^[A-Z0-9][A-Z0-9-]{1,20}$/

export async function PATCH(req: NextRequest) {
  const session = await getHoSession()
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const sap = typeof body.sap_code === "string" ? body.sap_code.trim() : ""
  if (!SAP_CODE.test(sap)) {
    return NextResponse.json({ error: "Invalid sap_code." }, { status: 400 })
  }

  // Build the update patch from only the fields that were actually present.
  const patch: Record<string, unknown> = {}

  function pickString(key: string, opts: { min?: number; max?: number } = {}): string | null | undefined {
    if (!(key in body)) return undefined
    const v = body[key]
    if (v === null) return null
    if (typeof v !== "string") return undefined
    const trimmed = v.trim()
    if (trimmed === "") return null
    if (opts.min && trimmed.length < opts.min) return undefined
    if (opts.max && trimmed.length > opts.max) return undefined
    return trimmed
  }

  const name = pickString("name", { min: 1, max: 200 })
  if (name !== undefined) {
    if (name === null) {
      return NextResponse.json({ error: "Store name is required." }, { status: 400 })
    }
    patch.name = name
  }
  const brand = pickString("brand", { min: 1, max: 100 })
  if (brand !== undefined) {
    if (brand === null) {
      return NextResponse.json({ error: "Brand is required." }, { status: 400 })
    }
    patch.brand = brand
  }
  const city = pickString("city", { min: 1, max: 100 })
  if (city !== undefined) {
    if (city === null) {
      return NextResponse.json({ error: "City is required." }, { status: 400 })
    }
    patch.city = city
  }
  const state = pickString("state", { min: 1, max: 100 })
  if (state !== undefined) {
    if (state === null) {
      return NextResponse.json({ error: "State is required." }, { status: 400 })
    }
    patch.state = state
  }
  const location = pickString("location", { max: 200 })
  if (location !== undefined) patch.location = location
  const managerName = pickString("manager_name", { max: 100 })
  if (managerName !== undefined) patch.manager_name = managerName
  const managerPhone = pickString("manager_phone", { max: 40 })
  if (managerPhone !== undefined) patch.manager_phone = managerPhone

  if ("status" in body) {
    const s = body.status
    if (typeof s !== "string" || !STATUSES.has(s)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 })
    }
    patch.status = s
  }

  if ("new_pin" in body && body.new_pin !== null && body.new_pin !== "") {
    const pin = body.new_pin
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      return NextResponse.json({ error: "PIN must be 4 digits." }, { status: 400 })
    }
    patch.manager_pin_hash = await bcrypt.hash(pin, 10)
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 })
  }

  patch.updated_at = new Date().toISOString()

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from("stores")
    .update(patch)
    .eq("sap_code", sap)
    .select("sap_code")
    .maybeSingle()

  if (error) {
    console.error("[ho-stores] update failed", { sap, error })
    return NextResponse.json({ error: "Update failed." }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "Store not found." }, { status: 404 })
  }

  console.info("[ho-stores] updated", {
    sap,
    by: session.email ?? session.user_id,
    fields: Object.keys(patch).filter((k) => k !== "updated_at"),
  })

  return NextResponse.json({ ok: true, sap_code: sap })
}
