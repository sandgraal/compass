/**
 * Day-grouping + rollup collapse for the Timeline list (Timeline 2.0, PR 4).
 * Pure: newest-first records in → day groups out, with same-day bursts of one
 * (source, kind) collapsed into digest entries ("312 Listened · Amazon
 * Music") so a 300-track day reads as one line, not a wall.
 */

export type RollupGroup = {
  key: string
  source: string
  type: string
  rows: TimelineRecord[]
}

export type TimelineDayGroup = {
  day: string
  singles: TimelineRecord[]
  rollups: RollupGroup[]
}

/** Same-day (source, kind) groups at or above this size collapse into a digest. */
export const ROLLUP_THRESHOLD = 6

export function fmtDayLabel(ms: number | null): string {
  if (ms == null) return 'Undated'
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export function groupRecordsForDisplay(records: TimelineRecord[]): TimelineDayGroup[] {
  const days: TimelineDayGroup[] = []
  let current: { day: string; rows: TimelineRecord[] } | null = null
  const flush = (): void => {
    if (!current) return
    const bySourceType = new Map<string, TimelineRecord[]>()
    for (const r of current.rows) {
      const key = `${r.source}|${r.type}`
      const list = bySourceType.get(key)
      if (list) list.push(r)
      else bySourceType.set(key, [r])
    }
    const group: TimelineDayGroup = { day: current.day, singles: [], rollups: [] }
    for (const [key, rows] of bySourceType) {
      if (rows.length >= ROLLUP_THRESHOLD) {
        group.rollups.push({ key, source: rows[0].source, type: rows[0].type, rows })
      } else {
        group.singles.push(...rows)
      }
    }
    // Singles keep timeline order; digests (usually noise) sit below them,
    // biggest burst first.
    group.singles.sort(
      (a, b) =>
        (b.occurredAt ?? Number.NEGATIVE_INFINITY) - (a.occurredAt ?? Number.NEGATIVE_INFINITY)
    )
    group.rollups.sort((a, b) => b.rows.length - a.rows.length)
    days.push(group)
    current = null
  }
  // Records arrive newest-first, so consecutive same-day rows bucket cleanly.
  for (const r of records) {
    const day = fmtDayLabel(r.occurredAt)
    if (!current || current.day !== day) {
      flush()
      current = { day, rows: [r] }
    } else {
      current.rows.push(r)
    }
  }
  flush()
  return days
}
