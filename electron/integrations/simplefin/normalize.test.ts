/**
 * Tests for SimpleFIN → RawTxn normalization.
 *
 * The single most important invariant: NO sign flip. SimpleFIN amounts are
 * already +deposit / −withdrawal (Compass's convention), unlike Plaid which is
 * debit-positive and gets negated. A copy-paste from the Plaid normalizer would
 * regress this; the first test pins it.
 */

import { describe, expect, it } from 'vitest'
import { hashTxn } from '../finance'
import type { SimplefinAccount, SimplefinTransaction } from './client'
import {
  buildSimplefinSourceFile,
  normalizeSimplefinAccount,
  normalizeSimplefinTransaction
} from './normalize'

const nameFor = (_id: string): string => 'Amex Platinum'

function txn(over: Partial<SimplefinTransaction>): SimplefinTransaction {
  return {
    id: over.id ?? 'tx-1',
    // 2024-06-15 12:00:00 UTC — noon keeps the local calendar day stable across
    // every realistic dev/CI timezone (UTC-12…UTC+11).
    posted: over.posted ?? 1_718_452_800,
    amount: over.amount ?? '-42.50',
    description: over.description ?? 'Blue Bottle Coffee'
  }
}

describe('normalizeSimplefinTransaction — sign convention', () => {
  it('does NOT flip the sign — a withdrawal stays negative', () => {
    const r = normalizeSimplefinTransaction(
      txn({ amount: '-42.50' }),
      { orgName: 'Amex' },
      nameFor,
      'acc-1'
    )
    expect(r.amount).toBe(-42.5)
  })

  it('keeps a deposit positive', () => {
    const r = normalizeSimplefinTransaction(
      txn({ amount: '1000.00' }),
      { orgName: 'Amex' },
      nameFor,
      'acc-1'
    )
    expect(r.amount).toBe(1000)
  })
})

describe('normalizeSimplefinTransaction — mapping', () => {
  it('maps unix posted → local YYYY-MM-DD', () => {
    const r = normalizeSimplefinTransaction(
      txn({ posted: 1_718_452_800 }),
      { orgName: 'Amex' },
      nameFor,
      'acc-1'
    )
    expect(r.date).toBe('2024-06-15')
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('builds the contractual sourceFile token', () => {
    const r = normalizeSimplefinTransaction(
      txn({ id: 'tx-abc' }),
      { orgName: 'American Express' },
      nameFor,
      'acc-1'
    )
    expect(r.sourceFile).toBe('simplefin:American Express:tx-abc')
    expect(r.sourceFile).toBe(buildSimplefinSourceFile('American Express', 'tx-abc'))
  })

  it('hashes on natural fields (matches the shared hashTxn)', () => {
    const r = normalizeSimplefinTransaction(txn({}), { orgName: 'Amex' }, nameFor, 'acc-1')
    expect(r.hash).toBe(hashTxn('2024-06-15', -42.5, 'Blue Bottle Coffee', 'Amex Platinum'))
  })

  it('throws on a non-numeric amount', () => {
    expect(() =>
      normalizeSimplefinTransaction(txn({ amount: 'NaN' }), { orgName: 'Amex' }, nameFor, 'acc-1')
    ).toThrow(/non-numeric/)
  })

  it('throws on an empty description', () => {
    expect(() =>
      normalizeSimplefinTransaction(
        txn({ description: '   ' }),
        { orgName: 'Amex' },
        nameFor,
        'acc-1'
      )
    ).toThrow(/empty description/)
  })
})

function account(transactions: SimplefinTransaction[]): SimplefinAccount {
  return {
    id: 'acc-1',
    name: 'Platinum Card',
    currency: 'USD',
    balance: '-1234.56',
    'balance-date': 1_718_452_800,
    org: { name: 'American Express', domain: 'americanexpress.com' },
    transactions
  }
}

describe('normalizeSimplefinAccount — batch + pending', () => {
  it('skips pending rows (posted === 0) by default', () => {
    const { ok } = normalizeSimplefinAccount(
      account([txn({ id: 'posted', posted: 1_718_452_800 }), txn({ id: 'pending', posted: 0 })]),
      nameFor
    )
    expect(ok).toHaveLength(1)
    expect(ok[0].sourceFile).toContain('posted')
  })

  it('includes pending rows when asked', () => {
    const { ok } = normalizeSimplefinAccount(
      account([txn({ id: 'pending', posted: 0 })]),
      nameFor,
      { includePending: true }
    )
    expect(ok).toHaveLength(1)
  })

  it('collects per-row errors without losing the batch', () => {
    const { ok, errors } = normalizeSimplefinAccount(
      account([txn({ id: 'good' }), txn({ id: 'bad', amount: 'oops' })]),
      nameFor
    )
    expect(ok).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].transactionId).toBe('bad')
  })
})
