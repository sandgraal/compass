/**
 * Local-calendar-day helpers shared across the Compass MCP server.
 *
 * Date-only columns (`checklist_items.list_date`, `finance_transactions.date`,
 * `habit_entries.date`) store the *local* calendar day, matching the app's
 * canonical helpers (`src/lib/habit-streaks.ts`, `finance-snapshot.ts`). Build
 * keys from local Y/M/D — never `toISOString()` (which is UTC and shifts the
 * day boundary / miscounts across DST for non-UTC users).
 */

export const DAY_MS = 86_400_000

export const localYmd = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const localYm = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
