import { describe, expect, it } from 'vitest'
import { parseMoney } from './entities'
import { type FinanceTxnRow, projectFinanceTransactions } from './storehouse-projectors'

const txn = (partial: Partial<FinanceTxnRow> & Pick<FinanceTxnRow, 'hash'>): FinanceTxnRow => ({
  date: '2026-06-01',
  amount: -25,
  currency: 'USD',
  description: 'Starbucks',
  category: 'Dining',
  ...partial
})

describe('projectFinanceTransactions', () => {
  it('maps a transaction to the records shape', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1' })])
    expect(r.source).toBe('finance')
    expect(r.type).toBe('txn')
    expect(r.title).toBe('Starbucks')
    expect(r.naturalKey).toBe('h1') // reuses the txn's unique hash → idempotent re-projection
    // occurredAt is the LOCAL day, not UTC midnight (avoids off-by-one on the timeline).
    expect(r.occurredAt).toBe(new Date('2026-06-01T00:00:00').getTime())
    expect(r.payload).toEqual(txn({ hash: 'h1' }))
  })

  it('formats the body so parseMoney (the merchant extractor) reads back the spend', () => {
    // This coupling is load-bearing: the finance-merchant extractor recovers the
    // amount via parseMoney(body). If the body format drifts, Merchants/Subscriptions
    // silently lose spend — so assert the round-trip explicitly.
    const [expense] = projectFinanceTransactions([
      txn({ hash: 'h1', amount: -25, currency: 'USD' })
    ])
    expect(expense.body).toBe('-25.00 USD · Dining')
    expect(parseMoney(expense.body ?? null)).toEqual({ amount: -25, currency: 'USD' })

    const [income] = projectFinanceTransactions([
      txn({ hash: 'h2', amount: 1500, currency: 'USD', category: 'Salary' })
    ])
    expect(income.body).toBe('1500.00 USD · Salary')
    expect(parseMoney(income.body ?? null)).toEqual({ amount: 1500, currency: 'USD' })
  })

  it('defaults a missing currency to USD and a missing category to Uncategorized', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', currency: null, category: null })])
    expect(r.body).toBe('-25.00 USD · Uncategorized')
  })

  it('falls back to a generic title when the description is blank', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', description: '   ' })])
    expect(r.title).toBe('Transaction')
  })

  it('yields a null occurredAt for an unparseable date rather than NaN', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', date: 'not-a-date' })])
    expect(r.occurredAt).toBeNull()
  })

  it('skips rows without a stable hash (cannot dedupe safely)', () => {
    expect(projectFinanceTransactions([txn({ hash: '' })])).toHaveLength(0)
  })
})
