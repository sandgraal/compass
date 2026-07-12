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

export const GCAL_DEDUPE_KEY = 'gcalDedupeV1'

/**
 * One-shot dedupe of gcal events (data cleanup pass, 2026-07). The gcal
 * naturalKey is `uid|when`, but some exporters REGENERATE event UIDs on every
 * export, so re-importing a refreshed .ics hashes the same event to a
 * different `dedup_hash` — the live-DB audit found 65 duplicate rows (same
 * title, time, location, and provenance file). Rows must be identical in
 * every user-visible field (title, time, body/location, payload) within the
 * same import file to collapse — two REAL events that merely share a title
 * and start time survive. Keep the OLDEST row of each group; the FTS delete
 * trigger keeps the index consistent. Same gate pattern as the date repair.
 */
export function runGcalDedupeIfNeeded(
  sqlite: SqliteForRepair,
  now: number = Date.now()
): { ran: boolean; removed: number } {
  const existing = sqlite
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(GCAL_DEDUPE_KEY) as { value: string } | undefined
  if (existing) return { ran: false, removed: 0 }

  const res = sqlite
    .prepare(
      `DELETE FROM records
        WHERE source = 'gcal' AND type = 'event'
          AND id NOT IN (
            SELECT MIN(id) FROM records
             WHERE source = 'gcal' AND type = 'event'
             GROUP BY title, occurred_at, COALESCE(provenance, ''),
                      COALESCE(body, ''), COALESCE(payload, '')
          )`
    )
    .run()

  sqlite
    .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(GCAL_DEDUPE_KEY, new Date(now).toISOString(), now)
  return { ran: true, removed: res.changes }
}
