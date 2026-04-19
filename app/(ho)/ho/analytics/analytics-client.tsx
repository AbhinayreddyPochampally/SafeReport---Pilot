"use client"

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  CalendarRange,
  Download,
  Filter,
  Loader2,
  RotateCcw,
  TrendingUp,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { CATEGORIES } from "@/lib/categories"

/**
 * HO analytics client. Fetches aggregated data from /api/ho-analytics and
 * renders four charts + a filter panel. Refetches whenever the user changes
 * a filter chip or date range.
 *
 * Palette rules (CLAUDE.md):
 *  - No green / no red. Status series use: slate 600, indigo 700, sky 700,
 *    orange 700, teal 700 (+ slate 400 for voided).
 *  - Observations → slate axis, incidents → amber axis for category mix.
 *
 * The dataset is small (~60 reports at pilot start), so every re-render
 * recomputes from the fetched payload. No memoisation beyond useMemo on
 * derived arrays.
 */

// ---- Types returned by /api/ho-analytics --------------------------------

type Totals = {
  reports: number
  closed: number
  returned: number
  voided: number
  awaiting_ho: number
}

type Weekly = {
  week_start: string
  new: number
  in_progress: number
  awaiting_ho: number
  returned: number
  closed: number
  voided: number
}

type MonthlyMix = { month: string } & Record<string, number | string>

type LeaderboardRow = {
  sap_code: string
  name: string
  brand: string
  city: string
  total: number
  first_attempt_rate: number
}

type HeatmapCell = { category: string; month: string; count: number }

type Payload = {
  range: { from: string; to: string }
  filters: {
    brands: string[]
    cities: string[]
    categories: readonly string[]
    applied: { brand: string[]; city: string[]; category: string[] }
  }
  totals: Totals
  weekly: Weekly[]
  category_mix: MonthlyMix[]
  leaderboard: LeaderboardRow[]
  heatmap: HeatmapCell[]
}

// ---- Palette tokens (hex; Recharts needs string values) ------------------
const STATUS_FILL: Record<keyof Omit<Weekly, "week_start">, string> = {
  new: "#475569", // slate 600
  in_progress: "#4338CA", // indigo 700
  awaiting_ho: "#0369A1", // sky 700
  returned: "#C2410C", // orange 700
  closed: "#0F766E", // teal 700
  voided: "#94A3B8", // slate 400
}

const STATUS_LABEL: Record<keyof Omit<Weekly, "week_start">, string> = {
  new: "New",
  in_progress: "Acknowledged",
  awaiting_ho: "Awaiting HO",
  returned: "Returned",
  closed: "Closed",
  voided: "Voided",
}

const STATUS_ORDER: readonly (keyof Omit<Weekly, "week_start">)[] = [
  "closed",
  "awaiting_ho",
  "returned",
  "in_progress",
  "new",
  "voided",
]

// ---- Default window: current month + 11 back = 12 months ------------------
function defaultFromISO(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    .toISOString()
    .slice(0, 10)
}
function defaultToISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function AnalyticsClient() {
  const [from, setFrom] = useState(defaultFromISO())
  const [to, setTo] = useState(defaultToISO())
  const [brands, setBrands] = useState<string[]>([])
  const [cities, setCities] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setBusy(true)
      setError(null)
      try {
        const qs = new URLSearchParams()
        qs.set("from", from)
        qs.set("to", to)
        for (const b of brands) qs.append("brand", b)
        for (const c of cities) qs.append("city", c)
        for (const k of categories) qs.append("category", k)

        const res = await fetch(`/api/ho-analytics?${qs.toString()}`, {
          cache: "no-store",
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const body = (await res.json()) as Payload
        if (!cancelled) setData(body)
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Couldn't load analytics.",
          )
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [from, to, brands, cities, categories])

  function toggle(
    key: string,
    list: string[],
    setList: (v: string[]) => void,
  ) {
    setList(list.includes(key) ? list.filter((x) => x !== key) : [...list, key])
  }

  function reset() {
    setFrom(defaultFromISO())
    setTo(defaultToISO())
    setBrands([])
    setCities([])
    setCategories([])
  }

  async function downloadXlsx() {
    if (downloading) return
    setDownloading(true)
    setDownloadError(null)
    try {
      // Mirror the same query-string shape the analytics fetch uses so the
      // spreadsheet reflects exactly what's on screen.
      const qs = new URLSearchParams()
      qs.set("from", from)
      qs.set("to", to)
      for (const b of brands) qs.append("brand", b)
      for (const c of cities) qs.append("city", c)
      for (const k of categories) qs.append("category", k)

      const res = await fetch(`/api/excel/export?${qs.toString()}`, {
        cache: "no-store",
      })
      if (!res.ok) {
        // Try to surface the server's message; fall back to the HTTP status.
        let msg = `HTTP ${res.status}`
        try {
          const j = (await res.json()) as { error?: string }
          if (j?.error) msg = j.error
        } catch {
          /* not json */
        }
        throw new Error(msg)
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `safereport-${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Release the blob URL on the next tick so Safari has a chance to start
      // the download before we revoke.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setDownloadError(
        e instanceof Error ? e.message : "Couldn't download.",
      )
    } finally {
      setDownloading(false)
    }
  }

  const anyFilter = brands.length + cities.length + categories.length > 0

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-end justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Analytics
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Pilot-wide trends. Narrow the view with the filters below.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {busy ? (
            <span className="inline-flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            onClick={downloadXlsx}
            disabled={downloading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-indigo-700 text-white text-sm font-medium hover:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {downloading ? "Preparing…" : "Download .xlsx"}
          </button>
        </div>
      </div>
      {downloadError ? (
        <div
          role="alert"
          className="rounded-md bg-orange-50 border border-orange-200 px-3 py-2 text-sm text-orange-700 mb-4"
        >
          Download failed: {downloadError}
        </div>
      ) : null}

      {/* ---- Filter panel ---- */}
      <section
        aria-label="Filters"
        className="bg-white rounded-xl border border-slate-200 p-5 mb-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-slate-500" aria-hidden />
          <h2 className="text-sm font-semibold text-slate-900">Filters</h2>
          {anyFilter ? (
            <button
              type="button"
              onClick={reset}
              className="ml-auto inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Reset
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              From
            </label>
            <DateInput value={from} onChange={setFrom} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              To
            </label>
            <DateInput value={to} onChange={setTo} />
          </div>
          <div className="md:col-span-2">
            <div className="text-xs font-medium text-slate-700 mb-1.5 flex items-center gap-1.5">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden />
              Quick ranges
            </div>
            <div className="flex flex-wrap gap-1.5">
              <QuickRange
                label="Last 7 days"
                days={7}
                onSelect={(f, t) => {
                  setFrom(f)
                  setTo(t)
                }}
              />
              <QuickRange
                label="Last 30 days"
                days={30}
                onSelect={(f, t) => {
                  setFrom(f)
                  setTo(t)
                }}
              />
              <QuickRange
                label="Last 90 days"
                days={90}
                onSelect={(f, t) => {
                  setFrom(f)
                  setTo(t)
                }}
              />
              <QuickRange
                label="Last 12 months"
                days={365}
                onSelect={(f, t) => {
                  setFrom(f)
                  setTo(t)
                }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-5">
          <FilterChips
            title="Brand"
            options={data?.filters.brands ?? []}
            selected={brands}
            onToggle={(k) => toggle(k, brands, setBrands)}
          />
          <FilterChips
            title="City"
            options={data?.filters.cities ?? []}
            selected={cities}
            onToggle={(k) => toggle(k, cities, setCities)}
          />
          <FilterChips
            title="Category"
            options={CATEGORIES.map((c) => ({
              key: c.key,
              label: c.label,
              tone: c.kind,
            }))}
            selected={categories}
            onToggle={(k) => toggle(k, categories, setCategories)}
          />
        </div>
      </section>

      {/* ---- Summary totals ---- */}
      {data ? (
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <Pill label="In range" value={data.totals.reports} tint="indigo" />
          <Pill
            label="Awaiting HO"
            value={data.totals.awaiting_ho}
            tint="sky"
          />
          <Pill label="Closed" value={data.totals.closed} tint="teal" />
          <Pill label="Returned" value={data.totals.returned} tint="orange" />
          <Pill label="Voided" value={data.totals.voided} tint="slate" />
        </section>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md bg-orange-50 border border-orange-200 px-3 py-2 text-sm text-orange-700 mb-4"
        >
          {error}
        </div>
      ) : null}

      {/* ---- Charts grid ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard
          title="Reports per week, stacked by status"
          subtitle="Each bar is a Monday-starting week."
          icon={TrendingUp}
        >
          <WeeklyStackedArea weekly={data?.weekly ?? []} />
        </ChartCard>

        <ChartCard
          title="Category mix by month"
          subtitle="Observations bottom, incidents on top."
        >
          <CategoryMixBars months={data?.category_mix ?? []} />
        </ChartCard>

        <ChartCard
          title="Store leaderboard"
          subtitle="Top 20 by report volume. First-attempt rate = share of closed reports resolved on attempt 1."
          fullWidth
        >
          <StoreLeaderboard rows={data?.leaderboard ?? []} />
        </ChartCard>

        <ChartCard
          title="Category heatmap"
          subtitle="Category × month density."
          fullWidth
        >
          <DenseHeatmap cells={data?.heatmap ?? []} />
        </ChartCard>
      </div>
    </div>
  )
}

/* ------------------------------ Sub-widgets ------------------------------ */

function DateInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
    />
  )
}

function QuickRange({
  label,
  days,
  onSelect,
}: {
  label: string
  days: number
  onSelect: (from: string, to: string) => void
}) {
  function apply() {
    const to = new Date()
    const from = new Date(to)
    from.setUTCDate(to.getUTCDate() - days)
    onSelect(
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10),
    )
  }
  return (
    <button
      type="button"
      onClick={apply}
      className="px-2.5 py-1 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-xs text-slate-700 transition-colors"
    >
      {label}
    </button>
  )
}

type ChipOption = string | { key: string; label: string; tone?: string }

function FilterChips({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string
  options: ChipOption[]
  selected: string[]
  onToggle: (key: string) => void
}) {
  const normalised = options.map((o) =>
    typeof o === "string" ? { key: o, label: o, tone: undefined } : o,
  )
  return (
    <div>
      <p className="text-xs font-medium text-slate-700 mb-1.5">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {normalised.length === 0 ? (
          <span className="text-xs text-slate-400">None available</span>
        ) : (
          normalised.map((opt) => {
            const active = selected.includes(opt.key)
            const incident = opt.tone === "incident"
            const base = incident
              ? active
                ? "bg-amber-700 text-white border-amber-700"
                : "bg-white text-amber-900 border-amber-200 hover:bg-amber-50"
              : active
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            return (
              <button
                type="button"
                key={opt.key}
                aria-pressed={active}
                onClick={() => onToggle(opt.key)}
                className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${base}`}
              >
                {opt.label}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function Pill({
  label,
  value,
  tint,
}: {
  label: string
  value: number
  tint: "indigo" | "sky" | "teal" | "orange" | "slate"
}) {
  const map = {
    indigo: "bg-indigo-100 text-indigo-900 ring-indigo-100",
    sky: "bg-sky-100 text-sky-700 ring-sky-100",
    teal: "bg-teal-100 text-teal-700 ring-teal-100",
    orange: "bg-orange-100 text-orange-700 ring-orange-100",
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
  }[tint]
  return (
    <div className={`rounded-lg ring-1 px-3 py-2 ${map}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
  icon: Icon,
  fullWidth,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  icon?: LucideIcon
  fullWidth?: boolean
}) {
  return (
    <section
      className={`bg-white rounded-xl border border-slate-200 overflow-hidden ${
        fullWidth ? "lg:col-span-2" : ""
      }`}
    >
      <header className="px-5 py-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          {Icon ? (
            <Icon className="h-4 w-4 text-slate-500" aria-hidden />
          ) : null}
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        </div>
        {subtitle ? (
          <p className="text-xs text-slate-500 mt-1">{subtitle}</p>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/* ------------------------------ Weekly area ------------------------------ */

function WeeklyStackedArea({ weekly }: { weekly: Weekly[] }) {
  const tickFmt = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
  }
  if (weekly.length === 0) {
    return <EmptyState label="No reports in range." />
  }
  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={weekly}
          margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
          <XAxis
            dataKey="week_start"
            tickFormatter={tickFmt}
            fontSize={11}
            stroke="#94A3B8"
          />
          <YAxis
            allowDecimals={false}
            fontSize={11}
            stroke="#94A3B8"
            width={28}
          />
          <Tooltip
            labelFormatter={(v) =>
              new Date(v as string).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            }
            contentStyle={{
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid #E2E8F0",
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value) =>
              STATUS_LABEL[value as keyof typeof STATUS_LABEL] ?? value
            }
          />
          {STATUS_ORDER.map((s) => (
            <Area
              key={s}
              type="monotone"
              dataKey={s}
              stackId="1"
              stroke={STATUS_FILL[s]}
              fill={STATUS_FILL[s]}
              fillOpacity={0.7}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ---------------------------- Category mix bars -------------------------- */

function CategoryMixBars({ months }: { months: MonthlyMix[] }) {
  const tickFmt = (iso: string) => {
    const d = new Date(iso as string)
    return d.toLocaleDateString("en-IN", { month: "short" })
  }
  if (months.length === 0) {
    return <EmptyState label="No reports in range." />
  }
  // Observations bottom (slate), incidents on top (amber family).
  const stackOrder = [
    { key: "near_miss", fill: "#475569", label: "Near Miss" },
    { key: "unsafe_act", fill: "#64748B", label: "Unsafe Act" },
    { key: "unsafe_condition", fill: "#94A3B8", label: "Unsafe Condition" },
    { key: "first_aid_case", fill: "#FEF3C7", label: "First Aid" },
    { key: "medical_treatment_case", fill: "#F59E0B", label: "Medical" },
    { key: "restricted_work_case", fill: "#D97706", label: "Restricted Work" },
    { key: "lost_time_injury", fill: "#B45309", label: "Lost Time" },
    { key: "fatality", fill: "#7C2D12", label: "Fatality" },
  ]
  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={months}
          margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
          <XAxis
            dataKey="month"
            tickFormatter={tickFmt}
            fontSize={11}
            stroke="#94A3B8"
          />
          <YAxis
            allowDecimals={false}
            fontSize={11}
            stroke="#94A3B8"
            width={28}
          />
          <Tooltip
            labelFormatter={(v) =>
              new Date(v as string).toLocaleDateString("en-IN", {
                month: "long",
                year: "numeric",
              })
            }
            contentStyle={{
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid #E2E8F0",
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {stackOrder.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="a"
              fill={s.fill}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ----------------------------- Leaderboard ------------------------------- */

function StoreLeaderboard({ rows }: { rows: LeaderboardRow[] }) {
  if (rows.length === 0) {
    return <EmptyState label="No stores in range." />
  }
  const withVolume = rows.filter((r) => r.total > 0)
  const maxTotal = withVolume.reduce(
    (m, r) => (r.total > m ? r.total : m),
    0,
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-500">
            <th className="text-left px-2 py-2 font-medium">Store</th>
            <th className="text-left px-2 py-2 font-medium">Brand</th>
            <th className="text-left px-2 py-2 font-medium">City</th>
            <th className="text-right px-2 py-2 font-medium">Volume</th>
            <th className="text-right px-2 py-2 font-medium">
              First-attempt rate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const volPct =
              maxTotal === 0 ? 0 : Math.round((r.total / maxTotal) * 100)
            const firstPct = Math.round(r.first_attempt_rate * 100)
            return (
              <tr key={r.sap_code} className="border-t border-slate-100">
                <td className="px-2 py-2">
                  <div className="text-slate-900 font-medium">{r.name}</div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    {r.sap_code}
                  </div>
                </td>
                <td className="px-2 py-2 text-slate-700">{r.brand}</td>
                <td className="px-2 py-2 text-slate-700">{r.city}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-slate-900">{r.total}</span>
                    <span className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <span
                        className="block h-full bg-indigo-500"
                        style={{ width: `${volPct}%` }}
                      />
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {r.total === 0 ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-slate-900">{firstPct}%</span>
                      <span className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <span
                          className="block h-full bg-teal-500"
                          style={{ width: `${firstPct}%` }}
                        />
                      </span>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ----------------------------- Dense heatmap ----------------------------- */

function DenseHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const months = useMemo(
    () => Array.from(new Set(cells.map((c) => c.month))).sort(),
    [cells],
  )
  const byCategory = useMemo(() => {
    const m = new Map<string, HeatmapCell[]>()
    for (const c of cells) {
      const arr = m.get(c.category) ?? []
      arr.push(c)
      m.set(c.category, arr)
    }
    return m
  }, [cells])
  const max = cells.reduce((m, c) => (c.count > m ? c.count : m), 0)

  if (cells.length === 0) {
    return <EmptyState label="No data in range." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead>
          <tr>
            <th className="text-left text-[11px] font-medium text-slate-500 uppercase tracking-wide px-2 py-2">
              Category
            </th>
            {months.map((m) => (
              <th
                key={m}
                scope="col"
                className="text-center text-[11px] font-medium text-slate-500 uppercase tracking-wide px-1 py-2"
              >
                {new Date(m).toLocaleDateString("en-IN", { month: "short" })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((cat) => {
            const row = (byCategory.get(cat.key) ?? []).sort((a, b) =>
              a.month.localeCompare(b.month),
            )
            const isIncident = cat.kind === "incident"
            return (
              <tr key={cat.key} className="border-t border-slate-100">
                <td className="px-2 py-1.5 whitespace-nowrap">
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
  let bucket = 0
  if (count > 0 && max > 0) {
    const ratio = Math.sqrt(count) / Math.sqrt(max)
    bucket = Math.max(1, Math.min(5, Math.ceil(ratio * 5)))
  }
  const paletteAmber = [
    "bg-slate-50",
    "bg-amber-100",
    "bg-amber-500",
    "bg-amber-700",
    "bg-amber-700",
    "bg-amber-700",
  ]
  const paletteSlate = [
    "bg-slate-50",
    "bg-slate-200",
    "bg-slate-400",
    "bg-slate-600",
    "bg-slate-700",
    "bg-slate-900",
  ]
  const palette = isIncident ? paletteAmber : paletteSlate
  const textInverted = bucket >= 3
  return (
    <td className="px-1 py-1 align-middle">
      <div
        title={`${categoryLabel} · ${new Date(month).toLocaleDateString(
          "en-IN",
          { month: "short", year: "numeric" },
        )} · ${count}`}
        className={`mx-auto h-6 w-8 rounded flex items-center justify-center text-[11px] tabular-nums ${
          palette[bucket]
        } ${textInverted ? "text-white" : "text-slate-700"}`}
      >
        {count > 0 ? count : ""}
      </div>
    </td>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="h-[240px] flex items-center justify-center text-sm text-slate-400">
      {label}
    </div>
  )
}

// Recharts' built-in Cell import is required to avoid tree-shake drop; reference it:
void Cell
