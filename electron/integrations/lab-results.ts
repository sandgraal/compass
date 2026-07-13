/**
 * Lab results summary — a pure aggregator over `lab_results` (manually/document-imported
 * quantitative test values), mirroring `buildMedicalDirectory`'s "one entry per name" shape.
 * Groups by `testName` so a repeated test (e.g. Troponin drawn three times in one admission)
 * shows as a single trend line: latest value/flag plus the dated history. Pure + SQLite-only
 * (no Electron) so it unit-tests against a real DB, matching the rest of the health/medical
 * aggregators.
 */

import type { SqliteForFx } from './finance-fx'

type Row = {
  testName: string
  panel: string | null
  value: number | null
  valueText: string | null
  unit: string | null
  refRange: string | null
  flag: string | null
  takenAt: string
  encounterId: string | null
}

export type LabResultPoint = {
  takenAt: string
  value: number | null
  valueText: string | null
  unit: string | null
  refRange: string | null
  flag: string | null
  encounterId: string | null
}

export type LabResultSeries = {
  testName: string
  panel: string | null
  latest: LabResultPoint
  /** Oldest → newest, capped so a long admission's serial draws don't bloat the payload. */
  history: LabResultPoint[]
}

export type LabResultsSummary = {
  hasData: boolean
  count: number
  firstDate: string | null
  lastDate: string | null
  abnormalCount: number
  panels: string[]
  series: LabResultSeries[]
}

function toPoint(r: Row): LabResultPoint {
  return {
    takenAt: r.takenAt,
    value: r.value,
    valueText: r.valueText,
    unit: r.unit,
    refRange: r.refRange,
    flag: r.flag,
    encounterId: r.encounterId
  }
}

export function buildLabResultsSummary(sqlite: SqliteForFx, historyCap = 12): LabResultsSummary {
  let rows: Row[] = []
  try {
    rows = sqlite
      .prepare(
        `SELECT test_name AS testName, panel, value, value_text AS valueText, unit,
                ref_range AS refRange, flag, taken_at AS takenAt, encounter_id AS encounterId
           FROM lab_results`
      )
      .all() as Row[]
  } catch {
    rows = [] // table absent on older installs → empty summary
  }

  const byName = new Map<string, Row[]>()
  const panels = new Set<string>()
  const dates: string[] = []
  let abnormalCount = 0
  for (const r of rows) {
    const testName = r.testName.trim()
    const takenAt = r.takenAt.trim()
    if (!testName || !takenAt) continue
    const key = testName.toLowerCase()
    const group = byName.get(key)
    if (group) group.push(r)
    else byName.set(key, [r])
    const panel = r.panel?.trim()
    if (panel) panels.add(panel)
    dates.push(takenAt)
    if (r.flag && r.flag !== 'normal') abnormalCount++
  }
  dates.sort()

  const series: LabResultSeries[] = [...byName.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    const history = sorted.slice(-historyCap).map(toPoint)
    return {
      testName: sorted[sorted.length - 1].testName,
      panel: sorted[sorted.length - 1].panel,
      latest: history[history.length - 1],
      history
    }
  })
  // Abnormal-latest first (most clinically relevant), then most-recent, then name.
  series.sort((a, b) => {
    const aAbnormal = a.latest.flag && a.latest.flag !== 'normal' ? 1 : 0
    const bAbnormal = b.latest.flag && b.latest.flag !== 'normal' ? 1 : 0
    if (aAbnormal !== bAbnormal) return bAbnormal - aAbnormal
    if (a.latest.takenAt !== b.latest.takenAt)
      return b.latest.takenAt.localeCompare(a.latest.takenAt)
    return a.testName.localeCompare(b.testName)
  })

  return {
    hasData: rows.length > 0,
    count: rows.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.length ? dates[dates.length - 1] : null,
    abnormalCount,
    panels: [...panels].sort(),
    series
  }
}
