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
    CREATE TABLE categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority INTEGER DEFAULT 0
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
    // NOTE: prod code currently produces "1 transaction still reference it"
    // — only the noun is pluralized, not the verb. Grammatically that
    // should be "1 transaction still references it", but the test locks
    // current behavior; a separate grammar-fix task is filed.
    await expect(invoke(h, id)).rejects.toThrow(/1 transaction still reference it/)
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
