/**
 * Tests for Plaid → Compass transaction normalization.
 *
 * The "shape" tests are mostly self-documenting. The hash test is the
 * load-bearing one: the contract says the hash must NOT depend on Plaid's
 * `transaction_id`, so a user who imported the same period from CSV and
 * then connects Plaid sees one row, not two. If anyone changes the hash
 * recipe, this test breaks loudly.
 */

import type { Transaction } from 'plaid'
import { describe, expect, it } from 'vitest'
import { hashTxn } from '../finance'
import { buildPlaidSourceFile, normalizePlaidBatch, normalizePlaidTransaction } from './normalize'

// Minimal `Transaction` factory — fills only the fields normalize() reads,
// plus the structural requireds. Cast to `Transaction` so we don't have
// to populate Plaid's 300+ optional fields.
function makeTxn(over: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 'TX-001',
    account_id: 'ACC-001',
    date: '2026-05-15',
    amount: 12.34,
    name: 'STARBUCKS STORE 04521',
    merchant_name: 'Starbucks',
    iso_currency_code: 'USD',
    pending: false,
    ...over
  } as Transaction
}

const ITEM = { institutionName: 'Chase' }
const ACCOUNTS = (id: string) =>
  ({ 'ACC-001': 'Chase Checking', 'ACC-002': 'Chase Savings' })[id] ?? '(unknown)'

describe('normalizePlaidTransaction', () => {
  it('flips Plaid debit-positive sign to Compass credit-positive', () => {
    const out = normalizePlaidTransaction(makeTxn({ amount: 12.34 }), ITEM, ACCOUNTS)
    expect(out.amount).toBe(-12.34)
  })

  it('preserves positive amount for Plaid credits (refunds)', () => {
    // A refund arrives as a negative Plaid amount → positive Compass amount.
    const out = normalizePlaidTransaction(makeTxn({ amount: -50 }), ITEM, ACCOUNTS)
    expect(out.amount).toBe(50)
  })

  it('prefers merchant_name over name for description', () => {
    const out = normalizePlaidTransaction(
      makeTxn({ name: 'TST*STARBUCKS #4521 SEATTLE WA', merchant_name: 'Starbucks' }),
      ITEM,
      ACCOUNTS
    )
    expect(out.description).toBe('Starbucks')
  })

  it('falls back to name when merchant_name is missing', () => {
    const out = normalizePlaidTransaction(
      makeTxn({ name: 'COSTCO WHSE #1234', merchant_name: null }),
      ITEM,
      ACCOUNTS
    )
    expect(out.description).toBe('COSTCO WHSE #1234')
  })

  it('resolves account_id to the human name via the lookup', () => {
    const out = normalizePlaidTransaction(makeTxn({ account_id: 'ACC-002' }), ITEM, ACCOUNTS)
    expect(out.account).toBe('Chase Savings')
  })

  it('builds the canonical sourceFile format `plaid:<institution>:<txn_id>`', () => {
    const out = normalizePlaidTransaction(makeTxn({ transaction_id: 'TX-abc123' }), ITEM, ACCOUNTS)
    expect(out.sourceFile).toBe('plaid:Chase:TX-abc123')
  })

  it('hash matches the CSV-path hash for identical natural fields', () => {
    // Critical: the hash MUST be stable across CSV and Plaid for the same
    // logical txn so a CSV→Plaid migration doesn't double-count.
    const plaidRow = normalizePlaidTransaction(
      makeTxn({ amount: 12.34, date: '2026-05-15', merchant_name: 'Starbucks' }),
      ITEM,
      ACCOUNTS
    )
    const csvHash = hashTxn('2026-05-15', -12.34, 'Starbucks', 'Chase Checking')
    expect(plaidRow.hash).toBe(csvHash)
  })

  it('hash does NOT depend on Plaid transaction_id', () => {
    // Same natural fields + different transaction_id ⇒ same hash.
    const a = normalizePlaidTransaction(makeTxn({ transaction_id: 'TX-A' }), ITEM, ACCOUNTS)
    const b = normalizePlaidTransaction(makeTxn({ transaction_id: 'TX-B' }), ITEM, ACCOUNTS)
    expect(a.hash).toBe(b.hash)
    expect(a.sourceFile).not.toBe(b.sourceFile)
  })

  it('throws on missing date', () => {
    expect(() => normalizePlaidTransaction(makeTxn({ date: '' }), ITEM, ACCOUNTS)).toThrow(/date/)
  })

  it('throws on non-numeric amount', () => {
    expect(() =>
      normalizePlaidTransaction(makeTxn({ amount: undefined as unknown as number }), ITEM, ACCOUNTS)
    ).toThrow(/amount/)
  })

  it('throws when both name and merchant_name are empty', () => {
    expect(() =>
      normalizePlaidTransaction(makeTxn({ name: '', merchant_name: null }), ITEM, ACCOUNTS)
    ).toThrow(/merchant_name/)
  })
})

describe('normalizePlaidBatch', () => {
  it('returns ok rows and per-row error summaries', () => {
    const res = normalizePlaidBatch(
      [
        makeTxn({ transaction_id: 'TX-1' }),
        makeTxn({ transaction_id: 'TX-2', date: '' }), // bad
        makeTxn({ transaction_id: 'TX-3' })
      ],
      ITEM,
      ACCOUNTS
    )
    expect(res.ok).toHaveLength(2)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({
      transactionId: 'TX-2',
      message: expect.stringMatching(/date/)
    })
  })
})

describe('buildPlaidSourceFile', () => {
  it('uses the canonical colon-delimited shape', () => {
    expect(buildPlaidSourceFile({ institutionName: 'Wells Fargo' }, 'TX-xyz')).toBe(
      'plaid:Wells Fargo:TX-xyz'
    )
  })
})
