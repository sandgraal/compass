/**
 * Plaid → Compass transaction normalization (Phase 4.6, PR 4).
 *
 * Plaid's `Transaction` shape is rich but doesn't match Compass's `RawTxn`
 * shape — and one detail genuinely matters:
 *
 *   - **Sign convention**. Plaid uses positive amounts for debits ("you spent
 *     $50 at Starbucks" → `+50`). Compass uses positive for credits ("paycheck
 *     arrived" → `+3000`) and negative for spend. We flip the sign here so
 *     the rest of the pipeline (categorizer, geo tagger, budgets) sees the
 *     same convention regardless of whether a row came from CSV or Plaid.
 *
 * The hash deliberately uses natural fields (date / amount / description /
 * account) and NOT Plaid's `transaction_id`. Rationale: a user who imported
 * the same period from CSV before connecting Plaid would otherwise get
 * double-counted. Hashing on the natural shape means the CSV row and the
 * Plaid row dedupe to the same key.
 *
 * `sourceFile` keeps the `transaction_id` so the `removed` branch of the
 * sync loop can find and delete a specific Plaid txn without touching its
 * non-Plaid neighbors.
 */

import type { Transaction } from 'plaid'
import { type RawTxn, hashTxn } from '../finance'

/**
 * Map Plaid's `account_id` → the human-readable account name (e.g. "Chase
 * Checking ····1234"). Built by the sync loop from `financeAccounts` rows
 * keyed on `plaid_account_id`. Passing it in (rather than looking it up
 * here) keeps `normalize` a pure function — easier to test and reason about.
 */
export type AccountNameLookup = (plaidAccountId: string) => string

/**
 * The fields we need from the surrounding Plaid Item to build `sourceFile`.
 * Kept as a narrow type so callers can construct one without dragging the
 * full DB row through.
 */
export type PlaidItemContext = {
  institutionName: string
}

/**
 * Build the `sourceFile` token Compass uses to identify a Plaid-origin row.
 * The format is contractual — the `removed` branch of `syncPlaid` does a
 * suffix match against `transaction_id` to find rows to delete, and the
 * `accounts/` UI surfaces the institution name from the same string.
 *
 * Exported so the sync loop can build the same token without re-implementing
 * the format.
 */
export function buildPlaidSourceFile(item: PlaidItemContext, transactionId: string): string {
  return `plaid:${item.institutionName}:${transactionId}`
}

/**
 * Pure mapping: one Plaid `Transaction` → one Compass `RawTxn`. Throws on
 * a row that's missing the required fields (date, amount, account_id,
 * transaction_id) because the caller has nothing useful to do with it
 * anyway and a thrown error surfaces in tests rather than silently
 * dropping rows.
 */
export function normalizePlaidTransaction(
  plaidTxn: Transaction,
  item: PlaidItemContext,
  accountNameFor: AccountNameLookup
): RawTxn {
  if (!plaidTxn.date) throw new Error('Plaid transaction missing `date`')
  if (typeof plaidTxn.amount !== 'number') {
    throw new Error('Plaid transaction missing numeric `amount`')
  }
  if (!plaidTxn.account_id) throw new Error('Plaid transaction missing `account_id`')
  if (!plaidTxn.transaction_id) {
    throw new Error('Plaid transaction missing `transaction_id`')
  }

  // Plaid is debit-positive; Compass is credit-positive. One subtraction.
  const amount = -plaidTxn.amount

  // Prefer the merchant name when Plaid has one — it's almost always
  // cleaner than the raw bank description ("STARBUCKS" vs.
  // "TST*STARBUCKS #4521 SEATTLE WA"). Fall back to `name` (Plaid's
  // bank-statement-style string) when no merchant was matched.
  const description = plaidTxn.merchant_name ?? plaidTxn.name ?? ''
  if (!description) throw new Error('Plaid transaction has neither merchant_name nor name')

  const account = accountNameFor(plaidTxn.account_id)
  const sourceFile = buildPlaidSourceFile(item, plaidTxn.transaction_id)

  return {
    date: plaidTxn.date,
    amount,
    description,
    account,
    sourceFile,
    hash: hashTxn(plaidTxn.date, amount, description, account)
  }
}

/**
 * Batch helper. Wraps `normalizePlaidTransaction` with a try/catch per row
 * and returns `{ ok, errors }` so the sync loop can log skipped rows
 * without losing the whole batch. This matches the existing CSV
 * `parser.parse` shape, which uses `flatMap` to silently drop malformed
 * rows — we surface them instead since Plaid data is supposed to be
 * well-formed.
 */
export function normalizePlaidBatch(
  plaidTxns: Transaction[],
  item: PlaidItemContext,
  accountNameFor: AccountNameLookup
): { ok: RawTxn[]; errors: Array<{ transactionId: string; message: string }> } {
  const ok: RawTxn[] = []
  const errors: Array<{ transactionId: string; message: string }> = []
  for (const t of plaidTxns) {
    try {
      ok.push(normalizePlaidTransaction(t, item, accountNameFor))
    } catch (err) {
      errors.push({
        transactionId: t.transaction_id ?? '(missing)',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { ok, errors }
}
