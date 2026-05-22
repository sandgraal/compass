/**
 * Tests for the finance knowledge extractor (Phase 6.2).
 *
 * `finance-extractor.ts` turns a `FinanceSnapshot` into three markdown docs
 * (overview / debt / monthly) via `updateKnowledgeFile`. No live DB — it takes
 * the snapshot as an argument — so we mock `./writer` to capture writes and
 * assert on the generated markdown + math.
 *
 * Coverage focuses on the computed values, not the prose:
 *   - overview: empty-accounts placeholder; latest-month snapshot
 *     (income/expense/net excluding Transfers + savings rate); weighted-APR
 *     debt summary
 *   - debt: empty placeholder; avalanche sort (highest APR first); totals
 *   - monthly: empty-budget placeholder
 *   - writeAllFinanceKnowledge fans out to all three docs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinanceSnapshot } from './finance-extractor'

const { KNOWLEDGE_DIR, writes } = vi.hoisted(() => ({
  KNOWLEDGE_DIR: '/fake/knowledge',
  writes: [] as Array<{ dir: string; relPath: string; content: string }>
}))
vi.mock('../paths', () => ({ KNOWLEDGE_DIR }))
vi.mock('./writer', () => ({
  updateKnowledgeFile: (dir: string, relPath: string, content: string) => {
    writes.push({ dir, relPath, content })
  }
}))

import {
  writeAllFinanceKnowledge,
  writeFinancesDebt,
  writeFinancesMonthly,
  writeFinancesOverview
} from './finance-extractor'

function writeFor(relPath: string) {
  return writes.find((w) => w.relPath === relPath)
}

const EMPTY: FinanceSnapshot = { accounts: [], transactions: [], debts: [], budget: [] }

beforeEach(() => {
  writes.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

// ── overview ─────────────────────────────────────────────────────────────────

describe('writeFinancesOverview', () => {
  it('targets profile/finances.md and shows the no-accounts placeholder when empty', () => {
    writeFinancesOverview(EMPTY)
    const w = writeFor('profile/finances.md')
    expect(w?.dir).toBe(KNOWLEDGE_DIR)
    expect(w?.content).toContain('_No accounts registered yet._')
  })

  it('computes the latest-month snapshot excluding Transfers, with savings rate', () => {
    writeFinancesOverview({
      ...EMPTY,
      transactions: [
        { date: '2026-06-05', amount: 1000, description: 'Paycheck', category: 'Income' },
        { date: '2026-06-10', amount: -600, description: 'Rent', category: 'Housing' },
        // Transfers are excluded from both sides.
        { date: '2026-06-12', amount: 500, description: 'Move money', category: 'Transfers' },
        { date: '2026-06-12', amount: -500, description: 'Move money', category: 'Transfers' },
        // Prior month — excluded by latest-month filter.
        { date: '2026-05-01', amount: 9999, description: 'Old', category: 'Income' }
      ]
    })
    const c = writeFor('profile/finances.md')?.content ?? ''
    expect(c).toContain('## Snapshot — 2026-06')
    expect(c).toContain('**Take-home this month:** $1,000.00')
    expect(c).toContain('**Spent this month:** $600.00')
    // net 400 on income 1000 → 40.0% savings rate
    expect(c).toContain('**Net:** $400.00 (40.0% savings rate)')
    // 2 non-transfer txns counted, but transaction count includes transfers in the month
    expect(c).toContain('**Transaction count:** 4')
  })

  it('summarises debt with a balance-weighted APR', () => {
    writeFinancesOverview({
      ...EMPTY,
      debts: [
        { name: 'Card A', balance: 1000, apr: 0.2, minPayment: 25 },
        { name: 'Card B', balance: 3000, apr: 0.1, minPayment: 60 }
      ]
    })
    const c = writeFor('profile/finances.md')?.content ?? ''
    // weighted APR = (1000*0.2 + 3000*0.1) / 4000 = 0.125 → 12.50%
    expect(c).toContain('**Total balance:** $4,000.00')
    expect(c).toContain('**Weighted APR:** 12.50%')
  })
})

// ── debt ─────────────────────────────────────────────────────────────────────

describe('writeFinancesDebt', () => {
  it('writes the no-debts placeholder when there are none', () => {
    writeFinancesDebt(EMPTY)
    expect(writeFor('profile/finances-debt.md')?.content).toContain('_No debts registered._')
  })

  it('orders the payoff table by APR descending (avalanche)', () => {
    writeFinancesDebt({
      ...EMPTY,
      debts: [
        { name: 'LowAPR', balance: 5000, apr: 0.08, minPayment: 50 },
        { name: 'HighAPR', balance: 1000, apr: 0.27, minPayment: 30 }
      ]
    })
    const c = writeFor('profile/finances-debt.md')?.content ?? ''
    expect(c.indexOf('HighAPR')).toBeLessThan(c.indexOf('LowAPR'))
    expect(c).toContain('| 1 | HighAPR |')
    expect(c).toContain('| 2 | LowAPR |')
  })
})

// ── monthly ──────────────────────────────────────────────────────────────────

describe('writeFinancesMonthly', () => {
  it('writes the not-configured placeholder when budget is empty', () => {
    writeFinancesMonthly(EMPTY)
    expect(writeFor('profile/finances-monthly.md')?.content).toContain(
      '_Budget not yet configured._'
    )
  })
})

// ── fan-out ──────────────────────────────────────────────────────────────────

describe('writeAllFinanceKnowledge', () => {
  it('writes all three finance docs', () => {
    writeAllFinanceKnowledge(EMPTY)
    expect(writeFor('profile/finances.md')).toBeDefined()
    expect(writeFor('profile/finances-debt.md')).toBeDefined()
    expect(writeFor('profile/finances-monthly.md')).toBeDefined()
    expect(writes).toHaveLength(3)
  })
})
