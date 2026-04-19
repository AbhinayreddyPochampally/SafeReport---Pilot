import Link from "next/link"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  RotateCcw,
} from "lucide-react"
import { requireHoSession } from "@/lib/ho-auth"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { CATEGORIES } from "@/lib/categories"
import type { ReportCategory } from "@/lib/reporter-state"

export const dynamic = "force-dynamic"

/**
 * HO landing — /ho.
 *
 * Renders four summary cards, an approval queue, and a 12-month × 8-category
 * heatmap strip. All data is fetched in parallel on the server; no polling,
 * no realtime — HO refreshes manually and reacts to email/SMS.
 *
 * Data shape notes:
 *  - `reports.store_code` joins to `stores.sap_code`
 *  - `reports.reported_at` is the timestamp we count against for "this month"
 *  - scope is pilot-wide (national) for every HO user; RLS/scope filtering is
 *    a Phase E concern and not layered in yet
 */

type QueueRow = {
  id: string
  store_code: string
  store_name: string
  brand: string
  category: ReportCategory
  reported_at: string
}

type HeatmapCell = {
  category: ReportCategory
  /** ISO month boundary, YYYY-MM-01 */
  month: string
  count: number
}

function startOfThisMonthISO(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
}

function startOfMonthsAgoISO(monthsBack: number): string {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1),
  ).toISOString()
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMin = Math.max(0, Math.round((now - then) / 60_000))
  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  const diffWk = Math.round(diffDay / 7)
  if (diffWk < 5) return `${diffWk}w ago`
  // Fall back to an explicit short date for anything older.
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  })
}

async function fetchLandingData(monthStart: string, heatmapStart: string) {
  const admin = createSupabaseAdminClient()

  const [
    reportsThisMonth,
    awaitingHo,
    closedThisMonth,
    returnedThisMonth,
    queue,
    heatmap,
  ] = await Promise.all([
    admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .gte("reported_at", monthStart),
    admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("status", "awaiting_ho"),
    admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("status", "closed")
      .gte("reported_at", monthStart),
    admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("status", "returned")
      .gte("reported_at", monthStart),
    admin
      .from("reports")
      .select(
        "id, store_code, category, reported_at, stores!inner(name, brand)",
      )
      .eq("status", "awaiting_ho")
      .order("reported_at", { ascending: true })
      .limit(20),
    admin
      .from("reports")
      .select("category, reported_at")
      .gte("reported_at", heatmapStart),
  ])

  const queueRows: QueueRow[] = (queue.data ?? []).map((r) => {
    // Supabase returns joined rows as nested objects. We narrow here to the
    // two fields we actually need.
    const s = (r as unknown as {
      stores: { name: string; brand: string }
    }).stores
    return {
      id: r.id as string,
      store_code: r.store_code as string,
      store_name: s?.name ?? "—",
      brand: s?.brand ?? "—",
      category: r.category as ReportCategory,
      reported_at: r.reported_at as string,
    }
  })

  // Bucket the heatmap data into (category × month). We only need the last 12
  // months by spec, so truncate if the DB returns extras.
  const buckets = new Map<string, number>()
  for (const row of heatmap.data ?? []) {
    const dt = new Date(row.reported_at as string)
    const monthKey = new Date(
      Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10)
    const k = `${row.category}::${monthKey}`
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }

  const heatmapCells: HeatmapCell[] = []
  const now = new Date()
  for (const cat of CATEGORIES) {
    for (let m = 11; m >= 0; m--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1),
      )
      const monthKey = d.toISOString().slice(0, 10)
      heatmapCells.push({
        category: cat.key,
        month: monthKey,
        count: buckets.get(`${cat.key}::${monthKey}`) ?? 0,
      })
    }
  }

  return {
    reportsThisMonth: reportsThisMonth.count ?? 0,
    awaitingHo: awaitingHo.count ?? 0,
    closedThisMonth: closedThisMonth.count ?? 0,
    returnedThisMonth: returnedThisMonth.count ?? 0,
    queue: queueRows,
    heatmap: heatmapCells,
  }
}

export default async function HoLandingPage() {
  await requireHoSession("/ho")

  const monthStart = startOfThisMonthISO()
  const heatmapStart = startOfMonthsAgoISO(11) // current month + 11 back = 12 months

  const data = await fetchLandingData(monthStart, heatmapStart)

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Overview
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Pilot activity at a glance. Use the approval queue to clear
            outstanding resolutions first.
          </p>
        </div>
      </div>

      {/* Summary cards ------------------------------------------------------ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          accent="indigo"
          label="Reports this month"
          value={data.reportsThisMonth}
          icon={FileText}
        />
        <SummaryCard
          accent="sky"
          label="Awaiting my approval"
          value={data.awaitingHo}
          icon={Inbox}
          href="#approval-queue"
        />
        <SummaryCard
          accent="teal"
          label="Closed this month"
          value={data.closedThisMonth}
          icon={CheckCircle2}
        />
        <SummaryCard
          accent="orange"
          label="Returned this month"
          value={data.returnedThisMonth}
          icon={RotateCcw}
        />
      </div>

      {/* Approval queue ----------------------------------------------------- */}
      <section
        id="approval-queue"
        className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-8"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-sky-700" aria-hidden />
            <h2 className="text-base font-semibold text-slate-900">
              Approval queue
            </h2>
            <span className="ml-2 inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 border border-sky-200">
              {data.queue.length} awaiting
            </span>
          </div>
          <p className="text-xs text-slate-500">Oldest first</p>
        </div>

        {data.queue.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-700 mb-3">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </div>
            <p className="text-sm text-slate-700">All caught up.</p>
            <p className="text-xs text-slate-500 mt-1">
              Nothing is waiting on HO right now.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {data.queue.map((row) => (
              <QueueItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </section>

      {/* Category heatmap --------------------------------------------------- */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-slate-600" aria-hidden />
            <h2 className="text-base font-semibold text-slate-900">
              Category heatmap
            </h2>
          </div>
          <p className="text-xs text-slate-500">Last 12 months</p>
        </div>
        <Heatmap cells={data.heatmap} />
      </section>
    </div>
  )
}

/* ----------------------------- Summary card ------------------------------ */

type AccentKey = "indigo" | "sky" | "teal" | "orange"

const ACCENT_STYLES: Record<
  AccentKey,
  { text: string; bg: string; ring: string }
> = {
  indigo: {
    text: "text-indigo-700",
    bg: "bg-indigo-50",
    ring: "ring-indigo-100",
  },
  sky: { text: "text-sky-700", bg: "bg-sky-50", ring: "ring-sky-100" },
  teal: { text: "text-teal-700", bg: "bg-teal-50", ring: "ring-teal-100" },
  orange: {
    text: "text-orange-700",
    bg: "bg-orange-50",
    ring: "ring-orange-100",
  },
}

function SummaryCard({
  accent,
  label,
  value,
  icon: Icon,
  href,
}: {
  accent: AccentKey
  label: string
  value: number
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  href?: string
}) {
  const s = ACCENT_STYLES[accent]
  const inner = (
    <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-sm transition-shadow h-full flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${s.bg} ${s.text} ring-1 ${s.ring}`}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        {href ? (
          <ArrowRight className="h-4 w-4 text-slate-400" aria-hidden />
        ) : null}
      </div>
      <div>
        <div
          className={`text-3xl font-semibold tracking-tight ${s.text} tabular-nums`}
        >
          {value}
        </div>
        <div className="text-sm text-slate-600 mt-1">{label}</div>
      </div>
    </div>
  )
  return href ? (
    <Link href={href} className="block focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-xl">
      {inner}
    </Link>
  ) : (
    inner
  )
}

/* ------------------------------ Queue item ------------------------------- */

function QueueItem({ row }: { row: QueueRow }) {
  const cat = CATEGORIES.find((c) => c.key === row.category)
  const Icon = cat?.icon ?? FileText
  const kindAccent =
    cat?.kind === "incident"
      ? "text-amber-700 bg-amber-50 ring-amber-100"
      : "text-slate-700 bg-slate-100 ring-slate-200"

  return (
    <li>
      <Link
        href={`/ho/reports/${row.id}`}
        className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors"
      >
        <span
          className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ring-1 ${kindAccent} shrink-0`}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-slate-500 shrink-0">{row.id}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-900 font-medium truncate">
              {cat?.label ?? row.category}
            </span>
            {cat?.acronym ? (
              <span className="text-xs text-slate-500">({cat.acronym})</span>
            ) : null}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 truncate">
            {row.brand} · {row.store_name} ·{" "}
            <span className="font-mono text-slate-600">{row.store_code}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-slate-500">
            {formatRelative(row.reported_at)}
          </div>
          <div className="inline-flex items-center gap-1 mt-1 text-xs text-sky-700 font-medium">
            Review
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </div>
        </div>
      </Link>
    </li>
  )
}

/* -------------------------------- Heatmap -------------------------------- */

function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  // Compute the max count so we can map to 5 discrete opacity buckets. A flat
  // linear mapping puts too much weight on outliers, so we take a gentle root.
  const max = cells.reduce((m, c) => (c.count > m ? c.count : m), 0)

  // Pull a stable ordered list of months from the data (cells are emitted in
  // oldest→newest order per category; all categories share the same month set).
  const months = Array.from(new Set(cells.map((c) => c.month))).sort()
  const monthLabel = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString("en-IN", { month: "short" })
  }

  // Group cells by category for row rendering.
  const byCategory = new Map<ReportCategory, HeatmapCell[]>()
  for (const c of cells) {
    const arr = byCategory.get(c.category) ?? []
    arr.push(c)
    byCategory.set(c.category, arr)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr>
            <th className="text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide px-6 py-3">
              Category
            </th>
            {months.map((m) => (
              <th
                key={m}
                scope="col"
                className="text-center text-[11px] font-medium text-slate-500 uppercase tracking-wide px-1 py-3"
              >
                {monthLabel(m)}
              </th>
            ))}
            <th className="px-6" />
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((cat) => {
            const row = (byCategory.get(cat.key) ?? []).sort((a, b) =>
              a.month.localeCompare(b.month),
            )
            const rowTotal = row.reduce((n, c) => n + c.count, 0)
            const isIncident = cat.kind === "incident"
            return (
              <tr key={cat.key} className="border-t border-slate-100">
                <td className="px-6 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <cat.icon
                      className={`h-4 w-4 ${
                        isIncident ? "text-amber-700" : "text-slate-600"
                      }`}
                      aria-hidden
                    />
                    <span className="text-slate-800">{cat.label}</span>
                  </div>
                </td>
                {row.map((c) => (
                  <HeatmapCellBox
                    key={c.month}
                    count={c.count}
                    max={max}
                    isIncident={isIncident}
                    month={c.month}
                    categoryLabel={cat.label}
                  />
                ))}
                <td className="px-6 py-2 text-right text-slate-500 tabular-nums">
                  {rowTotal}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function HeatmapCellBox({
  count,
  max,
  isIncident,
  month,
  categoryLabel,
}: {
  count: number
  max: number
  isIncident: boolean
  month: string
  categoryLabel: string
}) {
  // 0 → empty cell; otherwise bucket into 1..5 using sqrt scaling against max.
  let bucket = 0
  if (count > 0 && max > 0) {
    const ratio = Math.sqrt(count) / Math.sqrt(max)
    bucket = Math.max(1, Math.min(5, Math.ceil(ratio * 5)))
  }
  // Palette rule: incidents = amber, observations = slate. Never green/red.
  const paletteAmber = [
    "bg-slate-50",
    "bg-amber-100",
    "bg-amber-200",
    "bg-amber-300",
    "bg-amber-500",
    "bg-amber-700",
  ]
  const paletteSlate = [
    "bg-slate-50",
    "bg-slate-200",
    "bg-slate-300",
    "bg-slate-400",
    "bg-slate-500",
    "bg-slate-700",
  ]
  const palette = isIncident ? paletteAmber : paletteSlate
  const textInverted = bucket >= 4
  return (
    <td className="px-1 py-1 align-middle">
      <div
        title={`${categoryLabel} · ${new Date(month).toLocaleDateString(
          "en-IN",
          { month: "short", year: "numeric" },
        )} · ${count}`}
        className={`mx-auto h-7 w-7 rounded flex items-center justify-center text-[11px] tabular-nums ${
          palette[bucket]
        } ${textInverted ? "text-white" : "text-slate-700"}`}
      >
        {count > 0 ? count : ""}
      </div>
    </td>
  )
}
