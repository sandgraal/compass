/**
 * Medical directory — the DEDUPED "your medications / your conditions" view.
 *
 * `buildMedicalSummary` lists individual records (one item per row); this groups
 * `medical_records` by clinical name so each unique medication/condition appears
 * ONCE, with how many times it shows up (refills / re-diagnoses), its date span,
 * latest status, and coding code. Pure + SQLite-only (injectable) like the summary,
 * and same in-app-only posture — the AI/MCP boundary is enforced separately.
 *
 * NOTE — "your doctors": Metriport deliberately strips provider contacts at ingest
 * (`medical_records` has no provider column), so a providers directory isn't
 * derivable from the data we store. Add it if/when provider fields are captured.
 */

import type { SqliteForFx } from './finance-fx'

type Row = {
  category: string
  description: string | null
  code: string | null
  status: string | null
  recordedAt: string | null
}

export type DirectoryEntry = {
  /** Clinical name (the row's description). */
  name: string
  /** Coding code (RxNorm / ICD-10 / CVX…), when present. */
  code: string | null
  /** How many records carry this name (refills / mentions). */
  count: number
  /** Most recent status seen (by date). */
  status: string | null
  firstDate: string | null
  lastDate: string | null
}

export type MedicalDirectory = {
  hasData: boolean
  medications: DirectoryEntry[]
  conditions: DirectoryEntry[]
  immunizations: DirectoryEntry[]
  allergies: DirectoryEntry[]
  /** Provider data isn't stored (stripped at ingest) — surfaced so the UI can say so. */
  providersAvailable: false
}

/** Group a category's rows by clinical name into a deduped, date-sorted directory. */
function groupByName(rows: Row[]): DirectoryEntry[] {
  const acc = new Map<
    string,
    {
      name: string
      code: string | null
      count: number
      dates: string[]
      latest: { date: string; status: string | null } | null
    }
  >()
  for (const r of rows) {
    const name = (r.description ?? '(unspecified)').trim() || '(unspecified)'
    const key = name.toLowerCase()
    let e = acc.get(key)
    if (!e) {
      e = { name, code: r.code ?? null, count: 0, dates: [], latest: null }
      acc.set(key, e)
    }
    e.count++
    if (!e.code && r.code) e.code = r.code
    if (r.recordedAt) {
      e.dates.push(r.recordedAt)
      // Track the status of the most recent record (undated never wins).
      if (!e.latest || r.recordedAt > e.latest.date) e.latest = { date: r.recordedAt, status: r.status }
    } else if (!e.latest || (e.latest.date === '' && !e.latest.status && r.status)) {
      // If everything is undated, keep a status rather than dropping it.
      e.latest = { date: '', status: r.status }
    }
  }
  return (
    [...acc.values()]
      .map((e) => {
        const sorted = [...e.dates].sort()
        return {
          name: e.name,
          code: e.code,
          count: e.count,
          status: e.latest?.status ?? null,
          firstDate: sorted[0] ?? null,
          lastDate: sorted.length ? sorted[sorted.length - 1] : null
        }
      })
      // Most-seen first, then most-recent, then name — stable, useful ordering.
      .sort(
        (a, b) =>
          b.count - a.count ||
          (b.lastDate ?? '').localeCompare(a.lastDate ?? '') ||
          a.name.localeCompare(b.name)
      )
  )
}

export function buildMedicalDirectory(sqlite: SqliteForFx): MedicalDirectory {
  let rows: Row[] = []
  try {
    rows = sqlite
      .prepare(
        'SELECT category, description, code, status, recorded_at AS recordedAt FROM medical_records'
      )
      .all() as Row[]
  } catch {
    rows = [] // table absent on older installs → empty directory
  }
  const of = (category: string) => rows.filter((r) => r.category === category)
  return {
    hasData: rows.length > 0,
    medications: groupByName(of('medication')),
    conditions: groupByName(of('condition')),
    immunizations: groupByName(of('immunization')),
    allergies: groupByName(of('allergy')),
    providersAvailable: false
  }
}
