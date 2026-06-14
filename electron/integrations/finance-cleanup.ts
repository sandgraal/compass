/**
 * In-app finance cleanup tools (Phase 4.7 — #4).
 *
 * The safe, previewable version of the manual reconciliation surgery used when
 * connecting an aggregator after a CSV era left **duplicate accounts** and
 * **re-imported transactions**:
 *
 *   - `mergeAccounts` — fold a duplicate account into a keeper: reassign its
 *     transactions, move its provider (SimpleFIN) linkage if the keeper lacks
 *     one, drop its snapshots/overrides, delete the row.
 *   - `countDuplicateTransactions` / `dedupeTransactions` — collapse rows that
 *     are the SAME charge: identical date + amount + NORMALIZED description.
 *     Normalizing (strip digits / `*` / spaces) means a charge re-imported with
 *     a cosmetically-different description collapses, while genuinely different
 *     rows — including the two legs of a transfer — stay apart. On each group
 *     the SimpleFIN row is kept (so future re-syncs don't recreate the dup).
 */

import type Database from 'better-sqlite3'

/**
 * SQL expression that normalizes `description` to a dedup key: lowercase, then
 * strip every digit, `*`, and space. Kept as a string so it can be inlined into
 * the PARTITION BY / DISTINCT expressions below.
 */
const NORM_DESC =
  "replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(description),'0',''),'1',''),'2',''),'3',''),'4',''),'5',''),'6',''),'7',''),'8',''),'9',''),'*',''),' ','')"

/**
 * Fold `sourceId` into `targetId`: the source's transactions are reassigned to
 * the target, its balance snapshots + forecast overrides are dropped, and the
 * source row is deleted. If the target has no provider linkage but the source
 * does, the linkage moves to the target so syncing survives the merge.
 * Wrapped in a single transaction. Returns the number of reassigned txns.
 */
export function mergeAccounts(
  sqlite: Database.Database,
  sourceId: number,
  targetId: number
): { reassigned: number } {
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
    throw new Error('mergeAccounts: account ids must be integers')
  }
  if (sourceId === targetId) {
    throw new Error('mergeAccounts: source and target must differ')
  }
  const found = sqlite
    .prepare('SELECT id FROM finance_accounts WHERE id IN (?, ?)')
    .all(sourceId, targetId) as Array<{ id: number }>
  if (found.length !== 2) {
    throw new Error('mergeAccounts: source or target account not found')
  }

  const run = sqlite.transaction(() => {
    // Preserve sync linkage: if the keeper isn't provider-linked but the source
    // is, move the SimpleFIN linkage (and last-4) onto the keeper.
    const src = sqlite
      .prepare(
        'SELECT simplefin_account_id sa, simplefin_connection_id sc, mask FROM finance_accounts WHERE id = ?'
      )
      .get(sourceId) as { sa: string | null; sc: number | null; mask: string | null }
    const tgt = sqlite
      .prepare('SELECT simplefin_account_id sa FROM finance_accounts WHERE id = ?')
      .get(targetId) as { sa: string | null }
    if (!tgt.sa && src.sa) {
      sqlite
        .prepare(
          'UPDATE finance_accounts SET simplefin_account_id = ?, simplefin_connection_id = ?, mask = COALESCE(mask, ?) WHERE id = ?'
        )
        .run(src.sa, src.sc, src.mask, targetId)
    }
    const reassigned = sqlite
      .prepare('UPDATE finance_transactions SET account_id = ? WHERE account_id = ?')
      .run(targetId, sourceId).changes
    sqlite.prepare('DELETE FROM finance_balance_snapshots WHERE account_id = ?').run(sourceId)
    sqlite.prepare('DELETE FROM forecast_overrides WHERE account_id = ?').run(sourceId)
    sqlite.prepare('DELETE FROM finance_accounts WHERE id = ?').run(sourceId)
    return reassigned
  })
  return { reassigned: run() }
}

/** How many transactions would `dedupeTransactions` remove (preview). */
export function countDuplicateTransactions(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(
      `SELECT count(*) - count(DISTINCT date || '|' || round(amount, 2) || '|' || ${NORM_DESC}) AS n
       FROM finance_transactions`
    )
    .get() as { n: number }
  return row.n
}

/**
 * Remove duplicate transactions, keeping one per (date, amount, normalized
 * description) group — the SimpleFIN row when the group has one, else the
 * lowest id. Wrapped in a transaction. Returns the number removed.
 */
export function dedupeTransactions(sqlite: Database.Database): { removed: number } {
  const run = sqlite.transaction(
    () =>
      sqlite
        .prepare(
          `DELETE FROM finance_transactions WHERE id IN (
             SELECT id FROM (
               SELECT id, row_number() OVER (
                 PARTITION BY date, round(amount, 2), ${NORM_DESC}
                 ORDER BY (source_file LIKE 'simplefin:%') DESC, id
               ) rn
               FROM finance_transactions
             ) WHERE rn > 1
           )`
        )
        .run().changes
  )
  return { removed: run() }
}
