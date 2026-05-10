/**
 * Unit tests for finance parser helpers and parser selection:
 * - parser coverage via fixtures (including Rocket Money)
 * - categorize fallback behavior
 * - folder-based account hint behavior
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type RawTxn, categorize, getAccountHintFromPath, parseFinanceFile } from './finance'

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
    // Rocket Money exports this credit row as +1500; we invert signs uniformly
    // on import so every outflow/inflow follows Compass's signed convention.
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

// ── getAccountHintFromPath ────────────────────────────────────────────────────

describe('getAccountHintFromPath', () => {
  it('returns the parent directory name when the file is nested under the root', () => {
    const result = getAccountHintFromPath('/Money/USAA/statement-2026-04.csv', '/Money')
    expect(result).toBe('USAA')
  })

  it('returns undefined when the file is a direct child of the root', () => {
    const result = getAccountHintFromPath('/Money/statement.csv', '/Money')
    expect(result).toBeUndefined()
  })

  it('returns the immediate parent (not a grandparent) for deeply-nested files', () => {
    const result = getAccountHintFromPath('/Money/Chase/2026/march.csv', '/Money')
    expect(result).toBe('2026')
  })

  it('handles trailing slashes on the watchRoot', () => {
    const result = getAccountHintFromPath('/Money/Amex/feb.csv', '/Money/')
    expect(result).toBe('Amex')
  })

  it('is case-sensitive — returns the directory name as-is', () => {
    const result = getAccountHintFromPath('/docs/Discover/stmt.pdf', '/docs')
    expect(result).toBe('Discover')
  })

  it('returns the parent dir name using join-style paths', () => {
    const root = '/home/user/Documents/Money'
    const file = join(root, 'Chase', 'statement.csv')
    expect(getAccountHintFromPath(file, root)).toBe('Chase')
  })

  it('returns undefined when watchRoot is empty string (no root context)', () => {
    expect(getAccountHintFromPath('/a/b/c.csv', '')).toBeUndefined()
  })

  it('returns undefined when filePath is outside watchRoot', () => {
    const result = getAccountHintFromPath('/Elsewhere/USAA/statement.csv', '/Money')
    expect(result).toBeUndefined()
  })
})

function writeTestCsv(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'date,description,amount\n2026-04-20,Coffee,4.50\n', 'utf8')
}

describe('parseFinanceFile directory-name institution signal', () => {
  it('detects institution from nested folder name when filename is generic', async () => {
    const watchRoot = mkdtempSync(join(tmpdir(), 'compass-finance-test-'))
    const csvPath = join(watchRoot, 'USAA', 'statement.csv')
    writeTestCsv(csvPath)

    const parsed = await parseFinanceFile(csvPath, watchRoot)

    expect(parsed?.account?.institution).toBe('USAA')
    expect(parsed?.account?.sourceFile).toBe('statement.csv')
  })

  it('ignores noise-word folders when trying directory-based account detection', async () => {
    const watchRoot = mkdtempSync(join(tmpdir(), 'compass-finance-test-'))
    const csvPath = join(watchRoot, 'statements', 'statement.csv')
    writeTestCsv(csvPath)

    const parsed = await parseFinanceFile(csvPath, watchRoot)

    expect(parsed?.account).toBeUndefined()
  })
})
