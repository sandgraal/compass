/**
 * Tests for the finance:* business-logic QUERY handlers (Phase 6.1 — P1, chunk 2 of 3).
 *
 * Chunk 1 (`finance.test.ts`) covered the pure CRUD handlers. This file covers
 * the read handlers that compute something — the ones with real logic worth
 * locking down:
 *
 *   - finance:get-debt-summary      → avalanche projection (highest-APR-first,
 *                                       interest accrual, payoff to ~0)
 *   - finance:get-geo-summary       → geo/purpose aggregation, Transfers/Cash +
 *                                       income exclusion, `since` validation, crCapex
 *   - finance:get-tax-summary       → per-tag totals for a tax year, year clamp,
 *                                       default-to-current-year
 *   - finance:get-upcoming-payments → debt due-date window filter, daysRemaining,
 *                                       sort, daysAhead clamp
 *   - finance:get-budget-status     → actual-vs-planned (expenses only, skip
 *                                       Transfers), variance, pct, totals
 *
 * Out of scope here (thin pass-throughs to separately-tested modules): the
 * net-worth handlers (`finance-snapshot.ts`), `get-subscriptions`
 * (`auditSubscriptions`), and `get-forecast` (`buildForecast`) — the handler
 * is a one-line delegate; the logic and its tests live in those modules.
 * Chunk 3 covers the file-I/O + watcher handlers.
 *
 * Same strategy as chunk 1: real in-memory SQLite via better-sqlite3 + drizzle.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

// registerFinanceHandlers does mkdirSync at the top; stub fs so it never
// touches the real disk. The query handlers under test do no file I/O.
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

// save-rule/delete-rule schedule a background reapply via setImmediate; we
// never invoke them here, but neutralize it so nothing fires against a closed
// DB after a test ends.
const realSetImmediate = global.setImmediate
beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: minimal global stub
  ;(global as any).setImmediate = (_: () => void) => undefined as unknown as NodeJS.Immediate
})
afterEach(() => {
  global.setImmediate = realSetImmediate
})

// ── Schema slice ─────────────────────────────────────────────────────────────

function createSchema(): void {
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      updated_at INTEGER,
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      plaid_item_id INTEGER,
      plaid_account_id TEXT,
      mask TEXT
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      account_id INTEGER REFERENCES finance_accounts(id),
      category TEXT DEFAULT 'Uncategorized',
      subcategory TEXT,
      notes TEXT,
      source_file TEXT,
      ingested_at INTEGER,
      geo TEXT NOT NULL DEFAULT 'US',
      purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER
    );
    CREATE TABLE budget_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      subcategory TEXT,
      monthly_amount REAL NOT NULL DEFAULT 0,
      updated_at INTEGER
    );
  `)
}

// ── Fake IpcMain + invoke helper ─────────────────────────────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./finance')
  mod.registerFinanceHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  createSchema()
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedAccount(
  name: string,
  opts: {
    isDebt?: boolean
    type?: string
    balance?: number
    apr?: number
    minPayment?: number
    institution?: string
    paymentDueDate?: string | null
  } = {}
): number {
  const info = sqlite
    .prepare(
      `INSERT INTO finance_accounts
         (name, type, is_debt, balance, apr, min_payment, institution, payment_due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      opts.type ?? (opts.isDebt ? 'credit' : 'checking'),
      opts.isDebt ? 1 : 0,
      opts.balance ?? 0,
      opts.apr ?? 0,
      opts.minPayment ?? 0,
      opts.institution ?? '',
      opts.paymentDueDate ?? null
    )
  return Number(info.lastInsertRowid)
}

let txnSeq = 0
function seedTxn(over: {
  amount: number
  date?: string
  description?: string
  category?: string | null
  subcategory?: string | null
  geo?: string
  purpose?: string | null
  taxTag?: string
  taxYear?: number | null
}): number {
  txnSeq++
  const info = sqlite
    .prepare(
      `INSERT INTO finance_transactions
         (hash, date, amount, description, category, subcategory, geo, purpose, tax_tag, tax_year)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `hash-${txnSeq}`,
      over.date ?? '2026-05-01',
      over.amount,
      over.description ?? 'txn',
      over.category === undefined ? 'Uncategorized' : over.category,
      over.subcategory ?? null,
      over.geo ?? 'US',
      over.purpose ?? null,
      over.taxTag ?? 'tax:none',
      over.taxYear ?? null
    )
  return Number(info.lastInsertRowid)
}

function seedBudget(category: string, monthlyAmount: number, subcategory?: string): void {
  sqlite
    .prepare('INSERT INTO budget_rules (category, subcategory, monthly_amount) VALUES (?, ?, ?)')
    .run(category, subcategory ?? null, monthlyAmount)
}

beforeEach(() => {
  txnSeq = 0
})

// ── finance:get-debt-summary ─────────────────────────────────────────────────

describe('finance:get-debt-summary', () => {
  it('returns the debt rows plus an empty projection when there are no debts', async () => {
    seedAccount('Checking', { isDebt: false, balance: 1000 })
    const h = await registerAndGet('finance:get-debt-summary')
    const out = (await invoke(h)) as { debts: unknown[]; projection: unknown[] }
    expect(out.debts).toHaveLength(0)
    expect(out.projection).toEqual([])
  })

  it('projects a balance that strictly decreases toward payoff', async () => {
    seedAccount('Card A', { isDebt: true, balance: 2000, apr: 0.2, minPayment: 50 })
    const h = await registerAndGet('finance:get-debt-summary')
    const out = (await invoke(h)) as {
      debts: unknown[]
      projection: { month: number; balance: number }[]
    }
    expect(out.debts).toHaveLength(1)
    expect(out.projection.length).toBeGreaterThan(0)
    // First month's balance is below the starting principal, last reaches 0.
    expect(out.projection[0].balance).toBeLessThan(2000)
    expect(out.projection.at(-1)?.balance).toBe(0)
    // Monotonic non-increasing.
    for (let i = 1; i < out.projection.length; i++) {
      expect(out.projection[i].balance).toBeLessThanOrEqual(out.projection[i - 1].balance)
    }
  })

  it('skips debts with a zero/negative balance', async () => {
    seedAccount('Paid-off card', { isDebt: true, balance: 0, apr: 0.3, minPayment: 25 })
    const h = await registerAndGet('finance:get-debt-summary')
    const out = (await invoke(h)) as { debts: unknown[]; projection: unknown[] }
    expect(out.debts).toHaveLength(1) // still reported as a debt account
    expect(out.projection).toEqual([]) // but nothing to pay down
  })
})

// ── finance:get-geo-summary ──────────────────────────────────────────────────

describe('finance:get-geo-summary', () => {
  it('aggregates expenses by geo, excluding income, Transfers, and Cash', async () => {
    seedTxn({ amount: -100, geo: 'US', category: 'Groceries' })
    seedTxn({ amount: -50, geo: 'US', category: 'Dining' })
    seedTxn({ amount: -200, geo: 'CR', category: 'Lodging' })
    seedTxn({ amount: 5000, geo: 'US', category: 'Salary' }) // income → excluded (positive)
    seedTxn({ amount: -999, geo: 'US', category: 'Transfers' }) // excluded
    seedTxn({ amount: -888, geo: 'US', category: 'Cash' }) // excluded

    const h = await registerAndGet('finance:get-geo-summary')
    const out = (await invoke(h)) as {
      geo: { name: string; amount: number; count: number }[]
      crCapex: number
    }
    const byGeo = Object.fromEntries(out.geo.map((g) => [g.name, g]))
    expect(byGeo.US.amount).toBe(150) // 100 + 50, sign-flipped to positive
    expect(byGeo.US.count).toBe(2)
    expect(byGeo.CR.amount).toBe(200)
  })

  it('breaks CR purpose down and surfaces crCapex', async () => {
    seedTxn({ amount: -300, geo: 'CR', purpose: 'capex', category: 'Home' })
    seedTxn({ amount: -100, geo: 'CR', purpose: 'living', category: 'Food' })
    seedTxn({ amount: -75, geo: 'US', purpose: 'capex', category: 'Home' }) // not CR → ignored for purpose

    const h = await registerAndGet('finance:get-geo-summary')
    const out = (await invoke(h)) as {
      purpose: { name: string; amount: number }[]
      crCapex: number
    }
    const byPurpose = Object.fromEntries(out.purpose.map((p) => [p.name, p.amount]))
    expect(byPurpose.capex).toBe(300)
    expect(byPurpose.living).toBe(100)
    expect(out.crCapex).toBe(300)
  })

  it('applies a valid `since` cutoff and echoes it back', async () => {
    seedTxn({ amount: -100, geo: 'US', date: '2026-01-01' })
    seedTxn({ amount: -40, geo: 'US', date: '2026-05-01' })
    const h = await registerAndGet('finance:get-geo-summary')
    const out = (await invoke(h, { since: '2026-03-01' })) as {
      geo: { name: string; amount: number }[]
      since: string | null
    }
    expect(out.since).toBe('2026-03-01')
    expect(out.geo.find((g) => g.name === 'US')?.amount).toBe(40) // only the May txn
  })

  it('rejects a malformed `since` date', async () => {
    const h = await registerAndGet('finance:get-geo-summary')
    await expect(invoke(h, { since: 'not-a-date' })).rejects.toThrow(/Invalid since date/)
  })
})

// ── finance:get-tax-summary ──────────────────────────────────────────────────

describe('finance:get-tax-summary', () => {
  it('groups by tax tag and signs the totals for the requested year', async () => {
    seedTxn({ amount: -500, taxTag: 'tax:capex-airbnb', taxYear: 2025 })
    seedTxn({ amount: -250, taxTag: 'tax:capex-airbnb', taxYear: 2025 })
    seedTxn({ amount: 1200, taxTag: 'tax:schedule-c-income', taxYear: 2025 })
    seedTxn({ amount: -9999, taxTag: 'tax:capex-airbnb', taxYear: 2024 }) // other year → excluded

    const h = await registerAndGet('finance:get-tax-summary')
    const out = (await invoke(h, { year: 2025 })) as {
      year: number
      tags: { taxTag: string; count: number; total: number }[]
    }
    expect(out.year).toBe(2025)
    const byTag = Object.fromEntries(out.tags.map((t) => [t.taxTag, t]))
    expect(byTag['tax:capex-airbnb']).toEqual({
      taxTag: 'tax:capex-airbnb',
      count: 2,
      total: -750
    })
    expect(byTag['tax:schedule-c-income'].total).toBe(1200)
  })

  it('clamps an out-of-range year into the supported window', async () => {
    const h = await registerAndGet('finance:get-tax-summary')
    const out = (await invoke(h, { year: 99999 })) as { year: number }
    expect(out.year).toBe(2100)
  })

  it('defaults to the current calendar year when none is given', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-07-15T12:00:00Z'))
    const h = await registerAndGet('finance:get-tax-summary')
    const out = (await invoke(h)) as { year: number }
    expect(out.year).toBe(2027)
  })
})

// ── finance:get-upcoming-payments ────────────────────────────────────────────

describe('finance:get-upcoming-payments', () => {
  it('returns only debts whose due date falls within the window, sorted by date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T08:00:00'))
    seedAccount('Card A', {
      isDebt: true,
      paymentDueDate: '2026-05-15',
      minPayment: 30,
      balance: 900
    })
    seedAccount('Card B', {
      isDebt: true,
      paymentDueDate: '2026-05-12',
      minPayment: 40,
      balance: 400
    })
    seedAccount('Card C', { isDebt: true, paymentDueDate: '2026-06-30' }) // outside 14-day window
    seedAccount('Checking', { isDebt: false, paymentDueDate: '2026-05-13' }) // not a debt

    const h = await registerAndGet('finance:get-upcoming-payments')
    const out = (await invoke(h)) as Array<{ name: string; daysRemaining: number }>
    expect(out.map((p) => p.name)).toEqual(['Card B', 'Card A']) // sorted by due date
    expect(out[0].daysRemaining).toBe(2) // 05-12 minus 05-10
    expect(out[1].daysRemaining).toBe(5)
  })

  it('ignores debts with no payment due date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T08:00:00'))
    seedAccount('No-due-date card', { isDebt: true, paymentDueDate: null, minPayment: 30 })
    const h = await registerAndGet('finance:get-upcoming-payments')
    expect(await invoke(h)).toEqual([])
  })

  it('clamps a negative daysAhead to zero (only today-or-earlier due dates qualify)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T08:00:00'))
    seedAccount('Due tomorrow', { isDebt: true, paymentDueDate: '2026-05-11' })
    const h = await registerAndGet('finance:get-upcoming-payments')
    const out = (await invoke(h, -5)) as unknown[]
    expect(out).toEqual([]) // window collapses to today; tomorrow is excluded
  })
})

// ── finance:get-budget-status ────────────────────────────────────────────────

describe('finance:get-budget-status', () => {
  it('computes actual-vs-planned per line with variance and pct', async () => {
    seedBudget('Groceries', 400)
    seedBudget('Dining', 200)
    // May expenses
    seedTxn({ amount: -150, category: 'Groceries', date: '2026-05-03' })
    seedTxn({ amount: -100, category: 'Groceries', date: '2026-05-20' })
    seedTxn({ amount: -250, category: 'Dining', date: '2026-05-10' }) // over budget

    const h = await registerAndGet('finance:get-budget-status')
    const out = (await invoke(h, '2026-05')) as {
      lines: Array<{ category: string; actual: number; variance: number; pct: number }>
      totals: { budgeted: number; actual: number }
    }
    const byCat = Object.fromEntries(out.lines.map((l) => [l.category, l]))
    expect(byCat.Groceries.actual).toBe(250)
    expect(byCat.Groceries.variance).toBe(150)
    expect(byCat.Groceries.pct).toBeCloseTo(0.625)
    expect(byCat.Dining.actual).toBe(250)
    expect(byCat.Dining.variance).toBe(-50) // over budget → negative
    expect(out.totals).toEqual({ budgeted: 600, actual: 500 })
  })

  it('counts expenses only, skips Transfers, and ignores txns outside the month', async () => {
    seedBudget('Groceries', 400)
    seedTxn({ amount: -100, category: 'Groceries', date: '2026-05-05' })
    seedTxn({ amount: 999, category: 'Groceries', date: '2026-05-06' }) // income (positive) → skip
    seedTxn({ amount: -500, category: 'Transfers', date: '2026-05-07' }) // transfer → skip
    seedTxn({ amount: -77, category: 'Groceries', date: '2026-04-30' }) // prior month → skip
    seedTxn({ amount: -88, category: 'Groceries', date: '2026-06-01' }) // next month → skip

    const h = await registerAndGet('finance:get-budget-status')
    const out = (await invoke(h, '2026-05')) as {
      lines: Array<{ category: string; actual: number }>
    }
    expect(out.lines.find((l) => l.category === 'Groceries')?.actual).toBe(100)
  })
})
