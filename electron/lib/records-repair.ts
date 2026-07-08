/**
 * One-shot repair for absurd-year `records.occurred_at` values (2026-07).
 *
 * Before `parseWhen` range-checked its results, ambiguous export cells (IDs,
 * quantities, fragments) slipped through `Date.parse` as timestamps in years
 * like 0, 104, or 10801. Those rows poison every year-over-year surface —
 * "on this day", the timeline span header, histograms. The event itself is
 * still real, so the fix is to make the row UNDATED (occurred_at = NULL); the
 * original cell text survives in `payload` and a future re-import or
 * re-classification can re-derive a correct date (dedup upserts in place).
 *
 * Gated on an app_settings key written only AFTER success, mirroring
 * `runSnapshotRepairIfNeeded` (finance-snapshot.ts): a crash mid-repair
 * retries next launch; the UPDATE is idempotent so retries are safe.
 */

import { maxPlausibleEpochMs } from './dates'

export const RECORDS_DATE_REPAIR_KEY = 'recordsDateRepairV1'

/** The narrow slice of better-sqlite3 the repair needs (keeps tests light). */
type SqliteForRepair = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number }
  }
}

export function runRecordsDateRepairIfNeeded(
  sqlite: SqliteForRepair,
  now: number = Date.now()
): { ran: boolean; repaired: number } {
  const existing = sqlite
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(RECORDS_DATE_REPAIR_KEY) as { value: string } | undefined
  if (existing) return { ran: false, repaired: 0 }

  const res = sqlite
    .prepare(
      'UPDATE records SET occurred_at = NULL WHERE occurred_at IS NOT NULL AND (occurred_at < 0 OR occurred_at > ?)'
    )
    .run(maxPlausibleEpochMs(now))

  sqlite
    .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(RECORDS_DATE_REPAIR_KEY, new Date(now).toISOString(), now)
  return { ran: true, repaired: res.changes }
}
