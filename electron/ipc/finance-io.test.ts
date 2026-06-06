/**
 * Tests for the remaining finance:* handlers — transaction listing, manual
 * balance setting, and folder ingest (Phase 6.1 — P1, chunk 3 of 3).
 *
 * Chunk 1 (`finance.test.ts`) = CRUD; chunk 2 (`finance-queries.test.ts`) =
 * business-logic queries. This chunk finishes finance.ts coverage with the
 * handlers that were still untested and carry real branching logic:
 *
 *   - finance:get-transactions  → the filter matrix (month × category ×
 *                                  account combinations, limit, date ordering)
 *   - finance:set-account-balance → input-validation guards (bad id, bad/
 *                                  out-of-range balance, missing account) plus
 *                                  the success path (writes a 'manual' snapshot
 *                                  and syncs finance_accounts.balance)
 *   - finance:ingest-folder     → the missing-folder early return (creates the
 *                                  dir, reports zeros) and the delegate path
 *                                  (passes rules through to ingestCsvFolder and
 *                                  returns its result)
 *
 * Out of scope (thin wrappers around separately-tested modules / OS I/O):
 * export-tax-pack, capture-snapshot, the chokidar watch-folder controls
 * (set/get/pick/stop-watching, ingest-watched-now), reapply-rules. Their
 * handler body is a one-liner over a module that owns the logic + its tests.
 *
 * Same strategy: real in-memory SQLite via better-sqlite3 + drizzle; only the
 * CSV parser + knowledge refresh are mocked (so ingest-folder can be exercised
 * without real files).
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

// existsSync is per-test settable so ingest-folder can hit both the
// missing-folder branch and the populated branch. mkdirSync/writeFileSync
// are no-ops — these tests never touch real disk.
const existsSyncMock = vi.fn<(p: string) => boolean>(() => true)
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
  mkdirSync: () => undefined,
  writeFileSync: () => undefined
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

// The CSV ingest pipeline is owned (and tested) in ../integrations/finance;
// here we only assert the handler delegates correctly and returns the result.
// `categorize` is also exported from that module (used by other handlers we
// don't invoke), so the mock stubs it too to keep the import shape intact.
const ingestCsvFolderMock = vi.fn()
vi.mock('../integrations/finance', () => ({
  ingestCsvFolder: (...args: unknown[]) => ingestCsvFolderMock(...args),
  categorize: vi.fn(() => ({ category: 'Uncategorized', subcategory: null }))
}))

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
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
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
  existsSyncMock.mockReturnValue(true)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedAccount(name: string): number {
  return Number(
    sqlite.prepare("INSERT INTO finance_accounts (name, type) VALUES (?, 'checking')").run(name)
      .lastInsertRowid
  )
}

let txnSeq = 0
function seedTxn(over: {
  date: string
  amount?: number
  category?: string
  accountId?: number | null
}): number {
  txnSeq++
  return Number(
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (hash, date, amount, description, category, account_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        `hash-${txnSeq}`,
        over.date,
        over.amount ?? -10,
        'txn',
        over.category ?? 'Uncategorized',
        over.accountId ?? null
      ).lastInsertRowid
  )
}

beforeEach(() => {
  txnSeq = 0
})

// ── finance:get-transactions ─────────────────────────────────────────────────

describe('finance:get-transactions', () => {
  it('returns everything (newest first) when no filter is given', async () => {
    seedTxn({ date: '2026-05-01' })
    seedTxn({ date: '2026-05-20' })
    seedTxn({ date: '2026-04-15' })
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h)) as Array<{ date: string }>
    expect(rows.map((r) => r.date)).toEqual(['2026-05-20', '2026-05-01', '2026-04-15'])
  })

  it('filters by month window [month-01, nextMonth-01)', async () => {
    seedTxn({ date: '2026-04-30' })
    seedTxn({ date: '2026-05-01' })
    seedTxn({ date: '2026-05-31' })
    seedTxn({ date: '2026-06-01' })
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h, { month: '2026-05' })) as Array<{ date: string }>
    expect(rows.map((r) => r.date).sort()).toEqual(['2026-05-01', '2026-05-31'])
  })

  it('filters by category only', async () => {
    seedTxn({ date: '2026-05-01', category: 'Groceries' })
    seedTxn({ date: '2026-05-02', category: 'Dining' })
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h, { category: 'Groceries' })) as Array<{ category: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('Groceries')
  })

  it('filters by account only', async () => {
    const a = seedAccount('Checking')
    const b = seedAccount('Savings')
    seedTxn({ date: '2026-05-01', accountId: a })
    seedTxn({ date: '2026-05-02', accountId: b })
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h, { accountId: a })) as Array<{ accountId: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(a)
  })

  it('combines month + category + account', async () => {
    const a = seedAccount('Checking')
    seedTxn({ date: '2026-05-10', category: 'Groceries', accountId: a })
    seedTxn({ date: '2026-05-10', category: 'Dining', accountId: a }) // wrong cat
    seedTxn({ date: '2026-06-10', category: 'Groceries', accountId: a }) // wrong month
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h, {
      month: '2026-05',
      category: 'Groceries',
      accountId: a
    })) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('honors the limit (default 200, overridable)', async () => {
    for (let i = 0; i < 5; i++) seedTxn({ date: `2026-05-0${i + 1}` })
    const h = await registerAndGet('finance:get-transactions')
    const rows = (await invoke(h, { limit: 2 })) as unknown[]
    expect(rows).toHaveLength(2)
  })
})

// ── finance:set-account-balance ──────────────────────────────────────────────

describe('finance:set-account-balance', () => {
  it('rejects a non-integer / non-positive account id', async () => {
    const h = await registerAndGet('finance:set-account-balance')
    expect(await invoke(h, 0, 100)).toMatchObject({ success: false })
    expect(await invoke(h, -3, 100)).toMatchObject({ success: false })
    expect(await invoke(h, 1.5, 100)).toMatchObject({ success: false })
  })

  it('rejects a non-finite or out-of-range balance', async () => {
    const id = seedAccount('Brokerage')
    const h = await registerAndGet('finance:set-account-balance')
    expect(await invoke(h, id, Number.NaN)).toMatchObject({ success: false })
    expect(await invoke(h, id, 2_000_000_000)).toMatchObject({ success: false }) // > ±$1B
  })

  it('returns an error when the account does not exist', async () => {
    const h = await registerAndGet('finance:set-account-balance')
    const res = (await invoke(h, 999, 100)) as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('writes a manual snapshot and syncs finance_accounts.balance on success', async () => {
    const id = seedAccount('CR Property')
    const h = await registerAndGet('finance:set-account-balance')
    const res = (await invoke(h, id, 250000)) as { success: boolean }
    expect(res.success).toBe(true)

    const snap = sqlite
      .prepare('SELECT balance, source FROM finance_balance_snapshots WHERE account_id = ?')
      .get(id) as { balance: number; source: string } | undefined
    expect(snap).toEqual({ balance: 250000, source: 'manual' })

    const acct = sqlite.prepare('SELECT balance FROM finance_accounts WHERE id = ?').get(id) as {
      balance: number
    }
    expect(acct.balance).toBe(250000)
  })
})

// ── finance:ingest-folder ────────────────────────────────────────────────────

describe('finance:ingest-folder', () => {
  it('creates the folder and reports zeros when the inbox does not exist yet', async () => {
    existsSyncMock.mockReturnValue(false)
    const h = await registerAndGet('finance:ingest-folder')
    const res = await invoke(h, '/some/missing/inbox')
    expect(res).toEqual({
      filesProcessed: 0,
      newTransactions: 0,
      duplicatesDropped: 0,
      perFile: []
    })
    expect(ingestCsvFolderMock).not.toHaveBeenCalled()
  })

  it('passes the priority-ordered rules through to ingestCsvFolder and returns its result', async () => {
    // After a successful ingest the handler kicks off a best-effort
    // refreshFinanceKnowledge() (wrapped in its own try/catch). It reads tables
    // outside this chunk's schema slice and logs a warning — expected and
    // harmless here; silence it so the test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category, priority) VALUES (?, ?, ?)')
      .run('uber', 'Transport', 5)
    const ingestResult = {
      filesProcessed: 2,
      newTransactions: 7,
      duplicatesDropped: 1,
      perFile: []
    }
    ingestCsvFolderMock.mockResolvedValue(ingestResult)

    const h = await registerAndGet('finance:ingest-folder')
    const res = await invoke(h, '/real/inbox')
    expect(res).toEqual(ingestResult)
    errSpy.mockRestore()
    expect(ingestCsvFolderMock).toHaveBeenCalledOnce()
    // rules (4th-from-handler arg) must be the seeded rule set
    const callArgs = ingestCsvFolderMock.mock.calls[0]
    const rulesArg = callArgs[4] as Array<{ pattern: string }>
    expect(rulesArg).toHaveLength(1)
    expect(rulesArg[0].pattern).toBe('uber')
  })
})
