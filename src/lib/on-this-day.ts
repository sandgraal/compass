/**
 * "On this day" grouping — Phase 10.7 "Connect" (cont).
 *
 * Pure presentation logic for the Dashboard memory card: take the prior-year
 * records the `records:on-this-day` IPC returns (already month/day-matched in UTC)
 * and bucket them by year, most-recent-past first, with a "N years ago" label.
 * UTC throughout to match how the timeline stores + renders date-only imports.
 */

export interface OnThisDayGroup {
  year: number
  yearsAgo: number
  records: TimelineRecord[]
}

/** "1 year ago" / "5 years ago". */
export function yearsAgoLabel(yearsAgo: number): string {
  return yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`
}

/**
 * Bucket on-this-day records by year (descending — the most recent past first).
 * Skips undated records and anything from the current year (defensive; the IPC
 * already excludes this year). Within a year the input order is preserved (the IPC
 * returns newest-first).
 */
export function groupOnThisDay(records: TimelineRecord[], now: Date): OnThisDayGroup[] {
  const thisYear = now.getUTCFullYear()
  const byYear = new Map<number, TimelineRecord[]>()
  for (const r of records) {
    if (r.occurredAt == null) continue
    const year = new Date(r.occurredAt).getUTCFullYear()
    if (year >= thisYear) continue
    const arr = byYear.get(year)
    if (arr) arr.push(r)
    else byYear.set(year, [r])
  }
  return [...byYear.entries()]
    .map(([year, recs]) => ({ year, yearsAgo: thisYear - year, records: recs }))
    .sort((a, b) => b.year - a.year)
}
