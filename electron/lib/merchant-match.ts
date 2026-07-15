/**
 * Merchant ↔ transaction matching (merchants redesign, 2026-07).
 *
 * The bridge between a tracked merchant (an owned `places` row) and the
 * finance ledger: every transaction carries a persisted
 * `normalized_merchant` = `normalizeMerchant(description)` (set at each
 * insert site, backfilled here), and a tracked merchant resolves to the same
 * key via `matchKeyForPlace`. Equality on that key is the whole join.
 *
 * `normalizeMerchant`'s output is a frozen contract (electron/lib/normalize.ts)
 * — the persisted column shares the same stability rules as the `detected:`
 * subscription ids and derived-entity matchKeys.
 */

import type Database from 'better-sqlite3'
import { normalizeMerchant } from './normalize'

const BACKFILL_BATCH = 5000

/**
 * Resolve the merchant merge key for an owned `places` row: promoted rows
 * carry it in their `derived:<kind>:<key>` external id; manual rows fall back
 * to normalizing the display name (which means renaming a manual merchant
 * changes its transaction match set — acceptable, documented behavior).
 */
export function matchKeyForPlace(externalId: string, name: string): string {
  const m = externalId.match(/^derived:(?:merchant|place):(.+)$/)
  if (m) return m[1]
  return normalizeMerchant(name)
}

/**
 * Resolve the merchant merge key for an owned `subscriptions` row — the exact
 * inverse of `findLinkedSubscription` (`electron/ipc/merchants.ts`), kept next
 * to `matchKeyForPlace` so the two link directions can't drift apart. Rows
 * materialized from the ledger detector carry the key in their
 * `detected:<merchant>::<account>` external id; manual rows fall back to
 * normalizing the display name (same acceptable rename caveat as above).
 *
 * The account segment is matched with an unrestricted `.*` (not `[^:]*`) —
 * the delimiter is the literal `::`, and an account name is free to contain a
 * single colon (e.g. "Chase: Business Checking"). Greedy backtracking still
 * splits on the LAST `::` in the string, so a merchant key that itself
 * contains `::` (see the merchant-match.test.ts case) keeps working.
 */
export function matchKeyForSubscription(externalId: string, name: string): string {
  const m = externalId.match(/^detected:(.+)::.*$/)
  if (m) return m[1]
  return normalizeMerchant(name)
}

/**
 * Every match key a tracked `places` row currently resolves to: its own
 * primary key plus every match key merged into it (`place_merge_aliases`).
 * Read-time only — nothing at ingest time needs to know about a merge, since
 * a query built against this expanded set picks up transactions/visits keyed
 * under an alias whether they were ingested before or after the merge.
 */
export function allMatchKeysForPlace(
  sqlite: Database.Database,
  placeId: number,
  primaryKey: string,
  kind: 'merchant' | 'place'
): string[] {
  const aliases = sqlite
    .prepare('SELECT alias_key FROM place_merge_aliases WHERE kind = ? AND survivor_place_id = ?')
    .all(kind, placeId) as Array<{ alias_key: string }>
  return [primaryKey, ...aliases.map((a) => a.alias_key)]
}

/**
 * Backfill `finance_transactions.normalized_merchant` for rows that predate
 * the column (or slipped past an insert site). Batched (5k rows per
 * transaction) so a huge ledger can't hold a write lock for seconds;
 * idempotent and self-gating — targets only NULL rows, so a fully-backfilled
 * DB pays one indexed probe per launch. `normalizeMerchant` can return '' for
 * junk descriptions; '' is stored as-is (not NULL) so the loop terminates.
 * Returns the number of rows updated.
 */
export function ensureNormalizedMerchants(sqlite: Database.Database): number {
  const select = sqlite.prepare(
    `SELECT id, description FROM finance_transactions
     WHERE normalized_merchant IS NULL LIMIT ${BACKFILL_BATCH}`
  )
  const update = sqlite.prepare(
    'UPDATE finance_transactions SET normalized_merchant = ? WHERE id = ?'
  )
  const applyBatch = sqlite.transaction((rows: Array<{ id: number; description: string }>) => {
    for (const r of rows) update.run(normalizeMerchant(r.description ?? ''), r.id)
  })
  let total = 0
  while (true) {
    const rows = select.all() as Array<{ id: number; description: string }>
    if (rows.length === 0) break
    applyBatch(rows)
    total += rows.length
  }
  return total
}
