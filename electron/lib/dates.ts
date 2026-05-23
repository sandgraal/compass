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
