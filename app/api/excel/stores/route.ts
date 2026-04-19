import "server-only"
import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getHoSession } from "@/lib/ho-auth"

/**
 * POST /api/excel/stores — CSV import for the store registry.
 *
 * Accepts multipart/form-data with a single field named `file`. Expects a
 * CSV whose header row is a permutation/subset of:
 *
 *   sap_code, name, brand, city, state, location,
 *   manager_name, manager_phone, pin, status
 *
 * `sap_code` is the primary key and must be present. Rows upsert by it.
 * Plain-text PINs are bcrypted before any DB write. Rows that fail
 * per-row validation are reported back in `errors[]` alongside the counts.
 *
 * We deliberately roll a minimal CSV parser here instead of adding
 * SheetJS — the input is small (≤ a few thousand rows) and the sandbox's
 * CDN allowlist has bitten us on external bundles before. SheetJS lands
 * in Phase F where we need .xlsx writing.
 */

const STATUSES = new Set(["active", "temporarily_closed", "permanently_closed"])
const SAP_CODE = /^[A-Z0-9][A-Z0-9-]{1,20}$/

// Canonical column names we accept, including a few common alternates.
const HEADER_ALIASES: Record<string, string> = {
  sap: "sap_code",
  sap_code: "sap_code",
  "sap code": "sap_code",
  name: "name",
  "store name": "name",
  brand: "brand",
  city: "city",
  state: "state",
  location: "location",
  mall: "location",
  manager: "manager_name",
  manager_name: "manager_name",
  "manager name": "manager_name",
  phone: "manager_phone",
  manager_phone: "manager_phone",
  "manager phone": "manager_phone",
  pin: "pin",
  manager_pin: "pin",
  status: "status",
}

type ParsedRow = {
  sap_code: string
  name?: string
  brand?: string
  city?: string
  state?: string
  location?: string | null
  manager_name?: string | null
  manager_phone?: string | null
  pin?: string | null
  status?: string
}

/**
 * Minimal CSV parser that handles:
 *   - quoted fields ("a,b" is one field)
 *   - escaped quotes ("a""b" is a"b)
 *   - CRLF or LF line endings
 *   - trailing blank lines
 *
 * Returns an array of string[] rows. Caller handles header mapping.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ",") {
      row.push(cell)
      cell = ""
      continue
    }
    if (c === "\r") continue
    if (c === "\n") {
      row.push(cell)
      cell = ""
      if (row.some((x) => x.length > 0)) rows.push(row)
      row = []
      continue
    }
    cell += c
  }
  // Flush any trailing cell/row.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    if (row.some((x) => x.length > 0)) rows.push(row)
  }
  return rows
}

export async function POST(req: NextRequest) {
  const session = await getHoSession()
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    )
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field in upload." },
      { status: 400 },
    )
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json(
      { error: "CSV exceeds 5MB cap. Split and retry." },
      { status: 413 },
    )
  }

  let text: string
  try {
    text = await file.text()
  } catch {
    return NextResponse.json({ error: "Could not read file." }, { status: 400 })
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // strip BOM

  const rows = parseCsv(text)
  if (rows.length === 0) {
    return NextResponse.json({ error: "CSV is empty." }, { status: 400 })
  }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const mapped = header.map((h) => HEADER_ALIASES[h] ?? null)

  if (!mapped.includes("sap_code")) {
    return NextResponse.json(
      { error: "CSV must include a 'sap_code' column." },
      { status: 400 },
    )
  }

  const errors: string[] = []
  const parsed: ParsedRow[] = []

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i]
    const rec: Partial<ParsedRow> = {}
    for (let j = 0; j < raw.length; j++) {
      const key = mapped[j]
      if (!key) continue
      const val = raw[j].trim()
      if (val === "") {
        if (key === "location" || key === "manager_name" || key === "manager_phone" || key === "pin") {
          ;(rec as Record<string, unknown>)[key] = null
        }
        continue
      }
      ;(rec as Record<string, unknown>)[key] = val
    }
    if (!rec.sap_code) {
      errors.push(`Row ${i + 1}: missing sap_code`)
      continue
    }
    if (!SAP_CODE.test(rec.sap_code)) {
      errors.push(`Row ${i + 1}: invalid sap_code "${rec.sap_code}"`)
      continue
    }
    if (rec.status && !STATUSES.has(rec.status)) {
      errors.push(
        `Row ${i + 1} (${rec.sap_code}): invalid status "${rec.status}"`,
      )
      continue
    }
    if (rec.pin != null && rec.pin !== "" && !/^\d{4}$/.test(rec.pin)) {
      errors.push(
        `Row ${i + 1} (${rec.sap_code}): PIN must be exactly 4 digits`,
      )
      continue
    }
    parsed.push(rec as ParsedRow)
  }

  if (parsed.length === 0) {
    return NextResponse.json(
      {
        inserted: 0,
        updated: 0,
        skipped: rows.length - 1,
        errors: errors.length ? errors : ["No parseable rows in CSV."],
      },
      { status: 200 },
    )
  }

  const admin = createSupabaseAdminClient()

  // Figure out which SAP codes already exist so we can split the counts.
  const { data: existing, error: existErr } = await admin
    .from("stores")
    .select("sap_code")
    .in(
      "sap_code",
      parsed.map((p) => p.sap_code),
    )

  if (existErr) {
    console.error("[excel/stores] existence check failed", existErr)
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 })
  }

  const existingSet = new Set((existing ?? []).map((e) => e.sap_code as string))

  // Build the upsert payload. For NEW rows, fill required columns with
  // sensible defaults if the CSV omits them. For EXISTING rows, only
  // overwrite the columns that were actually present in the CSV.
  const toInsert: Record<string, unknown>[] = []
  const toUpdate: Record<string, unknown>[] = []
  let skipped = 0

  for (const rec of parsed) {
    const isNew = !existingSet.has(rec.sap_code)
    if (isNew) {
      // A new store MUST provide the required NOT NULL columns.
      const missing: string[] = []
      if (!rec.name) missing.push("name")
      if (!rec.brand) missing.push("brand")
      if (!rec.city) missing.push("city")
      if (!rec.state) missing.push("state")
      if (missing.length > 0) {
        errors.push(
          `${rec.sap_code}: new store missing required field(s) ${missing.join(", ")}`,
        )
        skipped += 1
        continue
      }
    }

    const row: Record<string, unknown> = { sap_code: rec.sap_code }
    if (rec.name != null) row.name = rec.name
    if (rec.brand != null) row.brand = rec.brand
    if (rec.city != null) row.city = rec.city
    if (rec.state != null) row.state = rec.state
    if ("location" in rec) row.location = rec.location
    if ("manager_name" in rec) row.manager_name = rec.manager_name
    if ("manager_phone" in rec) row.manager_phone = rec.manager_phone
    if (rec.status) row.status = rec.status
    if (rec.pin) {
      row.manager_pin_hash = await bcrypt.hash(rec.pin, 10)
    }
    row.updated_at = new Date().toISOString()

    if (isNew) {
      toInsert.push(row)
    } else {
      toUpdate.push(row)
    }
  }

  let inserted = 0
  let updated = 0

  if (toInsert.length > 0) {
    const { error } = await admin.from("stores").insert(toInsert)
    if (error) {
      console.error("[excel/stores] insert failed", error)
      return NextResponse.json(
        { error: "Insert failed — no rows were written." },
        { status: 500 },
      )
    }
    inserted = toInsert.length
  }

  // PostgREST doesn't do multi-row UPDATE in one shot by a non-PK match;
  // per-row is fine at pilot size. If this becomes slow we'll batch with
  // an RPC.
  for (const row of toUpdate) {
    const { sap_code, ...rest } = row
    const { error } = await admin
      .from("stores")
      .update(rest)
      .eq("sap_code", sap_code as string)
    if (error) {
      console.error("[excel/stores] update failed", { sap_code, error })
      errors.push(`${sap_code}: update failed — ${error.message}`)
      skipped += 1
    } else {
      updated += 1
    }
  }

  console.info("[excel/stores] imported", {
    by: session.email ?? session.user_id,
    inserted,
    updated,
    skipped,
    errors: errors.length,
  })

  return NextResponse.json({
    inserted,
    updated,
    skipped,
    errors,
  })
}
