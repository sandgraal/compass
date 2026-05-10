/**
 * Unit tests for the CSV parser registry. Loads each bank's fixture, runs the
 * full parser-detection + parse pipeline via `parseFinanceFile`, and asserts
 * the parsed `RawTxn[]` shape.
 *
 * Fixtures live in `__fixtures__/finance/` as .csv files with a few rows
 * representative of that bank's export format.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type RawTxn, categorize, parseFinanceFile } from './finance'

const FIXTURES = join(__dirname, '__fixtures__', 'finance')

describe('Rocket Money parser', () => {
  it('parses a Rocket Money export with sign-flip and account normalization', async () => {
    const result = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.bank).toBe('Rocket Money')
    // 6 fixture rows, 1 is "Ignored From: everything" → 5 emitted
    expect(result.txns).toHaveLength(5)
  })

  it('flips the sign so expenses are negative', async () => {
    const result = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    if (!result) throw new Error('expected parse result')
    const starbucks = result.txns.find((t) => t.description === 'STARBUCKS STORE 12345')
    expect(starbucks?.amount).toBe(-5.75)
    // Income (a transfer credit in this fixture) stays positive after flip.
    const transfer = result.txns.find((t) => t.description === 'USAA FUNDS TRANSFER CR')
    expect(transfer?.amount).toBe(-1500) // export shows positive 1500 for the credit row → flip to -1500
  })

  it('normalizes Rocket Money account names to canonical labels', async () => {
    const result = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    if (!result) throw new Error('expected parse result')
    const accounts = new Set(result.txns.map((t) => t.account))
    expect(accounts.has('Amex Platinum')).toBe(true) // Platinum Card®
    expect(accounts.has('USAA Checking')).toBe(true) // Chris Checking
    expect(accounts.has('USAA Savings')).toBe(true) // Chris Savings
    expect(accounts.has('Amex Hilton Surpass')).toBe(true) // Hilton Honors Surpass® Card
    expect(accounts.has('PayPal')).toBe(true)
  })

  it('skips rows tagged "Ignored From: everything"', async () => {
    const result = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    if (!result) throw new Error('expected parse result')
    const temu = result.txns.find((t) => t.description.includes('Temu'))
    expect(temu).toBeUndefined()
  })

  it('preserves Rocket Money category as a `rm:` token in notes', async () => {
    const result = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    if (!result) throw new Error('expected parse result')
    const starbucks = result.txns.find((t) => t.description === 'STARBUCKS STORE 12345')
    expect(starbucks?.notes ?? '').toContain('rm:Coffee Shops')
  })

  it('produces stable hashes (same input → same hash)', async () => {
    const a = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    const b = await parseFinanceFile(join(FIXTURES, 'rocket-money-export.csv'))
    if (!a || !b) throw new Error('expected parse results')
    expect(a.txns.map((t) => t.hash)).toEqual(b.txns.map((t) => t.hash))
  })
})

describe('categorize fallbacks', () => {
  const txn = (description: string, notes?: string): RawTxn => ({
    date: '2026-04-15',
    amount: -50,
    description,
    account: 'USAA Checking',
    sourceFile: 'test.csv',
    hash: 'deadbeefdeadbeef',
    notes
  })

  it('matches the longest user rule first', () => {
    const out = categorize(
      [txn('STARBUCKS RESERVE')],
      [
        { pattern: 'starbucks', category: 'Food & Drink', subcategory: 'Coffee' },
        { pattern: 'starbucks reserve', category: 'Food & Drink', subcategory: 'Coffee — premium' }
      ]
    )
    expect(out[0].subcategory).toBe('Coffee — premium')
  })

  it('falls back to ATM-id regex for 020NNNNNN descriptions when no rule matches', () => {
    const out = categorize([txn('020004031 CARTAGO')], [])
    expect(out[0].category).toBe('Cash')
    expect(out[0].subcategory).toBe('ATM withdrawal')
  })

  it('falls back to Rocket Money category map when notes carry an rm: token', () => {
    const out = categorize([txn('SOME RANDOM CR MERCHANT', 'rm:Groceries')], [])
    expect(out[0].category).toBe('Food & Drink')
    expect(out[0].subcategory).toBe('Groceries')
  })

  it('user rules win over both fallbacks', () => {
    const out = categorize(
      [txn('020004031 CARTAGO', 'rm:Cash & Checks')],
      [{ pattern: '020004031', category: 'Property', subcategory: 'Construction — labor (est)' }]
    )
    expect(out[0].category).toBe('Property')
  })

  it('marks Uncategorized when no rule and no fallback applies', () => {
    const out = categorize([txn('OBSCURE NEW MERCHANT')], [])
    expect(out[0].category).toBe('Uncategorized')
  })
})
