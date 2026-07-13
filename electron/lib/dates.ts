/**
 * Local-calendar date keys. Built from local Y/M/D — never `toISOString()`
 * (which is UTC and shifts the day boundary ±1 for users outside UTC).
 *
 * Compass stores its date-only columns (checklist `list_date`,
 * `finance_transactions.date`, habit dates) as the user's LOCAL calendar day
 * with no timezone. Capture already uses local day (see `localDateString` in
 * `finance-snapshot.ts`); these helpers keep query/validation keys aligned so
 * comparisons don't drift around midnight. Matches the renderer's `isoDate` /
 * `isoMonth` in `src/lib/utils.ts`.
 */

/** Local-calendar `YYYY-MM-DD` key. */
export function localYmd(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local-calendar `YYYY-MM` month key. */
export function localYm(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/**
 * Monday (local) of the week containing `date`, as `YYYY-MM-DD` — the
 * canonical week bucket key (same semantics as `weekKey` in
 * `electron/ipc/insights.ts`).
 */
export function localWeekKey(date: Date): string {
  const m = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7)) // back up to Monday
  return localYmd(m)
}

/**
 * The window Compass accepts as a real event time: [1970-01-01, now + 5 years].
 * Export cells that aren't dates at all (IDs, quantities, truncated fragments)
 * otherwise slip through `Date.parse` as years like 104 or 10801 and poison
 * every year-over-year view ("on this day", histograms, the timeline span).
 * The 5-year future allowance covers legitimate forward dates in exports
 * (renewal dates, pre-orders, calendar events).
 */
const MAX_FUTURE_MS = 5 * 365.25 * 24 * 60 * 60 * 1000

/** Largest epoch-ms value accepted as a record timestamp (now + 5 years). */
export function maxPlausibleEpochMs(now: number = Date.now()): number {
  return now + MAX_FUTURE_MS
}

/** Whether an epoch-ms value is a plausible record timestamp (see above). */
export function isPlausibleEpochMs(ms: number, now: number = Date.now()): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= maxPlausibleEpochMs(now)
}

/**
 * Parse a free-text date/time string to epoch ms, or null. Accepts ISO 8601,
 * 'YYYY-MM-DD HH:mm' (local), 'YYYY/MM/DD', and the M/D/YY(YY) US format that
 * Netflix / Amazon / other exports use. Shared by the Drop Zone recognizers.
 *
 * Results outside [1970, now + 5y] return null (see `isPlausibleEpochMs`) —
 * ambiguous cells must become UNDATED records, never absurd-year ones.
 */
export function parseWhen(raw: string | undefined | null, now: number = Date.now()): number | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  // A bare number is an ID / quantity / year cell, not an event time —
  // `Date.parse('104')` happily reads it as the year 104 AD.
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return null
  // Native parse handles ISO 8601, 'YYYY-MM-DD HH:mm' (local), 'YYYY/MM/DD',
  // and the 'Mon, 01 Jan 2024…' shapes mail exports use.
  const native = Date.parse(s)
  if (!Number.isNaN(native)) return isPlausibleEpochMs(native, now) ? native : null
  // Fall back to M/D/YY or M/D/YYYY (Netflix etc.). Two-digit years pivot at
  // 70 ('99 → 1999, '26 → 2026) — the convention those exports follow.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (m) {
    const y = Number(m[3])
    const year = m[3].length === 2 ? (y >= 70 ? 1900 + y : 2000 + y) : y
    const ms = new Date(year, Number(m[1]) - 1, Number(m[2])).getTime()
    if (!Number.isNaN(ms) && isPlausibleEpochMs(ms, now)) return ms
  }
  return null
}
