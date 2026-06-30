/**
 * Keep each transaction's `currency` in sync with its account's `currency`
 * (Phase 11.1 follow-up — ingest-time currency inheritance).
 *
 * A transaction is denominated in its account's native currency by design: a
 * charge on a colón account is in CRC, one on a USD card is in USD. The
 * account's currency is user-set (Net Worth → account currency), and the
 * `finance:set-account-currency` IPC already cascades a change onto that
 * account's EXISTING rows. The gap this closes: transactions ingested LATER
 * (a SimpleFIN/Plaid sync, a new statement) are inserted with the column
 * default `'USD'` and never pick up their account's currency — so a colón
 * account silently re-accumulated USD-labelled rows after every sync.
 *
 * `reconcileTransactionCurrency` is the ingest-time complement: one idempotent
 * pass that relabels every account-linked transaction with its account's
 * currency. Call it after each ingest/sync, right after `applyAtmSplit` (so it
 * also catches the split sibling rows that pass produces).
 *
 * This is distinct from `finance-fx.ts`, which converts amounts BETWEEN
 * currencies; this only *labels* each row with the right one. Unlinked rows
 * (CSV imports with `account_id IS NULL`) are left untouched — there is no
 * account to inherit from.
 */

import { and, eq, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

/**
 * Set every account-linked transaction's currency to its account's currency,
 * touching only rows that currently disagree — so re-runs are no-ops and the
 * returned count reflects real changes. Returns the number of rows relabelled.
 */
export function reconcileTransactionCurrency(db: BetterSQLite3Database<typeof schema>): number {
  const accounts = db
    .select({ id: schema.financeAccounts.id, currency: schema.financeAccounts.currency })
    .from(schema.financeAccounts)
    .all()

  let updated = 0
  for (const a of accounts) {
    const res = db
      .update(schema.financeTransactions)
      .set({ currency: a.currency })
      .where(
        and(
          eq(schema.financeTransactions.accountId, a.id),
          ne(schema.financeTransactions.currency, a.currency)
        )
      )
      .run()
    updated += Number(res.changes ?? 0)
  }
  return updated
}
