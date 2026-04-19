"use client"

import { useMemo, useRef, useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Upload,
  Pencil,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  Store as StoreIcon,
  Loader2,
  X,
} from "lucide-react"

/**
 * HO stores registry — client surface.
 *
 * Renders a searchable/filterable table of the full store roster plus:
 *   - An inline "Edit store" modal (PATCH /api/ho-stores)
 *   - A CSV import flow (POST multipart /api/excel/stores)
 *
 * We surface two "warning flags" per row to catch common pilot footguns:
 *   - `has_pin === false` → manager cannot log in
 *   - `status !== 'active'` → store won't show in most dashboards
 *
 * All PII handling stays server-side; this view never sees the pin hash.
 */

export type StoreStatus = "active" | "temporarily_closed" | "permanently_closed"

export type StoreRow = {
  sap_code: string
  name: string
  brand: string
  city: string
  state: string
  location: string | null
  manager_name: string | null
  manager_phone: string | null
  has_pin: boolean
  status: StoreStatus
  opening_date: string | null
  report_count: number
}

export function StoresClient({ rows }: { rows: StoreRow[] }) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [brandFilter, setBrandFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"all" | StoreStatus>("all")
  const [editing, setEditing] = useState<StoreRow | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  )

  // Unique brand list for the chips.
  const brands = useMemo(
    () => Array.from(new Set(rows.map((r) => r.brand))).sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (brandFilter && r.brand !== brandFilter) return false
      if (statusFilter !== "all" && r.status !== statusFilter) return false
      if (!q) return true
      return (
        r.sap_code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.city.toLowerCase().includes(q) ||
        r.state.toLowerCase().includes(q) ||
        (r.manager_name ?? "").toLowerCase().includes(q) ||
        (r.manager_phone ?? "").toLowerCase().includes(q)
      )
    })
  }, [rows, query, brandFilter, statusFilter])

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  function onSaved(ok: boolean, msg: string) {
    setEditing(null)
    setToast({ kind: ok ? "ok" : "err", msg })
    if (ok) router.refresh()
  }

  function onImported(ok: boolean, msg: string) {
    setImportOpen(false)
    setToast({ kind: ok ? "ok" : "err", msg })
    if (ok) router.refresh()
  }

  const totals = useMemo(() => {
    let active = 0
    let missingPin = 0
    for (const r of rows) {
      if (r.status === "active") active += 1
      if (!r.has_pin) missingPin += 1
    }
    return { total: rows.length, active, missingPin }
  }, [rows])

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Store registry
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {totals.total} stores · {totals.active} active ·{" "}
            {totals.missingPin === 0 ? (
              <span className="text-teal-700">all have manager PINs</span>
            ) : (
              <span className="text-orange-700">
                {totals.missingPin} missing PIN
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
          >
            <Upload className="h-4 w-4" />
            Import CSV
          </button>
        </div>
      </header>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SAP code, store name, city, manager…"
              className="w-full h-9 pl-9 pr-3 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 mr-1">Status:</span>
            {(["all", "active", "temporarily_closed", "permanently_closed"] as const).map(
              (s) => (
                <FilterChip
                  key={s}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === "all" ? "All" : humanStatus(s)}
                </FilterChip>
              ),
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-3">
          <span className="text-xs text-slate-500 mr-1">Brand:</span>
          <FilterChip
            active={brandFilter === null}
            onClick={() => setBrandFilter(null)}
          >
            All
          </FilterChip>
          {brands.map((b) => (
            <FilterChip
              key={b}
              active={brandFilter === b}
              onClick={() => setBrandFilter(b)}
            >
              {b}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-semibold px-4 py-2.5">SAP code</th>
              <th className="text-left font-semibold px-4 py-2.5">Store</th>
              <th className="text-left font-semibold px-4 py-2.5">Brand</th>
              <th className="text-left font-semibold px-4 py-2.5">City · State</th>
              <th className="text-left font-semibold px-4 py-2.5">Manager</th>
              <th className="text-left font-semibold px-4 py-2.5">Status</th>
              <th className="text-right font-semibold px-4 py-2.5">Reports</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                  No stores match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.sap_code} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-slate-800">{r.sap_code}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <StoreIcon className="h-4 w-4 text-slate-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="text-slate-900 font-medium">{r.name}</div>
                        {r.location && (
                          <div className="text-xs text-slate-500 mt-0.5">
                            {r.location}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.brand}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {r.city} · {r.state}
                  </td>
                  <td className="px-4 py-3">
                    {r.manager_name ? (
                      <div>
                        <div className="text-slate-800">{r.manager_name}</div>
                        {r.manager_phone && (
                          <div className="text-xs text-slate-500 mt-0.5">
                            {r.manager_phone}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                    {!r.has_pin && (
                      <div className="mt-1 inline-flex items-center gap-1 text-xs text-orange-700">
                        <AlertTriangle className="h-3 w-3" />
                        No PIN set
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                    {r.report_count}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(r)}
                      className="inline-flex items-center gap-1.5 px-2.5 h-8 text-xs text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditStoreModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      {importOpen && (
        <CsvImportModal
          onClose={() => setImportOpen(false)}
          onDone={onImported}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div
            className={`inline-flex items-start gap-2 px-4 py-3 rounded-md shadow-lg border text-sm ${
              toast.kind === "ok"
                ? "bg-teal-50 border-teal-200 text-teal-900"
                : "bg-orange-50 border-orange-200 text-orange-900"
            }`}
          >
            {toast.kind === "ok" ? (
              <CheckCircle2 className="h-4 w-4 text-teal-700 mt-0.5" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-orange-700 mt-0.5" />
            )}
            <span>{toast.msg}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-2 text-slate-500 hover:text-slate-700"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Edit modal ----------

function EditStoreModal({
  row,
  onClose,
  onSaved,
}: {
  row: StoreRow
  onClose: () => void
  onSaved: (ok: boolean, msg: string) => void
}) {
  const [form, setForm] = useState({
    name: row.name,
    brand: row.brand,
    city: row.city,
    state: row.state,
    location: row.location ?? "",
    manager_name: row.manager_name ?? "",
    manager_phone: row.manager_phone ?? "",
    status: row.status,
    new_pin: "",
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    // PIN validation — optional field; if present must be 4 digits.
    if (form.new_pin && !/^\d{4}$/.test(form.new_pin)) {
      setError("PIN must be exactly 4 digits.")
      return
    }
    if (!form.name.trim() || !form.brand.trim() || !form.city.trim() || !form.state.trim()) {
      setError("Name, brand, city, and state are required.")
      return
    }
    setBusy(true)
    try {
      const resp = await fetch("/api/ho-stores", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sap_code: row.sap_code,
          name: form.name.trim(),
          brand: form.brand.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          location: form.location.trim() || null,
          manager_name: form.manager_name.trim() || null,
          manager_phone: form.manager_phone.trim() || null,
          status: form.status,
          new_pin: form.new_pin || null,
        }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        onSaved(false, body.error ?? `Save failed (${resp.status}).`)
        return
      }
      onSaved(true, `${row.sap_code} updated.`)
    } catch (e) {
      onSaved(false, e instanceof Error ? e.message : "Network error.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={`Edit ${row.sap_code}`}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Store name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Brand">
            <input
              type="text"
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="City">
            <input
              type="text"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="State">
            <input
              type="text"
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Location / mall">
          <input
            type="text"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Manager name">
            <input
              type="text"
              value={form.manager_name}
              onChange={(e) => setForm({ ...form, manager_name: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Manager phone">
            <input
              type="tel"
              value={form.manager_phone}
              onChange={(e) => setForm({ ...form, manager_phone: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) =>
              setForm({ ...form, status: e.target.value as StoreStatus })
            }
            className={inputCls}
          >
            <option value="active">Active</option>
            <option value="temporarily_closed">Temporarily closed</option>
            <option value="permanently_closed">Permanently closed</option>
          </select>
        </Field>
        <div className="bg-slate-50 border border-slate-200 rounded-md p-3">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-medium text-slate-700">
              Reset manager PIN
            </span>
          </div>
          <p className="text-xs text-slate-500 mb-2">
            Leave blank to keep the existing PIN. Enter 4 digits to replace it
            — the old PIN will stop working immediately.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={form.new_pin}
            onChange={(e) =>
              setForm({
                ...form,
                new_pin: e.target.value.replace(/\D/g, "").slice(0, 4),
              })
            }
            placeholder="e.g. 4821"
            className={inputCls + " font-mono tracking-widest"}
          />
        </div>
        {error && (
          <div className="text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 h-9 text-sm text-slate-700 hover:bg-slate-50 rounded-md"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 h-9 bg-indigo-700 hover:bg-indigo-800 text-white text-sm rounded-md disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- CSV import ----------

function CsvImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (ok: boolean, msg: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    inserted: number
    updated: number
    skipped: number
    errors: string[]
  } | null>(null)

  async function upload(file: File) {
    setBusy(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const resp = await fetch("/api/excel/stores", {
        method: "POST",
        body: fd,
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        onDone(false, body.error ?? `Import failed (${resp.status}).`)
        return
      }
      setResult({
        inserted: body.inserted ?? 0,
        updated: body.updated ?? 0,
        skipped: body.skipped ?? 0,
        errors: body.errors ?? [],
      })
    } catch (e) {
      onDone(false, e instanceof Error ? e.message : "Network error.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title="Import stores from CSV">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs text-slate-600 leading-relaxed">
          <div className="font-medium text-slate-800 mb-1">Expected columns</div>
          <code className="block font-mono text-[11px] text-slate-700">
            sap_code,name,brand,city,state,location,manager_name,manager_phone,pin,status
          </code>
          <p className="mt-2">
            <strong>sap_code</strong> is the key — rows upsert by it.{" "}
            <strong>pin</strong> (4 digits, plain) gets hashed server-side before
            storage.{" "}
            <strong>status</strong> must be <code>active</code>,{" "}
            <code>temporarily_closed</code>, or <code>permanently_closed</code>.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) upload(f)
          }}
          className="hidden"
        />
        {!result && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="w-full h-28 border-2 border-dashed border-slate-300 rounded-md text-slate-600 hover:bg-slate-50 flex flex-col items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-indigo-700" />
                <span className="text-sm">Processing…</span>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5" />
                <span className="text-sm">Click to choose CSV</span>
              </>
            )}
          </button>
        )}
        {result && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <ResultPill label="Inserted" value={result.inserted} tone="teal" />
              <ResultPill label="Updated" value={result.updated} tone="indigo" />
              <ResultPill label="Skipped" value={result.skipped} tone="slate" />
            </div>
            {result.errors.length > 0 && (
              <div className="bg-orange-50 border border-orange-200 rounded-md p-3">
                <div className="text-sm font-medium text-orange-900 mb-1">
                  {result.errors.length} row{result.errors.length === 1 ? "" : "s"}{" "}
                  skipped
                </div>
                <ul className="text-xs text-orange-800 space-y-0.5 list-disc pl-4 max-h-32 overflow-auto">
                  {result.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          {result ? (
            <button
              type="button"
              onClick={() =>
                onDone(true, `${result.inserted + result.updated} stores imported.`)
              }
              className="px-4 h-9 bg-indigo-700 hover:bg-indigo-800 text-white text-sm rounded-md"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 h-9 text-sm text-slate-700 hover:bg-slate-50 rounded-md"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---------- small shared pieces ----------

const inputCls =
  "w-full h-9 px-3 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"

function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[calc(100vh-2rem)] overflow-auto"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-2.5 h-7 text-xs rounded-full border transition-colors " +
        (active
          ? "bg-indigo-700 border-indigo-700 text-white"
          : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50")
      }
    >
      {children}
    </button>
  )
}

function StatusPill({ status }: { status: StoreStatus }) {
  const cfg = {
    active: {
      label: "Active",
      cls: "bg-teal-50 text-teal-800 border-teal-200",
    },
    temporarily_closed: {
      label: "Temp. closed",
      cls: "bg-orange-50 text-orange-800 border-orange-200",
    },
    permanently_closed: {
      label: "Closed",
      cls: "bg-slate-100 text-slate-600 border-slate-200",
    },
  }[status]
  return (
    <span
      className={`inline-flex items-center px-2 h-6 text-xs rounded-md border ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  )
}

function ResultPill({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "teal" | "indigo" | "slate"
}) {
  const cls = {
    teal: "bg-teal-50 border-teal-200 text-teal-900",
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-900",
    slate: "bg-slate-50 border-slate-200 text-slate-700",
  }[tone]
  return (
    <div className={`border rounded-md px-3 py-2 ${cls}`}>
      <div className="text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function humanStatus(s: StoreStatus): string {
  switch (s) {
    case "active":
      return "Active"
    case "temporarily_closed":
      return "Temp. closed"
    case "permanently_closed":
      return "Closed"
  }
}
