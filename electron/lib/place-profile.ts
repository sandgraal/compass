/**
 * Place profile aggregation (places redesign, 2026-07) — the pure math behind
 * a tracked place's "everywhere this shows up" view. The place analogue of
 * electron/lib/merchant-profile.ts: the `places:*` IPC loads the candidate
 * visit rows once and derives stats, monthly buckets, and cadence here.
 *
 * A VISIT is a records-spine row that one of the four place extractors
 * (`gcal-place` / `uber-place` / `lyft-place` / `travel-place` in
 * electron/lib/entities.ts) resolves to the tracked place's match key. Matching
 * reuses the actual extractor registry — never a re-implementation — so a place
 * promoted from Discovered with N touchpoints shows exactly N visits.
 *
 * Match keys use `normalizeName` (the place-kind key in deriveEntities), NOT
 * `matchKeyForPlace` from merchant-match.ts, whose manual-row fallback is
 * `normalizeMerchant` — merchant-flavored normalization that strips corporate
 * suffixes a place name should keep.
 */

import { ENTITY_EXTRACTORS, type EntityRecordRow } from './entities'
import { type Cadence, detectCadence } from './normalize'
import { normalizeName } from './people'

/** The extractor ids whose output defines a place visit. */
const PLACE_EXTRACTOR_IDS = new Set(['gcal-place', 'uber-place', 'lyft-place', 'travel-place'])

const PLACE_EXTRACTORS = ENTITY_EXTRACTORS.filter((ex) => PLACE_EXTRACTOR_IDS.has(ex.id))

/**
 * The (source, type) record shapes that can carry a visit — derived from the
 * extractor registry itself so the SQL candidate load can never drift from the
 * matching logic.
 */
export const VISIT_SOURCES: ReadonlyArray<{ source: string; type: string }> =
  PLACE_EXTRACTORS.flatMap((ex) =>
    (ex.match.types ?? []).map((type) => ({ source: ex.match.source, type }))
  )

/** One candidate record row (the slim shape the places IPC loads). */
export interface PlaceCandidateRow extends EntityRecordRow {
  id: number
}

/** A matched visit, ready for the profile's recent-visits list. */
export interface PlaceVisit {
  recordId: number
  source: string
  type: string
  title: string
  occurredAt: number | null
}

export interface PlaceVisitStats {
  visitCount: number
  firstVisit: number | null
  lastVisit: number | null
  /** Visits this calendar year to date vs the same Jan-1→month-day span last year. */
  thisYearVisits: number
  lastYearSameSpanVisits: number
  /** % change YTD vs same span last year; null when last year had no visits. */
  trendPct: number | null
  cadence: Cadence | null
  /** Per-source visit counts, most first. */
  bySource: Array<{ source: string; count: number }>
}

export interface PlaceMonthlyBucket {
  month: string // 'YYYY-MM'
  visits: number
}

/**
 * Resolve the visit merge key for an owned `places` row: promoted rows carry
 * it in their `derived:<kind>:<key>` external id; manual rows fall back to
 * normalizing the display name (renaming a manual place changes its visit
 * set — acceptable, documented behavior, same trade as manual merchants).
 */
export function placeMatchKey(externalId: string, name: string): string {
  const m = externalId.match(/^derived:(?:merchant|place):(.+)$/)
  if (m) return m[1]
  return normalizeName(name)
}

/**
 * Run the place extractors over one record and return the normalized place
 * keys it references (usually 0 or 1). Extraction faults are swallowed per
 * record, mirroring deriveEntities.
 */
export function extractPlaceRefs(row: EntityRecordRow): string[] {
  const keys = new Set<string>()
  for (const ex of PLACE_EXTRACTORS) {
    if (ex.match.source !== row.source) continue
    if (ex.match.types && !ex.match.types.includes(row.type)) continue
    let refs: ReturnType<typeof ex.extract>
    try {
      refs = ex.extract(row)
    } catch {
      continue
    }
    for (const ref of refs) {
      if (ref.kind !== 'place') continue
      const key = normalizeName(ref.name)
      if (key) keys.add(key)
    }
  }
  return [...keys]
}

function toVisit(row: PlaceCandidateRow): PlaceVisit {
  return {
    recordId: row.id,
    source: row.source,
    type: row.type,
    title: row.title,
    occurredAt: row.occurredAt
  }
}

/**
 * Match many candidate rows against many tracked-place keys in one pass.
 * Returns key → visits ascending by occurredAt; keys with no visits are
 * absent from the map.
 */
export function indexVisitsByKey(
  rows: PlaceCandidateRow[],
  keys: ReadonlySet<string>
): Map<string, PlaceVisit[]> {
  const map = new Map<string, PlaceVisit[]>()
  for (const row of rows) {
    for (const key of extractPlaceRefs(row)) {
      if (!keys.has(key)) continue
      const list = map.get(key) ?? []
      list.push(toVisit(row))
      map.set(key, list)
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0))
  }
  return map
}

/**
 * Headline visit stats. `now` is injectable for tests; the trend compares
 * calendar-year-to-date against the same Jan-1→month-day span last year so a
 * July check never reads "down 50%" just because last year is complete.
 */
export function computeVisitStats(visits: PlaceVisit[], now = new Date()): PlaceVisitStats {
  const dated = visits.filter((v) => v.occurredAt != null) as Array<
    PlaceVisit & { occurredAt: number }
  >
  const times = dated.map((v) => v.occurredAt).sort((a, b) => a - b)
  const firstVisit = times[0] ?? null
  const lastVisit = times[times.length - 1] ?? null

  const y = now.getFullYear()
  const thisYearStart = new Date(y, 0, 1).getTime()
  const lastYearStart = new Date(y - 1, 0, 1).getTime()
  const lastYearSameSpanEnd = new Date(
    y - 1,
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  ).getTime()
  const thisYearVisits = times.filter((t) => t >= thisYearStart && t <= now.getTime()).length
  const lastYearSameSpanVisits = times.filter(
    (t) => t >= lastYearStart && t <= lastYearSameSpanEnd
  ).length
  const trendPct =
    lastYearSameSpanVisits > 0
      ? Math.round(((thisYearVisits - lastYearSameSpanVisits) / lastYearSameSpanVisits) * 100)
      : null

  const cadence = detectCadence(times.map((t) => new Date(t)))

  const sourceCounts = new Map<string, number>()
  for (const v of visits) {
    sourceCounts.set(v.source, (sourceCounts.get(v.source) ?? 0) + 1)
  }
  const bySource = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))

  return {
    visitCount: visits.length,
    firstVisit,
    lastVisit,
    thisYearVisits,
    lastYearSameSpanVisits,
    trendPct,
    cadence,
    bySource
  }
}

/**
 * Month-bucketed visit counts (local time, matching how the timeline renders
 * dates). Ascending by month; months with no visits are absent (the chart
 * renders gaps honestly).
 */
export function computeVisitMonthly(visits: PlaceVisit[]): PlaceMonthlyBucket[] {
  const byMonth = new Map<string, number>()
  for (const v of visits) {
    if (v.occurredAt == null) continue
    const d = new Date(v.occurredAt)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, visits]) => ({ month, visits }))
}
