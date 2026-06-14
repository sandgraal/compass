/**
 * SimpleFIN → Compass transaction normalization (Phase 4.7).
 *
 * Maps SimpleFIN's account/transaction JSON to Compass's shared `RawTxn` shape
 * so the rest of the pipeline (categorizer, geo tagger, tax tagger, hash dedup)
 * is identical to the CSV and Plaid paths.
 *
 * SIGN CONVENTION — the detail that genuinely matters. SimpleFIN amounts are
 * **+deposit / −withdrawal** (money in is positive, money out is negative).
 * That is ALREADY Compass's credit-positive convention, so — UNLIKE the Plaid
 * path, which flips the sign — we do NOT negate here. The normalize test pins
 * this so a copy-paste from the Plaid normalizer can't silently regress it.
 *
 * DATE — SimpleFIN `posted` is a Unix timestamp (seconds); `0` means pending.
 * We map it to the LOCAL calendar day ('YYYY-MM-DD'), matching how Compass's
 * date-only columns are treated elsewhere (local day, not UTC).
 *
 * The hash uses natural fields (date / amount / description / account), NOT
 * SimpleFIN's `id`, so a row imported from CSV and the same row from SimpleFIN
 * dedupe to one. `sourceFile` keeps `simplefin:<org>:<txnId>` so a future
 * delete path can target a specific SimpleFIN row.
 */

import { type RawTxn, hashTxn } from '../finance'
import type { SimplefinAccount, SimplefinTransaction } from './client'

/**
 * Map a SimpleFIN account `id` → the human-readable account name (built by the
 * sync loop from `finance_accounts` rows). Passed in (rather than looked up
 * here) to keep normalization pure and testable.
 */
export type AccountNameLookup = (simplefinAccountId: string) => string

export type SimplefinOrgContext = {
  orgName: string
}

/** Unix seconds → local 'YYYY-MM-DD'. Local (not UTC) to match Compass's
 *  date-only column convention. */
function unixToLocalIsoDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build the `sourceFile` token Compass uses to identify a SimpleFIN-origin row.
 * Format is contractual — exported so callers build the same token rather than
 * re-implementing it.
 */
export function buildSimplefinSourceFile(orgName: string, transactionId: string): string {
  return `simplefin:${orgName}:${transactionId}`
}

/**
 * Pure mapping: one SimpleFIN transaction → one Compass `RawTxn`. Throws on a
 * row missing required fields (id, numeric amount, description) so the caller
 * can surface skipped rows in tests rather than silently dropping them.
 */
export function normalizeSimplefinTransaction(
  txn: SimplefinTransaction,
  org: SimplefinOrgContext,
  accountNameFor: AccountNameLookup,
  simplefinAccountId: string
): RawTxn {
  if (!txn.id) throw new Error('SimpleFIN transaction missing `id`')

  const amount = Number.parseFloat(txn.amount)
  if (!Number.isFinite(amount)) {
    throw new Error(`SimpleFIN transaction ${txn.id} has non-numeric amount '${txn.amount}'`)
  }
  // SimpleFIN is +deposit/−withdrawal — already Compass's convention. No flip.

  const date = unixToLocalIsoDate(txn.posted)
  const description = (txn.description ?? '').trim()
  if (!description) throw new Error(`SimpleFIN transaction ${txn.id} has empty description`)

  const account = accountNameFor(simplefinAccountId)
  return {
    date,
    amount,
    description,
    account,
    sourceFile: buildSimplefinSourceFile(org.orgName, txn.id),
    hash: hashTxn(date, amount, description, account)
  }
}

/**
 * Batch helper for one SimpleFIN account's transactions. Wraps the per-row
 * normalizer in try/catch so a single malformed row doesn't lose the batch.
 * Pending rows (`posted === 0`) are skipped unless `includePending` is set.
 */
export function normalizeSimplefinAccount(
  account: SimplefinAccount,
  accountNameFor: AccountNameLookup,
  opts?: { includePending?: boolean }
): { ok: RawTxn[]; errors: Array<{ transactionId: string; message: string }> } {
  const ok: RawTxn[] = []
  const errors: Array<{ transactionId: string; message: string }> = []
  const orgName = account.org?.name ?? ''
  for (const t of account.transactions ?? []) {
    if (t.posted === 0 && !opts?.includePending) continue // pending — skip
    try {
      ok.push(normalizeSimplefinTransaction(t, { orgName }, accountNameFor, account.id))
    } catch (err) {
      errors.push({
        transactionId: t.id ?? '(missing)',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { ok, errors }
}
