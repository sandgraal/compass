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
 * Parse a free-text date/time string to epoch ms, or null. Accepts ISO 8601,
 * 'YYYY-MM-DD HH:mm' (local), 'YYYY/MM/DD', and the M/D/YY(YY) US format that
 * Netflix / Amazon / other exports use. Shared by the Drop Zone recognizers.
 */
export function parseWhen(raw: string | undefined | null): number | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  // Native parse handles ISO 8601, 'YYYY-MM-DD HH:mm' (local), and 'YYYY/MM/DD'.
  const native = Date.parse(s)
  if (!Number.isNaN(native)) return native
  // Fall back to M/D/YY or M/D/YYYY (Netflix etc.).
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    const ms = new Date(year, Number(m[1]) - 1, Number(m[2])).getTime()
    if (!Number.isNaN(ms)) return ms
  }
  return null
}
