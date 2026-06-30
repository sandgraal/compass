import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addGoal,
  buildGoalsSummary,
  computeGoalProgress,
  deleteGoal,
  listGoals,
  updateGoal
} from './finance-goals'

function goal(over: Partial<Parameters<typeof computeGoalProgress>[0]> = {}) {
  return {
    id: 1,
    name: 'Goal',
    category: 'other',
    source: 'manual',
    targetAmount: 10_000,
    targetDate: null as string | null,
    monthlyContribution: 0,
    notes: null as string | null,
    ...over
  }
}

describe('computeGoalProgress', () => {
  it('computes remaining + pct and flags reached', () => {
    const p = computeGoalProgress(goal({ targetAmount: 10_000 }), 7_500, '2026-01-01')
    expect(p.remaining).toBe(2_500)
    expect(p.pct).toBe(0.75)
    expect(p.reached).toBe(false)
    expect(p.status).toBe('no-date')

    const done = computeGoalProgress(goal({ targetAmount: 10_000 }), 10_000, '2026-01-01')
    expect(done.reached).toBe(true)
    expect(done.remaining).toBe(0)
    expect(done.status).toBe('reached')
  })

  it('is on-track when the contribution covers the required monthly', () => {
    // ~24 months to target, remaining 24k → required ≈ $1,000/mo.
    const p = computeGoalProgress(
      goal({ targetAmount: 24_000, targetDate: '2028-01-01', monthlyContribution: 1_200 }),
      0,
      '2026-01-01'
    )
    expect(p.requiredMonthly).toBeCloseTo(1_000, -1) // ~1000 (month-fraction tolerant)
    expect(p.onTrack).toBe(true)
    expect(p.status).toBe('on-track')
    expect(p.projectedMonths).toBe(20) // 24000 / 1200
  })

  it('is behind when the contribution is short', () => {
    const p = computeGoalProgress(
      goal({ targetAmount: 24_000, targetDate: '2028-01-01', monthlyContribution: 500 }),
      0,
      '2026-01-01'
    )
    expect(p.onTrack).toBe(false)
    expect(p.status).toBe('behind')
  })

  it('treats a past-due date as needing the full remainder now', () => {
    const p = computeGoalProgress(
      goal({ targetAmount: 10_000, targetDate: '2025-01-01', monthlyContribution: 100 }),
      4_000,
      '2026-01-01'
    )
    expect(p.requiredMonthly).toBe(6_000) // whole remainder
    expect(p.status).toBe('behind')
  })
})

// ─── DB layer ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, base TEXT NOT NULL,
      quote TEXT NOT NULL, rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', asset_class TEXT NOT NULL DEFAULT 'spending'
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL, balance REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      geo TEXT NOT NULL DEFAULT 'US', purpose TEXT
    );
    CREATE TABLE financial_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
      target_amount REAL NOT NULL DEFAULT 0, target_date TEXT, source TEXT NOT NULL DEFAULT 'manual',
      manual_current REAL NOT NULL DEFAULT 0, monthly_contribution REAL NOT NULL DEFAULT 0,
      notes TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('goals CRUD', () => {
  it('adds, lists, updates, and deletes', () => {
    const id = addGoal(sqlite, {
      name: 'Emergency fund',
      targetAmount: 20_000,
      manualCurrent: 5_000
    })
    expect(listGoals(sqlite)).toHaveLength(1)
    updateGoal(sqlite, id, { manualCurrent: 8_000, monthlyContribution: 500 })
    const row = listGoals(sqlite)[0]
    expect(row.manual_current).toBe(8_000)
    expect(row.monthly_contribution).toBe(500)
    deleteGoal(sqlite, id)
    expect(listGoals(sqlite)).toHaveLength(0)
  })
})

describe('buildGoalsSummary', () => {
  function addAccount(name: string, assetClass: string, balance: number): void {
    const info = sqlite
      .prepare('INSERT INTO finance_accounts (name, asset_class) VALUES (?, ?)')
      .run(name, assetClass)
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (?, ?, ?)'
      )
      .run(Number(info.lastInsertRowid), Date.now(), balance)
  }

  it('resolves manual + auto-linked currents (net worth / retirement / property)', () => {
    addAccount('401k', 'retirement', 300_000)
    addAccount('Savings', 'savings', 50_000)
    addAccount('Card', 'liability', 0)
    // CR capex → property cost basis $40k.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, tax_tag) VALUES ('2024-04-01', -40000, 'tax:capex-airbnb')"
      )
      .run()

    addGoal(sqlite, {
      name: 'Reserve',
      source: 'manual',
      targetAmount: 10_000,
      manualCurrent: 6_000
    })
    addGoal(sqlite, { name: 'Retire #', source: 'retirement', targetAmount: 1_000_000 })
    addGoal(sqlite, { name: 'Net worth', source: 'net-worth', targetAmount: 500_000 })
    addGoal(sqlite, { name: 'Build basis', source: 'property-basis', targetAmount: 100_000 })

    const summary = buildGoalsSummary(sqlite, '2026-01-01')
    expect(summary.baseCurrency).toBe('USD')
    const by = (n: string) => summary.goals.find((g) => g.name === n)
    expect(by('Reserve')?.current).toBe(6_000)
    expect(by('Retire #')?.current).toBe(350_000) // retirement 300k + savings 50k
    expect(by('Net worth')?.current).toBe(350_000) // assets 350k, no liabilities
    expect(by('Build basis')?.current).toBe(40_000) // property cost basis
    expect(summary.totals.target).toBe(1_610_000)
  })
})
