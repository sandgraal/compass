/**
 * Unit tests for finance.ts helpers — specifically the sub-folder routing
 * introduced in Phase 4 round 2: `getAccountHintFromPath` and the directory-
 * based institution hint that extends `detectAccount`.
 *
 * Because `detectAccount` is a private function we exercise the directory hint
 * through the public `parseFinanceFile` API (which threads watchRoot through)
 * using minimal synthetic CSV fixtures, plus we test `getAccountHintFromPath`
 * directly since it is exported.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAccountHintFromPath, parseFinanceFile } from './finance'

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
