/**
 * Local-calendar `YYYY-MM-DD` key. Built from local Y/M/D — never
 * `toISOString()` (which is UTC and shifts the day boundary ±1 for users
 * outside UTC). Checklist `list_date` is a date-only column representing the
 * user's local day, so writes must use this, matching the renderer's
 * `isoDate` in `src/lib/utils.ts` and the MCP `localYmd`.
 */
export function localYmd(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
