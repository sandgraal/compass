/**
 * Tests for the finance:* IPC handlers (Phase 6.1 — P1, chunk 1 of 3).
 *
 * `electron/ipc/finance.ts` is the largest IPC module in the codebase
 * (33 handlers, 1207 LOC). Splitting the coverage backfill into three
 * focused PRs keeps each one reviewable:
 *
 *   Chunk 1 (THIS PR): pure DB CRUD — accounts, transactions, rules,
 *     tax-tagging. The foundation everything else builds on.
 *   Chunk 2: business-logic queries — get-geo-summary, get-tax-summary,
 *     get-subscriptions, get-budget-status, get-upcoming-payments,
 *     get-net-worth-snapshot, get-net-worth-trajectory, debt summary.
 *   Chunk 3: file I/O + watcher — ingest-folder, export-tax-pack,
 *     capture-snapshot, set-account-balance, reapply-rules, watch
 *     folder controls, ingest-watched-now.
 *
 * Strategy: real in-memory SQLite via better-sqlite3 + drizzle (same
 * pattern as habits/cursor/plaid-sync tests). Mocking drizzle's builder
 * would buy nothing — these handlers are mostly thin DB wrappers and
 * the real SQL semantics are exactly what we want to lock down.
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

// Stub fs so `registerFinanceHandlers`'s top-of-function mkdirSync calls
// don't touch the real disk. The handlers we exercise here don't read or
// write files.
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined
}))

// Stub electron — dialog/BrowserWindow are only touched by the file-I/O
// handlers we skip in this chunk.
vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

// `scheduleReapplyRulesBackground` schedules `reapplyRulesBackground` via
// `setImmediate`. After our test closes the in-memory DB, that callback
// would crash when the bg work tried to read from the closed handle.
// Replace setImmediate with a no-op so the background pass never fires
// during these tests — we're testing the IPC contract, not the
// debounced reapply (which has its own coverage in chunk 3).
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
      currency TEXT NOT NULL DEFAULT 'USD',
      is_foreign INTEGER NOT NULL DEFAULT 0,
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
      mask TEXT,
      simplefin_connection_id INTEGER,
      simplefin_account_id TEXT
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
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
    CREATE TABLE categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority INTEGER DEFAULT 0
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      base TEXT NOT NULL,
      quote TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      fetched_at INTEGER
    );
    CREATE UNIQUE INDEX uq_fx_rates_date_base_quote ON fx_rates (date, base, quote);
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, dedup_hash TEXT NOT NULL UNIQUE
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
  // Match production: `electron/db/client.ts` enables `foreign_keys = ON`
  // so these handler tests run under the same SQLite constraint behavior
  // as the app. Catches future regressions where deletes/updates might
  // start relying on FK enforcement.
  sqlite.pragma('foreign_keys = ON')
  createSchema()
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedAccount(name: string, opts: { isDebt?: boolean; type?: string } = {}): number {
  const info = sqlite
    .prepare('INSERT INTO finance_accounts (name, type, is_debt) VALUES (?, ?, ?)')
    .run(name, opts.type ?? 'checking', opts.isDebt ? 1 : 0)
  return Number(info.lastInsertRowid)
}

function seedTxn(over: {
  hash: string
  date?: string
  amount?: number
  description?: string
  accountId?: number | null
  category?: string
  taxTag?: string
}): number {
  const info = sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, description, account_id, category, tax_tag) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      over.hash,
      over.date ?? '2026-05-01',
      over.amount ?? -10,
      over.description ?? 'test',
      over.accountId ?? null,
      over.category ?? 'Uncategorized',
      over.taxTag ?? 'tax:none'
    )
  return Number(info.lastInsertRowid)
}

function txnRow(id: number):
  | {
      category: string | null
      notes: string | null
      tax_tag: string
      tax_tag_source: string
    }
  | undefined {
  return sqlite
    .prepare(
      'SELECT category, notes, tax_tag, tax_tag_source FROM finance_transactions WHERE id = ?'
    )
    .get(id) as
    | { category: string | null; notes: string | null; tax_tag: string; tax_tag_source: string }
    | undefined
}

// ── finance:get-accounts ─────────────────────────────────────────────────────

describe('finance:get-accounts', () => {
  it('returns all accounts', async () => {
    seedAccount('Chase Checking')
    seedAccount('Amex', { isDebt: true, type: 'credit' })
    const h = await registerAndGet('finance:get-accounts')
    const out = (await invoke(h)) as Array<{ name: string; isDebt: boolean }>
    expect(out).toHaveLength(2)
    const names = out.map((a) => a.name).sort()
    expect(names).toEqual(['Amex', 'Chase Checking'])
  })

  it('returns [] when no accounts exist', async () => {
    const h = await registerAndGet('finance:get-accounts')
    expect(await invoke(h)).toEqual([])
  })
})

// ── finance:upsert-account ───────────────────────────────────────────────────

describe('finance:upsert-account', () => {
  it('inserts a new account with caller-supplied fields', async () => {
    const h = await registerAndGet('finance:upsert-account')
    const out = (await invoke(h, {
      name: 'Wells Fargo',
      type: 'savings',
      apr: 0.04,
      balance: 1000
    })) as { success: boolean; id: number }
    expect(out.success).toBe(true)
    expect(out.id).toBeGreaterThan(0)
    const row = sqlite
      .prepare('SELECT name, type, apr, balance FROM finance_accounts WHERE id = ?')
      .get(out.id) as { name: string; type: string; apr: number; balance: number }
    expect(row.name).toBe('Wells Fargo')
    expect(row.type).toBe('savings')
    expect(row.apr).toBe(0.04)
    expect(row.balance).toBe(1000)
  })

  it('fills sensible defaults when optional fields are omitted', async () => {
    const h = await registerAndGet('finance:upsert-account')
    const out = (await invoke(h, { name: 'Bare', type: 'checking' })) as { id: number }
    const row = sqlite
      .prepare('SELECT is_debt, balance, apr, min_payment FROM finance_accounts WHERE id = ?')
      .get(out.id) as {
      is_debt: number
      balance: number
      apr: number
      min_payment: number
    }
    expect(row.is_debt).toBe(0)
    expect(row.balance).toBe(0)
    expect(row.apr).toBe(0)
    expect(row.min_payment).toBe(0)
  })

  it('updates in place when id is provided (does NOT create a duplicate)', async () => {
    const id = seedAccount('original')
    const h = await registerAndGet('finance:upsert-account')
    const out = (await invoke(h, {
      id,
      name: 'renamed',
      type: 'checking',
      balance: 999
    })) as { success: boolean; id: number }
    expect(out.id).toBe(id)
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM finance_accounts').get() as {
      n: number
    }
    expect(count.n).toBe(1)
    const row = sqlite
      .prepare('SELECT name, balance FROM finance_accounts WHERE id = ?')
      .get(id) as { name: string; balance: number }
    expect(row.name).toBe('renamed')
    expect(row.balance).toBe(999)
  })
})

// ── Multi-currency (Phase 11.1) ──────────────────────────────────────────────

describe('finance:upsert-account currency', () => {
  it('stores a supported currency (normalized) and defaults the rest to USD', async () => {
    const h = await registerAndGet('finance:upsert-account')
    const out = (await invoke(h, { name: 'BAC CR', type: 'checking', currency: 'crc' })) as {
      id: number
    }
    const a = sqlite.prepare('SELECT currency FROM finance_accounts WHERE id = ?').get(out.id) as {
      currency: string
    }
    expect(a.currency).toBe('CRC')

    const def = (await invoke(h, { name: 'Plain', type: 'checking' })) as { id: number }
    const b = sqlite.prepare('SELECT currency FROM finance_accounts WHERE id = ?').get(def.id) as {
      currency: string
    }
    expect(b.currency).toBe('USD')
  })

  it('falls back to USD for an unsupported currency code', async () => {
    const h = await registerAndGet('finance:upsert-account')
    const out = (await invoke(h, { name: 'Weird', type: 'checking', currency: 'XYZ' })) as {
      id: number
    }
    const a = sqlite.prepare('SELECT currency FROM finance_accounts WHERE id = ?').get(out.id) as {
      currency: string
    }
    expect(a.currency).toBe('USD')
  })
})

describe('finance:get-currency-settings', () => {
  it('defaults base to USD and lists supported currencies', async () => {
    const h = await registerAndGet('finance:get-currency-settings')
    const out = (await invoke(h)) as {
      baseCurrency: string
      supported: Array<{ code: string }>
    }
    expect(out.baseCurrency).toBe('USD')
    expect(out.supported.some((c) => c.code === 'CRC')).toBe(true)
    expect(out.supported.some((c) => c.code === 'USD')).toBe(true)
  })
})

describe('finance:set-base-currency', () => {
  it('persists a supported base currency', async () => {
    const h = await registerAndGet('finance:set-base-currency')
    const out = (await invoke(h, 'eur')) as { success: boolean; baseCurrency?: string }
    expect(out.success).toBe(true)
    expect(out.baseCurrency).toBe('EUR')
    const row = sqlite
      .prepare("SELECT value FROM app_settings WHERE key = 'baseCurrency'")
      .get() as { value: string }
    expect(row.value).toBe('EUR')
  })

  it('rejects an unsupported currency', async () => {
    const h = await registerAndGet('finance:set-base-currency')
    const out = (await invoke(h, 'XYZ')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/Unsupported/)
  })
})

describe('finance:set-account-currency', () => {
  it('sets the account currency and cascades to its transactions', async () => {
    const id = seedAccount('BAC CR')
    seedTxn({ hash: 'a', accountId: id })
    seedTxn({ hash: 'b', accountId: id })
    const h = await registerAndGet('finance:set-account-currency')
    const out = (await invoke(h, id, 'CRC')) as {
      success: boolean
      transactionsUpdated?: number
    }
    expect(out.success).toBe(true)
    expect(out.transactionsUpdated).toBe(2)
    const acct = sqlite.prepare('SELECT currency FROM finance_accounts WHERE id = ?').get(id) as {
      currency: string
    }
    expect(acct.currency).toBe('CRC')
    const txnCurrencies = sqlite
      .prepare('SELECT DISTINCT currency FROM finance_transactions WHERE account_id = ?')
      .all(id) as Array<{ currency: string }>
    expect(txnCurrencies).toEqual([{ currency: 'CRC' }])
  })

  it('rejects a missing account and an unsupported currency', async () => {
    const h = await registerAndGet('finance:set-account-currency')
    expect((await invoke(h, 999, 'CRC')) as { success: boolean }).toMatchObject({
      success: false
    })
    const id = seedAccount('Chase')
    expect((await invoke(h, id, 'XYZ')) as { success: boolean }).toMatchObject({
      success: false
    })
  })
})

describe('finance:set-fx-rate + finance:get-fx-rates', () => {
  it('records a manual rate and reads it back', async () => {
    const set = await registerAndGet('finance:set-fx-rate')
    const out = (await invoke(set, {
      date: '2026-06-27',
      base: 'usd',
      quote: 'crc',
      rate: 512.3
    })) as { success: boolean }
    expect(out.success).toBe(true)

    const get = await registerAndGet('finance:get-fx-rates')
    const rows = (await invoke(get)) as Array<{
      base: string
      quote: string
      rate: number
      fetchedAt: number | null
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ base: 'USD', quote: 'CRC', rate: 512.3 })
    // `fetchedAt` must cross the wire as epoch ms (number), not a Drizzle Date.
    expect(typeof rows[0].fetchedAt).toBe('number')
  })

  it('upserts the same (date, base, quote) in place', async () => {
    const set = await registerAndGet('finance:set-fx-rate')
    await invoke(set, { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 500 })
    await invoke(set, { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 512.3 })
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('rejects bad dates, unsupported currencies, equal pairs, and bad rates', async () => {
    const set = await registerAndGet('finance:set-fx-rate')
    const bad = [
      { date: 'nope', base: 'USD', quote: 'CRC', rate: 500 },
      { date: '2026-06-27', base: 'USD', quote: 'XYZ', rate: 500 },
      { date: '2026-06-27', base: 'USD', quote: 'USD', rate: 1 },
      { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 0 },
      { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: Number.POSITIVE_INFINITY }
    ]
    for (const input of bad) {
      expect((await invoke(set, input)) as { success: boolean }).toMatchObject({ success: false })
    }
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('finance:refresh-fx-rates', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('fetches + persists provider rates (source=erapi) and reports the count', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: 'success', rates: { USD: 1, CRC: 512.3, EUR: 0.92 } })
    })) as unknown as typeof fetch

    const h = await registerAndGet('finance:refresh-fx-rates')
    const out = (await invoke(h)) as { success: boolean; updated?: number }
    expect(out.success).toBe(true)
    expect(out.updated).toBe(2) // CRC + EUR (USD skipped)
    const rows = sqlite
      .prepare("SELECT quote, source FROM fx_rates WHERE base = 'USD' ORDER BY quote")
      .all() as Array<{ quote: string; source: string }>
    expect(rows.map((r) => r.quote)).toEqual(['CRC', 'EUR'])
    expect(rows.every((r) => r.source === 'erapi')).toBe(true)
  })

  it('returns an error (and writes nothing) when the provider is down', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({})
    })) as unknown as typeof fetch

    const h = await registerAndGet('finance:refresh-fx-rates')
    const out = (await invoke(h)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('finance:property (Phase 11.3)', () => {
  function seedCapex(amount: number, taxTag = 'tax:capex-airbnb'): void {
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (hash, date, amount, description, tax_tag) VALUES (?, '2024-04-01', ?, 'build', ?)"
      )
      .run(`cx-${amount}-${taxTag}`, amount, taxTag)
  }

  it('set-property-config persists + validates, get-property-pnl assembles the basis', async () => {
    seedCapex(-300_000)
    const setCfg = await registerAndGet('finance:set-property-config')
    const cfgOut = (await invoke(setCfg, {
      placedInService: '2024-01-01',
      landValue: 50_000,
      recoveryYears: 30
    })) as { success: boolean; config?: { recoveryYears: number } }
    expect(cfgOut.success).toBe(true)
    expect(cfgOut.config?.recoveryYears).toBe(30)

    const getPnl = await registerAndGet('finance:get-property-pnl')
    const pnl = (await invoke(getPnl)) as {
      baseCurrency: string
      basisToDate: number
      depreciableBasis: number
      depreciation: Array<{ year: number }>
      totals: { capex: number }
    }
    expect(pnl.baseCurrency).toBe('USD')
    expect(pnl.totals.capex).toBe(300_000)
    expect(pnl.basisToDate).toBe(300_000)
    expect(pnl.depreciableBasis).toBe(250_000) // 300k - 50k land
    expect(pnl.depreciation[0].year).toBe(2024)
  })

  it('rejects a bad placed-in-service date and out-of-range values', async () => {
    const setCfg = await registerAndGet('finance:set-property-config')
    expect(
      (await invoke(setCfg, { placedInService: '04/01/2024' })) as { success: boolean }
    ).toMatchObject({ success: false })
    expect((await invoke(setCfg, { recoveryYears: 0 })) as { success: boolean }).toMatchObject({
      success: false
    })
    expect((await invoke(setCfg, { landValue: -5 })) as { success: boolean }).toMatchObject({
      success: false
    })
  })

  it('treats a null / non-object payload as a no-op instead of crashing', async () => {
    const setCfg = await registerAndGet('finance:set-property-config')
    // A null/undefined/non-object IPC payload must not throw on the `in` checks.
    for (const bad of [null, undefined, 'nope', 42]) {
      const out = (await invoke(setCfg, bad)) as { success: boolean; config?: unknown }
      expect(out.success).toBe(true)
      expect(out.config).toBeDefined()
    }
  })

  it('clears the basis override with null', async () => {
    const setCfg = await registerAndGet('finance:set-property-config')
    await invoke(setCfg, { basisOverride: 400_000 })
    let cfg = (await invoke(setCfg, {})) as { config?: { basisOverride: number | null } }
    expect(cfg.config?.basisOverride).toBe(400_000)
    await invoke(setCfg, { basisOverride: null })
    cfg = (await invoke(setCfg, {})) as { config?: { basisOverride: number | null } }
    expect(cfg.config?.basisOverride).toBeNull()
  })
})

describe('finance:expat-tax (Phase 11.2)', () => {
  it('set-account-foreign toggles the flag + validates the account', async () => {
    const id = seedAccount('BAC CR')
    const h = await registerAndGet('finance:set-account-foreign')
    const out = (await invoke(h, id, true)) as { success: boolean; isForeign?: boolean }
    expect(out.success).toBe(true)
    expect(out.isForeign).toBe(true)
    const row = sqlite.prepare('SELECT is_foreign FROM finance_accounts WHERE id = ?').get(id) as {
      is_foreign: number
    }
    expect(row.is_foreign).toBe(1)
    expect((await invoke(h, 999, true)) as { success: boolean }).toMatchObject({ success: false })
    // Untrusted IPC: a non-boolean (e.g. the string 'false') must be rejected,
    // not coerced via Boolean('false') === true.
    expect((await invoke(h, id, 'false')) as { success: boolean }).toMatchObject({ success: false })
    const after = sqlite
      .prepare('SELECT is_foreign FROM finance_accounts WHERE id = ?')
      .get(id) as { is_foreign: number }
    expect(after.is_foreign).toBe(1) // unchanged by the rejected call
  })

  it('set-fatca-threshold persists + rejects junk', async () => {
    const h = await registerAndGet('finance:set-fatca-threshold')
    expect((await invoke(h, 200_000)) as { success: boolean }).toMatchObject({ success: true })
    const row = sqlite
      .prepare("SELECT value FROM app_settings WHERE key = 'fatcaThresholdUsd'")
      .get() as { value: string }
    expect(row.value).toBe('200000')
    expect((await invoke(h, -1)) as { success: boolean }).toMatchObject({ success: false })
  })

  it('get-expat-tax-summary assembles FBAR from foreign-account snapshots', async () => {
    const id = seedAccount('CR Savings')
    sqlite
      .prepare('UPDATE finance_accounts SET is_foreign = 1, currency = ? WHERE id = ?')
      .run('CRC', id)
    sqlite
      .prepare(
        "INSERT INTO fx_rates (date, base, quote, rate) VALUES ('2024-12-31','USD','CRC',500)"
      )
      .run()
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
      )
      .run(id, new Date('2024-07-01T12:00:00').getTime(), 9_000_000, 'manual')

    const h = await registerAndGet('finance:get-expat-tax-summary')
    const summary = (await invoke(h)) as {
      hasForeignAccounts: boolean
      fbar: Array<{ year: number; aggregateMaxUsd: number; exceedsThreshold: boolean }>
    }
    expect(summary.hasForeignAccounts).toBe(true)
    const y2024 = summary.fbar.find((y) => y.year === 2024)
    expect(y2024?.aggregateMaxUsd).toBe(18_000) // ₡9M / 500
    expect(y2024?.exceedsThreshold).toBe(true)
  })
})

describe('finance:retirement (Phase 11.4)', () => {
  it('set-retirement-config persists + validates; get returns baseline + stress', async () => {
    // A retirement account → net-worth starting balance.
    const id = seedAccount('401k')
    sqlite.prepare("UPDATE finance_accounts SET asset_class = 'retirement' WHERE id = ?").run(id)
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
      )
      .run(id, Date.now(), 500_000, 'manual')

    const setCfg = await registerAndGet('finance:set-retirement-config')
    const ok = (await invoke(setCfg, {
      currentAge: 60,
      retirementAge: 65,
      horizonAge: 85,
      ssMonthlyAtFra: 2000,
      annualSpending: 50_000
    })) as { success: boolean }
    expect(ok.success).toBe(true)

    const getProj = await registerAndGet('finance:get-retirement-projection')
    const res = (await invoke(getProj)) as {
      startingAssets: number
      baseline: { rows: unknown[]; ssAnnual: number }
      stress: { endBalance: number }
    }
    expect(res.startingAssets).toBe(500_000) // sourced from net worth
    expect(res.baseline.ssAnnual).toBe(24_000) // 2000/mo at FRA, claimed at FRA
    expect(res.baseline.rows.length).toBe(26) // ages 60..85 inclusive
  })

  it('rejects out-of-range config + a non-object payload', async () => {
    const h = await registerAndGet('finance:set-retirement-config')
    expect((await invoke(h, { ssClaimAge: 80 })) as { success: boolean }).toMatchObject({
      success: false // claim age must be 62-70
    })
    expect((await invoke(h, { realReturnPct: 999 })) as { success: boolean }).toMatchObject({
      success: false
    })
    // A non-object payload is a safe no-op, not a crash.
    expect((await invoke(h, null)) as { success: boolean }).toMatchObject({ success: true })
  })
})

// ── finance:delete-account ───────────────────────────────────────────────────

describe('finance:delete-account', () => {
  it('deletes an account with no transactions', async () => {
    const id = seedAccount('temp')
    const h = await registerAndGet('finance:delete-account')
    const out = (await invoke(h, id)) as { success: boolean }
    expect(out.success).toBe(true)
    const row = sqlite.prepare('SELECT * FROM finance_accounts WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('refuses to delete an account with referenced transactions (count in error)', async () => {
    // Critical safety: blindly deleting an account would orphan its
    // transactions (FK constraint would either cascade or break the
    // ledger). Refusing here forces the user to migrate/delete the
    // txns first, which keeps the books honest.
    const id = seedAccount('with-txns')
    seedTxn({ hash: 'h1', accountId: id })
    seedTxn({ hash: 'h2', accountId: id })
    seedTxn({ hash: 'h3', accountId: id })
    const h = await registerAndGet('finance:delete-account')
    await expect(invoke(h, id)).rejects.toThrow(/3 transactions still reference/)
    // Account still present
    const row = sqlite.prepare('SELECT * FROM finance_accounts WHERE id = ?').get(id)
    expect(row).toBeDefined()
  })

  it('uses singular "transaction" in the error when count is 1', async () => {
    const id = seedAccount('one-txn')
    seedTxn({ hash: 'only', accountId: id })
    const h = await registerAndGet('finance:delete-account')
    await expect(invoke(h, id)).rejects.toThrow(/1 transaction still references it/)
  })
})

// ── finance:delete-transaction ───────────────────────────────────────────────

describe('finance:delete-transaction', () => {
  it('deletes the row', async () => {
    const id = seedTxn({ hash: 'h1' })
    const h = await registerAndGet('finance:delete-transaction')
    const out = (await invoke(h, id)) as { success: boolean }
    expect(out.success).toBe(true)
    expect(txnRow(id)).toBeUndefined()
  })

  it('is idempotent (returns success when id is already gone)', async () => {
    const h = await registerAndGet('finance:delete-transaction')
    const out = (await invoke(h, 99_999)) as { success: boolean }
    expect(out.success).toBe(true)
  })
})

// ── finance:update-transaction ───────────────────────────────────────────────

describe('finance:update-transaction', () => {
  it('partial-updates the named fields, leaves others alone', async () => {
    const id = seedTxn({ hash: 'h1', category: 'Old', taxTag: 'tax:none' })
    const h = await registerAndGet('finance:update-transaction')
    await invoke(h, id, { category: 'New', notes: 'changed' })
    const row = txnRow(id)
    expect(row?.category).toBe('New')
    expect(row?.notes).toBe('changed')
    // tax_tag was NOT in the patch — must remain default
    expect(row?.tax_tag).toBe('tax:none')
  })
})

// ── finance:set-transaction-tax-tag ──────────────────────────────────────────

describe('finance:set-transaction-tax-tag', () => {
  it('updates the tax tag AND marks taxTagSource="user"', async () => {
    // The user-source mark is the load-bearing invariant: it tells the
    // auto-classifier (Phase 4.3 backfillTaxTags) to leave this row
    // alone on future passes. Without it, a re-ingest would silently
    // clobber the user's manual choice.
    const id = seedTxn({ hash: 'h1', taxTag: 'tax:none' })
    const h = await registerAndGet('finance:set-transaction-tax-tag')
    const out = (await invoke(h, id, 'tax:schedule-c-expense')) as { success: boolean }
    expect(out.success).toBe(true)
    const row = txnRow(id)
    expect(row?.tax_tag).toBe('tax:schedule-c-expense')
    expect(row?.tax_tag_source).toBe('user')
  })

  it('rejects an unknown tax tag', async () => {
    const id = seedTxn({ hash: 'h1' })
    const h = await registerAndGet('finance:set-transaction-tax-tag')
    const out = (await invoke(h, id, 'tax:fake-tag')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/Unknown tax tag/)
    // No DB mutation
    expect(txnRow(id)?.tax_tag).toBe('tax:none')
  })

  it('rejects non-integer / non-positive ids', async () => {
    const h = await registerAndGet('finance:set-transaction-tax-tag')
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = (await invoke(h, bad, 'tax:none')) as { success: boolean; error?: string }
      expect(out.success).toBe(false)
      expect(out.error).toMatch(/Invalid transaction id/)
    }
  })

  it('returns error when the row does not exist', async () => {
    const h = await registerAndGet('finance:set-transaction-tax-tag')
    const out = (await invoke(h, 99_999, 'tax:none')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/Transaction not found/)
  })

  it('allows resetting back to tax:none', async () => {
    const id = seedTxn({ hash: 'h1', taxTag: 'tax:schedule-c-income' })
    const h = await registerAndGet('finance:set-transaction-tax-tag')
    const out = (await invoke(h, id, 'tax:none')) as { success: boolean }
    expect(out.success).toBe(true)
    expect(txnRow(id)?.tax_tag).toBe('tax:none')
    // Still marked user-source — the reset itself is a user action.
    expect(txnRow(id)?.tax_tag_source).toBe('user')
  })
})

// ── finance:get-rules ────────────────────────────────────────────────────────

describe('finance:get-rules', () => {
  it('returns [] when no rules exist', async () => {
    const h = await registerAndGet('finance:get-rules')
    expect(await invoke(h)).toEqual([])
  })

  it('returns rules ordered by ascending priority (lower number first)', async () => {
    // Lower priority number = higher precedence in the categorizer.
    // The handler relies on this order so the categorizer can take
    // the first matching pattern. Lock it.
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category, priority) VALUES (?, ?, ?)')
      .run('zzz', 'Z', 10)
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category, priority) VALUES (?, ?, ?)')
      .run('aaa', 'A', 1)
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category, priority) VALUES (?, ?, ?)')
      .run('mmm', 'M', 5)
    const h = await registerAndGet('finance:get-rules')
    const out = (await invoke(h)) as Array<{ pattern: string; priority: number }>
    expect(out.map((r) => r.priority)).toEqual([1, 5, 10])
    expect(out.map((r) => r.pattern)).toEqual(['aaa', 'mmm', 'zzz'])
  })
})

// ── finance:save-rule ────────────────────────────────────────────────────────

describe('finance:save-rule', () => {
  it('inserts a new rule', async () => {
    const h = await registerAndGet('finance:save-rule')
    const out = (await invoke(h, {
      pattern: 'starbucks',
      category: 'Food & Drink',
      subcategory: 'Coffee'
    })) as { success: boolean }
    expect(out.success).toBe(true)
    const row = sqlite
      .prepare('SELECT pattern, category, subcategory FROM categorization_rules')
      .get() as { pattern: string; category: string; subcategory: string }
    expect(row.pattern).toBe('starbucks')
    expect(row.category).toBe('Food & Drink')
    expect(row.subcategory).toBe('Coffee')
  })

  it('updates an existing rule when id is provided (no duplicate row)', async () => {
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category) VALUES (?, ?)')
      .run('old', 'A')
    const id = Number(
      (sqlite.prepare('SELECT id FROM categorization_rules').get() as { id: number }).id
    )
    const h = await registerAndGet('finance:save-rule')
    await invoke(h, { id, pattern: 'new', category: 'B' })
    const rows = sqlite
      .prepare('SELECT pattern, category FROM categorization_rules')
      .all() as Array<{ pattern: string; category: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].pattern).toBe('new')
    expect(rows[0].category).toBe('B')
  })

  it('defaults priority to 0 when omitted', async () => {
    const h = await registerAndGet('finance:save-rule')
    await invoke(h, { pattern: 'x', category: 'Y' })
    const row = sqlite.prepare('SELECT priority FROM categorization_rules').get() as {
      priority: number
    }
    expect(row.priority).toBe(0)
  })
})

// ── finance:delete-rule ──────────────────────────────────────────────────────

describe('finance:delete-rule', () => {
  it('deletes the rule', async () => {
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category) VALUES (?, ?)')
      .run('temp', 'A')
    const id = Number(
      (sqlite.prepare('SELECT id FROM categorization_rules').get() as { id: number }).id
    )
    const h = await registerAndGet('finance:delete-rule')
    await invoke(h, id)
    const row = sqlite.prepare('SELECT * FROM categorization_rules WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })
})
