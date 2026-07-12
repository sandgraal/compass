/**
 * Shared gate mechanics for one-shot data-repair/cleanup passes (2026-07 wave:
 * finance snapshot repair, records date repair, gcal dedupe, document spine
 * dates, records reclassify V1/V2, Netflix refile, generic telemetry purge,
 * spine expansion backfill — see `electron/db/client.ts` and `electron/main.ts`
 * for the two points these run from).
 *
 * Every one of those repairs was independently re-implementing the same
 * "have we already run this, and mark it done" ceremony: check an
 * `app_settings` key, run the repair, write the key only AFTER success (so a
 * crash mid-repair retries next launch, since the repair itself is
 * idempotent/dedupe-safe). This module owns that ceremony; each repair owns
 * only its actual repair logic.
 */

export type SqliteForOneShot = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number }
  }
}

/**
 * Run `repair()` exactly once per install, gated on `key` in `app_settings`.
 * Returns `{ ran: false }` if the key is already set; otherwise runs the
 * repair, writes the gate, and returns `{ ran: true, ...repair()'s result }`.
 *
 * Discriminated on `ran` so callers can narrow (`if (res.ran) res.imported`)
 * without an `Partial<T>` cast. `ran: true` is spread LAST so a repair result
 * can never accidentally shadow it, even if `T` happened to have its own
 * `ran` field.
 */
export function runOnceGated<T extends object>(
  sqlite: SqliteForOneShot,
  key: string,
  repair: () => T,
  now: number = Date.now()
): { ran: false } | ({ ran: true } & T) {
  const existing = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (existing) return { ran: false }

  const result = repair()
  sqlite
    .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, new Date(now).toISOString(), now)
  return { ...result, ran: true }
}
