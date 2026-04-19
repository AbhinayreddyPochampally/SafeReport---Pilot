import "server-only"
import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getHoSession } from "@/lib/ho-auth"

/**
 * GET /api/excel/export — streams a filtered .xlsx of reports for HO.
 *
 * Query params (all optional — same semantics as /api/ho-analytics):
 *   from      YYYY-MM-DD  inclusive, interpreted UTC
 *   to        YYYY-MM-DD  inclusive, interpreted end-of-day UTC
 *   brand     repeatable
 *   city      repeatable
 *   category  repeatable (one of the 8 enum values)
 *
 * Output shape:
 *   One worksheet per calendar month that falls in the [from, to] window,
 *   named like `Apr 2026`. Months with zero reports still get a sheet with
 *   just the header row, so the reader can see the span at a glance.
 *
 *   Columns (per row = one report):
 *     Report ID | Type | Category | Status | Store Code | Store Name |
 *     Brand | City | Incident At (IST) | Filed At (IST) | Acknowledged At (IST) |
 *     Description | Transcript | Resolutions | Latest Attempt | Latest Fix Note |
 *     Latest HO Action | HO Comment | Reporter Name | Reporter Phone
 *
 *   Reporter name/phone are included because this endpoint is HO-only
 *   (guarded by getHoSession). Managers never see this file.
 *
 * Why in-Node aggregation rather than a Postgres view: the dataset is tiny
 * (pilot caps out at a few thousand rows) and the shape we want for the
 * spreadsheet doesn't align with what PostgREST returns from a view. If we
 * ever need to scale this, push it into a SQL function that returns JSON.
 */

export const runtime = "nodejs"

const CATEGORY_LABEL: Record<string, string> = {
  near_miss: "Near Miss",
  unsafe_act: "Unsafe Act",
  unsafe_condition: "Unsafe Condition",
  first_aid_case: "First Aid Case",
  medical_treatment_case: "Medical Treatment",
  restricted_work_case: "Restricted Work",
  lost_time_injury: "Lost Time Injury",
  fatality: "Fatality",
}

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  in_progress: "Acknowledged",
  awaiting_ho: "Awaiting HO",
  returned: "Returned",
  closed: "Closed",
  voided: "Voided",
}

const ACTION_LABEL: Record<string, string> = {
  approve: "Approved",
  return: "Returned for rework",
  void: "Voided",
}

function parseDate(s: string | null, fallback: Date): Date {
  if (!s) return fallback
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return fallback
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return Number.isNaN(d.getTime()) ? fallback : d
}

// IST timezone formatter — pilot is all India, so render times in IST to
// match what the HO user sees in the dashboard.
const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function fmtIST(ts: string | null | undefined): string {
  if (!ts) return ""
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ""
  return IST.format(d)
}

function monthKeyUTC(d: Date): string {
  // YYYY-MM — used as the sortable key. The visible sheet name formats it.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${y}-${m}`
}

function monthLabel(key: string): string {
  // "2026-04" → "Apr 2026"
  const [y, m] = key.split("-").map((x) => parseInt(x, 10))
  const d = new Date(Date.UTC(y, m - 1, 1))
  return d.toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

// Excel caps sheet names at 31 chars and forbids : \ / ? * [ ]
function sanitiseSheetName(s: string): string {
  return s.replace(/[:\\/?*[\]]/g, "-").slice(0, 31)
}

// Widen column widths based on header length + a sensible minimum. Keeps the
// spreadsheet readable without forcing the reader to auto-fit every column.
function colWidths(headers: string[]): { wch: number }[] {
  const mins: Record<string, number> = {
    "Report ID": 12,
    "Type": 12,
    "Category": 20,
    "Status": 14,
    "Store Code": 12,
    "Store Name": 30,
    "Brand": 14,
    "City": 14,
    "Incident At (IST)": 20,
    "Filed At (IST)": 20,
    "Acknowledged At (IST)": 22,
    "Description": 40,
    "Transcript": 50,
    "Resolutions": 12,
    "Latest Attempt": 14,
    "Latest Fix Note": 50,
    "Latest HO Action": 18,
    "HO Comment": 40,
    "Reporter Name": 22,
    "Reporter Phone": 16,
  }
  return headers.map((h) => ({ wch: mins[h] ?? Math.max(12, h.length + 2) }))
}

type ReportRow = {
  id: string
  store_code: string
  type: string
  category: string
  status: string
  reporter_name: string | null
  reporter_phone: string | null
  description: string | null
  transcript: string | null
  incident_datetime: string | null
  reported_at: string
  acknowledged_at: string | null
  stores: { name: string; brand: string; city: string } | null
}

type ResolutionRow = {
  id: string
  report_id: string
  attempt_number: number
  note: string | null
  resolved_at: string
}

type HoActionRow = {
  report_id: string
  action: "approve" | "return" | "void"
  rejection_reason: string | null
  acted_at: string
}

export async function GET(req: NextRequest) {
  const session = await getHoSession()
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  const url = new URL(req.url)
  const now = new Date()
  const defaultFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  )
  const from = parseDate(url.searchParams.get("from"), defaultFrom)
  const to = parseDate(url.searchParams.get("to"), now)
  const toExclusive = new Date(to)
  toExclusive.setUTCHours(23, 59, 59, 999)

  const brandFilter = url.searchParams.getAll("brand").filter(Boolean)
  const cityFilter = url.searchParams.getAll("city").filter(Boolean)
  const categoryFilter = url.searchParams.getAll("category").filter(Boolean)

  const admin = createSupabaseAdminClient()

  // Main reports fetch with inner-join onto stores so brand/city/name
  // filter and render in the same row. Matches the analytics query shape.
  let q = admin
    .from("reports")
    .select(
      [
        "id",
        "store_code",
        "type",
        "category",
        "status",
        "reporter_name",
        "reporter_phone",
        "description",
        "transcript",
        "incident_datetime",
        "reported_at",
        "acknowledged_at",
        "stores!inner(name, brand, city)",
      ].join(","),
    )
    .gte("reported_at", from.toISOString())
    .lte("reported_at", toExclusive.toISOString())
    .order("reported_at", { ascending: true })

  if (brandFilter.length > 0) q = q.in("stores.brand", brandFilter)
  if (cityFilter.length > 0) q = q.in("stores.city", cityFilter)
  if (categoryFilter.length > 0) q = q.in("category", categoryFilter)

  const { data: reportsData, error: repErr } = await q
  if (repErr) {
    console.error("[api/excel/export] reports query failed", repErr)
    return NextResponse.json({ error: "Export failed." }, { status: 500 })
  }
  const reports = (reportsData as unknown as ReportRow[]) ?? []

  // Pull resolutions + ho_actions for just the returned reports so we can
  // render the latest attempt and HO verdict per row. Two scoped queries
  // instead of a big join keep the shape simple.
  const reportIds = reports.map((r) => r.id)
  const [resolsResp, actionsResp] = await Promise.all([
    reportIds.length === 0
      ? Promise.resolve({ data: [] as ResolutionRow[], error: null })
      : admin
          .from("resolutions")
          .select("id, report_id, attempt_number, note, resolved_at")
          .in("report_id", reportIds),
    reportIds.length === 0
      ? Promise.resolve({ data: [] as HoActionRow[], error: null })
      : admin
          .from("ho_actions")
          .select("report_id, action, rejection_reason, acted_at")
          .in("report_id", reportIds)
          .order("acted_at", { ascending: false }),
  ])

  if (resolsResp.error) {
    console.error("[api/excel/export] resolutions query failed", resolsResp.error)
    return NextResponse.json({ error: "Export failed." }, { status: 500 })
  }
  if (actionsResp.error) {
    console.error("[api/excel/export] ho_actions query failed", actionsResp.error)
    return NextResponse.json({ error: "Export failed." }, { status: 500 })
  }

  // Index by report_id for cheap lookups while building rows.
  const resolsByReport = new Map<string, ResolutionRow[]>()
  for (const r of (resolsResp.data as ResolutionRow[]) ?? []) {
    const arr = resolsByReport.get(r.report_id) ?? []
    arr.push(r)
    resolsByReport.set(r.report_id, arr)
  }
  const latestActionByReport = new Map<string, HoActionRow>()
  // actions query already sorted desc → first hit for a given id wins.
  for (const a of (actionsResp.data as HoActionRow[]) ?? []) {
    if (!latestActionByReport.has(a.report_id)) {
      latestActionByReport.set(a.report_id, a)
    }
  }

  // --- Build sheets --------------------------------------------------------
  // One sheet per UTC-calendar month in [from, to]. Empty months get an
  // empty-bodied sheet so the reader sees the full range rather than
  // silently skipped gaps.
  const headers = [
    "Report ID",
    "Type",
    "Category",
    "Status",
    "Store Code",
    "Store Name",
    "Brand",
    "City",
    "Incident At (IST)",
    "Filed At (IST)",
    "Acknowledged At (IST)",
    "Description",
    "Transcript",
    "Resolutions",
    "Latest Attempt",
    "Latest Fix Note",
    "Latest HO Action",
    "HO Comment",
    "Reporter Name",
    "Reporter Phone",
  ] as const

  type Row = Record<(typeof headers)[number], string | number>

  function buildRow(r: ReportRow): Row {
    const resols = (resolsByReport.get(r.id) ?? []).sort(
      (a, b) => b.attempt_number - a.attempt_number,
    )
    const latestResol = resols[0]
    const latestAction = latestActionByReport.get(r.id)
    return {
      "Report ID": r.id,
      "Type": r.type === "incident" ? "Incident" : "Observation",
      "Category": CATEGORY_LABEL[r.category] ?? r.category,
      "Status": STATUS_LABEL[r.status] ?? r.status,
      "Store Code": r.store_code,
      "Store Name": r.stores?.name ?? "",
      "Brand": r.stores?.brand ?? "",
      "City": r.stores?.city ?? "",
      "Incident At (IST)": fmtIST(r.incident_datetime),
      "Filed At (IST)": fmtIST(r.reported_at),
      "Acknowledged At (IST)": fmtIST(r.acknowledged_at),
      "Description": r.description ?? "",
      "Transcript": r.transcript ?? "",
      "Resolutions": resols.length,
      "Latest Attempt": latestResol?.attempt_number ?? "",
      "Latest Fix Note": latestResol?.note ?? "",
      "Latest HO Action": latestAction
        ? ACTION_LABEL[latestAction.action] ?? latestAction.action
        : "",
      "HO Comment": latestAction?.rejection_reason ?? "",
      "Reporter Name": r.reporter_name ?? "",
      "Reporter Phone": r.reporter_phone ?? "",
    }
  }

  // Bucket rows by month (based on reported_at — the date the report
  // was filed, which is the analytics-relevant anchor).
  const byMonth = new Map<string, Row[]>()
  for (const r of reports) {
    const key = monthKeyUTC(new Date(r.reported_at))
    const arr = byMonth.get(key) ?? []
    arr.push(buildRow(r))
    byMonth.set(key, arr)
  }

  // Emit every month in the range even if empty.
  const monthKeys: string[] = []
  {
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
    while (cursor <= end) {
      monthKeys.push(monthKeyUTC(cursor))
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  }

  const workbook = XLSX.utils.book_new()
  const widths = colWidths(headers as unknown as string[])

  // If no months fall in the range (impossible in practice but safe),
  // emit a single summary sheet so the file isn't empty.
  if (monthKeys.length === 0) {
    const ws = XLSX.utils.json_to_sheet([], { header: headers as unknown as string[] })
    ws["!cols"] = widths
    XLSX.utils.book_append_sheet(workbook, ws, "No data")
  } else {
    for (const key of monthKeys) {
      const rows = byMonth.get(key) ?? []
      const ws = XLSX.utils.json_to_sheet(rows, {
        header: headers as unknown as string[],
      })
      ws["!cols"] = widths
      // Freeze the header row. Helps readers of multi-hundred-row sheets.
      ws["!freeze"] = { ySplit: 1 }
      // XLSX Utils doesn't consult !freeze, but setting it keeps intent
      // in the file for clients that do. Freeze-panes via views:
      ;(ws as { [k: string]: unknown })["!views"] = [{ ySplit: 1 }]
      const sheetName = sanitiseSheetName(monthLabel(key))
      XLSX.utils.book_append_sheet(workbook, ws, sheetName)
    }
  }

  const buf = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
  }) as Buffer

  const stamp = new Date().toISOString().slice(0, 10)
  const fileName = `safereport-${stamp}.xlsx`

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      "Content-Length": String(buf.byteLength),
    },
  })
}
