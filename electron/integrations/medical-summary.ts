/**
 * Medical records summary (Phase 10.9 — "Metriport → medical records"). A pure aggregator
 * over the dedicated `medical_records` table (Metriport FHIR), mirroring `buildHealthSummary`.
 *
 * This IPC-facing summary powers the Medical card on the Health page, so it includes the
 * clinical LISTS (condition/medication/immunization/allergy names) — the user's own data in
 * their own app. The AI/MCP boundary is enforced SEPARATELY by `compass_medical_summary`,
 * which returns only COUNTS + dates, never a diagnosis or medication name. Pure + SQLite-
 * only (injectable `todayMs`) so it unit-tests against a real DB.
 */

import type { SqliteForFx } from './finance-fx'

type Row = {
  category: string
  description: string | null
  status: string | null
  recordedAt: string | null
}

export type MedicalItem = { description: string; status: string | null; date: string | null }

export type MedicalSummary = {
  today: string
  hasData: boolean
  count: number
  firstDate: string | null
  lastDate: string | null
  byCategory: Record<string, number>
  activeConditions: number
  conditions: MedicalItem[]
  medications: MedicalItem[]
  immunizations: MedicalItem[]
  allergies: MedicalItem[]
}

function localDay(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Most-recent first (undated rows last); cap so a huge history doesn't bloat the IPC payload.
function sortCap(items: MedicalItem[], cap = 50): MedicalItem[] {
  return [...items].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, cap)
}

export function buildMedicalSummary(
  sqlite: SqliteForFx,
  todayMs: number = Date.now()
): MedicalSummary {
  let rows: Row[] = []
  try {
    rows = sqlite
      .prepare(
        'SELECT category, description, status, recorded_at AS recordedAt FROM medical_records'
      )
      .all() as Row[]
  } catch {
    rows = [] // table absent on older installs → empty summary
  }

  const byCategory: Record<string, number> = {}
  const dates: string[] = []
  const conditions: MedicalItem[] = []
  const medications: MedicalItem[] = []
  const immunizations: MedicalItem[] = []
  const allergies: MedicalItem[] = []
  let activeConditions = 0

  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
    if (r.recordedAt) dates.push(r.recordedAt)
    const item: MedicalItem = {
      description: r.description ?? '(unspecified)',
      status: r.status,
      date: r.recordedAt
    }
    const isActive = (r.status ?? '').toLowerCase() === 'active'
    if (r.category === 'condition') {
      conditions.push(item)
      if (isActive) activeConditions++
    } else if (r.category === 'medication') {
      medications.push(item)
    } else if (r.category === 'immunization') {
      immunizations.push(item)
    } else if (r.category === 'allergy') {
      allergies.push(item)
    }
  }
  dates.sort()

  return {
    today: localDay(todayMs),
    hasData: rows.length > 0,
    count: rows.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.length ? dates[dates.length - 1] : null,
    byCategory,
    activeConditions,
    conditions: sortCap(conditions),
    medications: sortCap(medications),
    immunizations: sortCap(immunizations),
    allergies: sortCap(allergies)
  }
}
