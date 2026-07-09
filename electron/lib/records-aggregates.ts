/**
 * Timeline aggregates (Timeline 2.0, PR 3) — the pure query layer behind the
 * year scrubber, density heatmap, day drill-down, day rollups, and the
 * all-years "On this day" hero.
 *
 * Raw SQL over better-sqlite3 (mirrors records-search.ts): the strftime
 * expressions here must TEXTUALLY match the expression indexes created by
 * migration 0033 (`idx_records_mmdd`, `idx_records_year`) — a drifted
 * expression silently degrades to a full-table scan, which is why the
 * records-repair tests assert EXPLAIN QUERY PLAN on these exact shapes.
 *
 * DAY CONVENTION: all bucketing is UTC (strftime 'unixepoch'), matching the
 * v1 on-this-day handler. Date-only imports (Netflix, orders …) are stored at
 * UTC midnight, so UTC bucketing keeps them on the calendar day the export
 * wrote; bucketing in local time would shift them a day west of UTC.
 */

import type Database from 'better-sqlite3'
import { FIREHOSE_SOURCE_LIST } from './source-tiers'

export type TimelineRecordRow = {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
  payload: string | null
  provenance: string | null
  ingestedAt: number | null
}

const RECORD_COLS =
  'id, source, type, occurred_at AS occurredAt, title, body, payload, provenance, ingested_at AS ingestedAt'

const MMDD_EXPR = "strftime('%m-%d', occurred_at / 1000, 'unixepoch')"
const YEAR_EXPR = "CAST(strftime('%Y', occurred_at / 1000, 'unixepoch') AS INTEGER)"
const MONTH_EXPR = "strftime('%Y-%m', occurred_at / 1000, 'unixepoch')"

type Filter = {
  source?: string
  type?: string
  from?: number
  to?: number
  includeFirehose?: boolean
}

/**
 * Shared WHERE builder. Firehose sources are excluded unless the caller either
 * asked for them or narrowed to an explicit source (a chip selection always
 * wins — same contract as records:list).
 */
function filterSql(f: Filter): { where: string; params: Record<string, unknown> } {
  const conds: string[] = ['occurred_at IS NOT NULL']
  const params: Record<string, unknown> = {}
  if (f.source) {
    conds.push('source = @source')
    params.source = f.source
  } else if (f.includeFirehose !== true && FIREHOSE_SOURCE_LIST.length > 0) {
    conds.push(`source NOT IN (${FIREHOSE_SOURCE_LIST.map((_, i) => `@firehose${i}`).join(', ')})`)
    FIREHOSE_SOURCE_LIST.forEach((s, i) => {
      params[`firehose${i}`] = s
    })
  }
  if (f.type) {
    conds.push('type = @type')
    params.type = f.type
  }
  if (f.from != null) {
    conds.push('occurred_at >= @from')
    params.from = f.from
  }
  if (f.to != null) {
    conds.push('occurred_at <= @to')
    params.to = f.to
  }
  return { where: conds.join(' AND '), params }
}

export type HistogramBucket = { bucket: string; count: number }

/**
 * Per-year ('2024') or per-month ('2024-05') record counts, filterable — the
 * year scrubber / density strip / heatmap feed. Undated records are excluded
 * (they have no bucket).
 */
export function recordsHistogram(
  sqlite: Database.Database,
  opts: Filter & { bucket: 'year' | 'month' }
): HistogramBucket[] {
  const expr = opts.bucket === 'year' ? YEAR_EXPR : MONTH_EXPR
  const { where, params } = filterSql(opts)
  const rows = sqlite
    .prepare(
      `SELECT ${expr} AS bucket, COUNT(*) AS count FROM records WHERE ${where} GROUP BY 1 ORDER BY 1`
    )
    .all(params) as Array<{ bucket: number | string; count: number }>
  return rows.map((r) => ({ bucket: String(r.bucket), count: r.count }))
}

/** UTC day bounds [startMs, endMs) for a 'YYYY-MM-DD' key, or null if malformed. */
export function utcDayBounds(day: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(start)) return null
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

/** Every record on one UTC day, newest first — the drill-down list. */
export function recordsForDay(
  sqlite: Database.Database,
  opts: Filter & { day: string; limit?: number; offset?: number }
): TimelineRecordRow[] {
  const bounds = utcDayBounds(opts.day)
  if (!bounds) return []
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 2000)
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
  const { where, params } = filterSql({ ...opts, from: bounds.start, to: bounds.end - 1 })
  return sqlite
    .prepare(
      `SELECT ${RECORD_COLS} FROM records WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as TimelineRecordRow[]
}

export type DaySummaryGroup = {
  source: string
  type: string
  count: number
  /** Up to 3 newest titles — the rollup's preview line. */
  sampleTitles: string[]
}

/**
 * Per-(source, type) rollup for one UTC day, biggest group first — powers the
 * "Listened to 312 tracks" digest rows. Firehose groups are INCLUDED here
 * (the rollup is exactly how collapsed noise should surface: one line).
 */
export function daySummary(sqlite: Database.Database, opts: { day: string }): DaySummaryGroup[] {
  const bounds = utcDayBounds(opts.day)
  if (!bounds) return []
  // One pass: window functions rank each group's newest 3 titles and carry the
  // group count alongside — no N+1 per-(source, type) sample query on busy days.
  const rows = sqlite
    .prepare(
      `SELECT source, type, title, count FROM (
         SELECT source, type, title,
                ROW_NUMBER() OVER (PARTITION BY source, type ORDER BY occurred_at DESC, id DESC) AS rn,
                COUNT(*) OVER (PARTITION BY source, type) AS count
           FROM records WHERE occurred_at >= @from AND occurred_at <= @to
       ) WHERE rn <= 3
       ORDER BY count DESC, source, rn`
    )
    .all({ from: bounds.start, to: bounds.end - 1 }) as Array<{
    source: string
    type: string
    title: string
    count: number
  }>
  const groups: DaySummaryGroup[] = []
  const byKey = new Map<string, DaySummaryGroup>()
  for (const row of rows) {
    const key = `${row.source}|${row.type}`
    let group = byKey.get(key)
    if (!group) {
      group = { source: row.source, type: row.type, count: row.count, sampleTitles: [] }
      byKey.set(key, group)
      groups.push(group) // rows arrive count DESC, source ASC — group order preserved
    }
    group.sampleTitles.push(row.title)
  }
  return groups
}

export type OnThisDayYear = {
  year: number
  /** Total matching records that year (may exceed records.length). */
  count: number
  records: TimelineRecordRow[]
}

/**
 * "On this day" across EVERY year in the archive: all records whose UTC
 * month-day matches, grouped by year (newest year first), capped per year.
 * Firehose sources are excluded — telemetry is not a memory. Served by
 * idx_records_mmdd (index seek, not a table scan).
 */
export function onThisDayAllYears(
  sqlite: Database.Database,
  opts: {
    month: number // 1-12
    day: number // 1-31
    perYearCap?: number
    excludeYear?: number // usually the current year (today isn't a memory yet)
  }
): OnThisDayYear[] {
  if (!Number.isInteger(opts.month) || opts.month < 1 || opts.month > 12) return []
  if (!Number.isInteger(opts.day) || opts.day < 1 || opts.day > 31) return []
  const cap = Math.min(Math.max(Math.trunc(opts.perYearCap ?? 6), 1), 50)
  const mmdd = `${String(opts.month).padStart(2, '0')}-${String(opts.day).padStart(2, '0')}`
  const params: Record<string, unknown> = { mmdd }
  let firehose = ''
  if (FIREHOSE_SOURCE_LIST.length > 0) {
    firehose = ` AND source NOT IN (${FIREHOSE_SOURCE_LIST.map((_, i) => `@firehose${i}`).join(', ')})`
    FIREHOSE_SOURCE_LIST.forEach((s, i) => {
      params[`firehose${i}`] = s
    })
  }
  // Cap rows PER YEAR in SQL (window functions) while carrying each year's
  // TRUE total in the same pass — output is bounded by cap × years with no
  // arbitrary global row limit, so counts stay exact on any archive size.
  params.cap = cap
  const rows = sqlite
    .prepare(
      `SELECT * FROM (
         SELECT ${RECORD_COLS}, ${YEAR_EXPR} AS year,
                ROW_NUMBER() OVER (PARTITION BY ${YEAR_EXPR} ORDER BY occurred_at DESC, id DESC) AS rn,
                COUNT(*) OVER (PARTITION BY ${YEAR_EXPR}) AS yearCount
           FROM records WHERE ${MMDD_EXPR} = @mmdd${firehose}
       ) WHERE rn <= @cap
       ORDER BY year DESC, rn`
    )
    .all(params) as Array<TimelineRecordRow & { year: number; rn: number; yearCount: number }>
  const groups: OnThisDayYear[] = []
  const byYear = new Map<number, OnThisDayYear>()
  for (const row of rows) {
    if (opts.excludeYear != null && row.year === opts.excludeYear) continue
    let group = byYear.get(row.year)
    if (!group) {
      group = { year: row.year, count: row.yearCount, records: [] }
      byYear.set(row.year, group)
      groups.push(group) // rows arrive year DESC — group order preserved
    }
    const { year: _year, rn: _rn, yearCount: _yearCount, ...record } = row
    group.records.push(record)
  }
  return groups
}
