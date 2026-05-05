/**
 * Finance markdown writers — same shape as electron/knowledge/extractor.ts.
 * Called after each ingest to keep the human-readable knowledge-base files in
 * sync with the underlying SQLite tables.
 *
 * Files written:
 *   profile/finances.md          — overview (accounts, snapshot, debt+budget summaries)
 *   profile/finances-debt.md     — full per-card payoff plan
 *   profile/finances-monthly.md  — current-month budget vs actual
 *
 * No PII / account numbers. Those live in the Vault. Markdown is for
 * the humans (you, future-you) and the LLM context window.
 */

import { format } from 'date-fns'
import { KNOWLEDGE_DIR } from '../paths'
import { updateKnowledgeFile } from './writer'
// import { financeAccounts, financeTransactions, financeDebts, financeBudgetLines } from '../db/schema'
// import { getDb } from '../db/client'

const fmtMoney = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—'
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const fmtPct = (x: number | null | undefined, dp = 1): string => {
  if (x === null || x === undefined) return '—'
  return (x * 100).toFixed(dp) + '%'
}

type Account = { name: string; type: string; institution: string; active?: boolean; notes?: string | null }
type Txn = { date: string; amount: number; description: string; category: string; subcategory?: string | null }
type Debt = { name: string; balance: number; apr: number; minPayment: number }
type BudgetLine = { category: string; subcategory?: string | null; monthlyAmount: number }

export interface FinanceSnapshot {
  accounts: Account[]
  transactions: Txn[]      // ALL transactions, this writer figures out the latest month
  debts: Debt[]
  budget: BudgetLine[]
  monthlyTakeHome?: number
  monthlyDebtTarget?: number
}

// ----- profile/finances.md -----

export function writeFinancesOverview(s: FinanceSnapshot): void {
  const stamp = new Date().toLocaleString()
  const lines: string[] = [
    '# Financial Overview',
    '',
    `> Auto-updated by Compass — ${stamp}.`,
    '> Account numbers and credentials live in the **Vault** (financial category).',
    '',
    '## Accounts',
    '',
  ]

  if (s.accounts.length) {
    lines.push('| Account | Type | Institution | Notes |', '|---|---|---|---|')
    for (const a of s.accounts) {
      lines.push(`| ${a.name} | ${a.type} | ${a.institution} | ${a.notes ?? ''} |`)
    }
  } else {
    lines.push('_No accounts registered yet._')
  }
  lines.push('')

  // Latest-month snapshot
  if (s.transactions.length) {
    const latest = s.transactions.reduce((max, t) => t.date > max ? t.date : max, '')
    const cm = latest.slice(0, 7)
    const inCm = s.transactions.filter(t => t.date.startsWith(cm))
    const income = inCm.filter(t => t.amount > 0 && t.category !== 'Transfers').reduce((a, t) => a + t.amount, 0)
    const expense = -inCm.filter(t => t.amount < 0 && t.category !== 'Transfers').reduce((a, t) => a + t.amount, 0)
    const net = income - expense
    const rate = income > 0 ? net / income : 0

    lines.push(
      `## Snapshot — ${cm}`, '',
      `- **Take-home this month:** ${fmtMoney(income)}`,
      `- **Spent this month:** ${fmtMoney(expense)}`,
      `- **Net:** ${fmtMoney(net)} (${fmtPct(rate)} savings rate)`,
      `- **Transaction count:** ${inCm.length}`,
      '',
    )
  }

  // Debt summary
  if (s.debts.length) {
    const total = s.debts.reduce((a, d) => a + d.balance, 0)
    const weightedApr = s.debts.reduce((a, d) => a + d.balance * d.apr, 0) / total
    lines.push(
      '## Debt status', '',
      `- **Total balance:** ${fmtMoney(total)}`,
      `- **Weighted APR:** ${fmtPct(weightedApr, 2)}`,
      '', 'See [Debt detail](finances-debt.md) for the per-card payoff plan.', '',
    )
  }

  // Budget summary
  if (s.budget.length) {
    const budgeted = s.budget.reduce((a, b) => a + b.monthlyAmount, 0)
    lines.push(
      '## Budget — current month', '',
      `- **Total monthly budget:** ${fmtMoney(budgeted)}`,
      s.monthlyTakeHome ? `- **Take-home pay:** ${fmtMoney(s.monthlyTakeHome)}` : '',
      s.monthlyDebtTarget ? `- **Target debt payment:** ${fmtMoney(s.monthlyDebtTarget)}` : '',
      '', 'See [Monthly budget](finances-monthly.md) for the full breakdown.', '',
    )
  }

  updateKnowledgeFile(KNOWLEDGE_DIR, 'profile/finances.md', lines.filter(x => x !== '').join('\n') + '\n')
}

// ----- profile/finances-debt.md -----

export function writeFinancesDebt(s: FinanceSnapshot): void {
  const stamp = new Date().toLocaleString()
  if (!s.debts.length) {
    updateKnowledgeFile(KNOWLEDGE_DIR, 'profile/finances-debt.md',
      `# Debt Detail\n\n> Auto-updated — ${stamp}.\n\n_No debts registered._\n`)
    return
  }
  const sorted = [...s.debts].sort((a, b) => b.apr - a.apr)
  const total = sorted.reduce((a, d) => a + d.balance, 0)
  const wapr = sorted.reduce((a, d) => a + d.balance * d.apr, 0) / total

  const lines = [
    '# Debt Detail', '',
    `> Auto-updated — ${stamp}.`,
    `> Strategy: **avalanche** (highest APR first).`,
    '',
    `**Total:** ${fmtMoney(total)}  ·  **Weighted APR:** ${fmtPct(wapr, 2)}`,
    '',
    '## Payoff order',
    '',
    '| # | Card | Balance | APR | Min payment |',
    '|---|---|---|---|---|',
    ...sorted.map((d, i) => `| ${i + 1} | ${d.name} | ${fmtMoney(d.balance)} | ${fmtPct(d.apr, 2)} | ${fmtMoney(d.minPayment)} |`),
    '',
  ]
  updateKnowledgeFile(KNOWLEDGE_DIR, 'profile/finances-debt.md', lines.join('\n') + '\n')
}

// ----- profile/finances-monthly.md -----

export function writeFinancesMonthly(s: FinanceSnapshot): void {
  const stamp = new Date().toLocaleString()
  if (!s.budget.length) {
    updateKnowledgeFile(KNOWLEDGE_DIR, 'profile/finances-monthly.md',
      `# Monthly Budget\n\n> Auto-updated — ${stamp}.\n\n_Budget not yet configured._\n`)
    return
  }
  const cm = new Date().toISOString().slice(0, 7)
  const inCm = s.transactions.filter(t => t.date.startsWith(cm) && t.amount < 0 && t.category !== 'Transfers')
  const actualByCat: Record<string, number> = {}
  for (const t of inCm) {
    const k = `${t.category}|${t.subcategory ?? ''}`
    actualByCat[k] = (actualByCat[k] || 0) + (-t.amount)
  }

  const rows = s.budget.map(b => {
    const k = `${b.category}|${b.subcategory ?? ''}`
    const actual = actualByCat[k] ?? 0
    return { ...b, actual, variance: b.monthlyAmount - actual, pct: b.monthlyAmount ? actual / b.monthlyAmount : 0 }
  })
  const totalB = rows.reduce((a, r) => a + r.monthlyAmount, 0)
  const totalA = rows.reduce((a, r) => a + r.actual, 0)

  const lines = [
    '# Monthly Budget — Actual vs Plan', '',
    `> Auto-updated — ${stamp}.`,
    '',
    s.monthlyTakeHome ? `- **Take-home pay:** ${fmtMoney(s.monthlyTakeHome)}` : '',
    s.monthlyDebtTarget ? `- **Target debt payment:** ${fmtMoney(s.monthlyDebtTarget)}` : '',
    '',
    '| Category | Subcategory | Budget | Actual | Variance | % used |',
    '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.category} | ${r.subcategory ?? ''} | ${fmtMoney(r.monthlyAmount)} | ${fmtMoney(r.actual)} | ${fmtMoney(r.variance)} | ${fmtPct(r.pct, 0)} |`),
    `| **TOTAL** |  | **${fmtMoney(totalB)}** | **${fmtMoney(totalA)}** | **${fmtMoney(totalB - totalA)}** | **${fmtPct(totalB ? totalA / totalB : 0, 0)}** |`,
    '',
    `**Available to redirect to highest-APR debt this month:** ${fmtMoney(Math.max(0, totalB - totalA))}`,
    '',
  ]
  updateKnowledgeFile(KNOWLEDGE_DIR, 'profile/finances-monthly.md', lines.filter(x => x !== '').join('\n') + '\n')
}

// Convenience: write all three
export function writeAllFinanceKnowledge(s: FinanceSnapshot): void {
  writeFinancesOverview(s)
  writeFinancesDebt(s)
  writeFinancesMonthly(s)
}
