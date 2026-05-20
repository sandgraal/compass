/**
 * Plaid cursor read/write helpers (Phase 4.6, PR 4).
 *
 * Plaid's `/transactions/sync` is cursor-paginated: every call returns the
 * delta since the last `next_cursor` we sent. The cursor lives on
 * `plaid_items.cursor` so it survives across app restarts — without that,
 * a crash mid-sync would force us to either re-sync everything (expensive,
 * risk of dupes if hash collisions slip through) or skip transactions
 * (worse: silent data loss).
 *
 * Both helpers are deliberately tiny and synchronous so the sync loop can
 * reason about ordering: we set the cursor only after a page is fully
 * processed, so a crash mid-page just means the next sync replays that
 * page — which is exactly what Plaid's idempotency guarantee covers.
 */

import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { plaidItems } from '../../db/schema'

/**
 * Returns the persisted cursor for an Item, or `null` if we've never synced
 * this Item before. Plaid treats a missing cursor as "start from the
 * beginning", so `null` is the right initial-sync sentinel.
 *
 * @param plaidItemId Plaid's stable item_id string (matches
 *                    `plaid_items.item_id`, NOT the SQLite PK `id`).
 */
export function getCursor(plaidItemId: string): string | null {
  const db = getDb()
  const row = db
    .select({ cursor: plaidItems.cursor })
    .from(plaidItems)
    .where(eq(plaidItems.itemId, plaidItemId))
    .get()
  return row?.cursor ?? null
}

/**
 * Persist the next cursor for an Item. Called from the sync loop AFTER a
 * page's `added` + `modified` + `removed` have been applied to the local
 * DB; if we set the cursor before applying, a crash between the two would
 * skip transactions on the next sync.
 *
 * Idempotent — calling with the same value twice is a no-op-equivalent
 * UPDATE.
 *
 * @throws If the Item doesn't exist (the caller passed an item_id we've
 *         never seen; almost certainly a bug, so loud failure is correct).
 */
export function setCursor(plaidItemId: string, cursor: string): void {
  const db = getDb()
  const res = db.update(plaidItems).set({ cursor }).where(eq(plaidItems.itemId, plaidItemId)).run()
  if (res.changes === 0) {
    throw new Error(`setCursor: no plaid_items row for itemId=${plaidItemId}`)
  }
}
