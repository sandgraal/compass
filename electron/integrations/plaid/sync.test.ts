/**
 * End-to-end tests for the Plaid `/transactions/sync` cursor loop.
 *
 * The Plaid SDK is mocked via the `fetchPage` injection point on
 * `syncPlaid`. We spin up an in-memory SQLite with just the slice of
 * schema the sync writes to, then drive scripted page sequences through
 * the loop and assert against the resulting DB state.
 *
 * Scenarios covered (from docs/finance/plaid-integration.md test section):
 *
 *   - Happy path: paginated `added` rows, cursor advances each page,
 *     final integration metadata + sync_events row written.
 *   - `removed` transaction deletes the matching `financeTransactions` row.
 *   - Pending → posted: same logical txn re-issued under a new
 *     transaction_id; hash dedupe means we end with one row, not two.
 *   - `ITEM_LOGIN_REQUIRED` flips `plaid_items.error_code` and returns
 *     gracefully (no throw bubbling).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { Transaction } from 'plaid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema'

let sqlite: Database.Database

vi.mock('../../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// The Plaid client is built from the real `getPlaidClient()` when no
// `fetchPage` is injected; we never hit that path in these tests so a
// no-op mock is fine.
vi.mock('./client', () => ({
  getPlaidClient: () => {
    throw new Error('getPlaidClient should not be called in tests — pass fetchPage')
  }
}))

vi.mock('./vault', () => ({
  getAccessToken: () => 'access-sandbox-fake'
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
  // Schema slice — just the tables sync.ts touches.
  sqlite.exec(`
    CREATE TABLE plaid_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL UNIQUE,
      institution_id TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      cursor TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'checking',
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
      plaid_item_id INTEGER REFERENCES plaid_items(id),
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
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER REFERENCES integrations(id),
      synced_at INTEGER NOT NULL,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );
  `)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ---------- fixture helpers ----------

function seedItem(itemId = 'item-chase'): void {
  sqlite
    .prepare(
      "INSERT INTO plaid_items (item_id, institution_id, institution_name) VALUES (?, 'ins_3', 'Chase')"
    )
    .run(itemId)
}

function seedAccount(name: string, plaidAccountId: string): void {
  sqlite
    .prepare('INSERT INTO finance_accounts (name, institution, plaid_account_id) VALUES (?, ?, ?)')
    .run(name, 'Chase', plaidAccountId)
}

function seedIntegration(): void {
  sqlite.prepare("INSERT INTO integrations (service, status) VALUES ('plaid', 'connected')").run()
}

function makeTxn(over: Partial<Transaction>): Transaction {
  return {
    transaction_id: `TX-${Math.random().toString(36).slice(2, 10)}`,
    account_id: 'ACC-001',
    date: '2026-05-15',
    amount: 12.34,
    name: 'STARBUCKS',
    merchant_name: 'Starbucks',
    iso_currency_code: 'USD',
    pending: false,
    ...over
  } as Transaction
}

function countTxns(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM finance_transactions').get() as { n: number }).n
}

function getItem(itemId: string): {
  cursor: string | null
  error_code: string | null
  last_synced_at: number | null
} {
  return sqlite
    .prepare('SELECT cursor, error_code, last_synced_at FROM plaid_items WHERE item_id = ?')
    .get(itemId) as {
    cursor: string | null
    error_code: string | null
    last_synced_at: number | null
  }
}

// ---------- tests ----------

describe('syncPlaid — happy path', () => {
  it('walks a single page and writes added rows', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    const { syncPlaid } = await import('./sync')
    const res = await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [makeTxn({ amount: 5.5, merchant_name: 'Starbucks' })],
        modified: [],
        removed: [],
        next_cursor: 'cursor-end',
        has_more: false
      })
    })

    expect(res.added).toBe(1)
    expect(res.cursorAdvanced).toBe(true)
    expect(countTxns()).toBe(1)
    expect(getItem('item-chase').cursor).toBe('cursor-end')
    expect(getItem('item-chase').error_code).toBeNull()
    expect(getItem('item-chase').last_synced_at).toBeTruthy()
  })

  it('paginates across pages and advances the cursor each time', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    const pages: Array<Parameters<typeof JSON.parse>[0]> = [
      JSON.stringify({
        cursor: 'cursor-1',
        added: [
          makeTxn({ transaction_id: 'TX-A', merchant_name: 'Merchant A' }),
          makeTxn({ transaction_id: 'TX-B', merchant_name: 'Merchant B' })
        ],
        has_more: true
      }),
      JSON.stringify({
        cursor: 'cursor-2',
        added: [makeTxn({ transaction_id: 'TX-C', merchant_name: 'Merchant C' })],
        has_more: false
      })
    ]
    let idx = 0

    const { syncPlaid } = await import('./sync')
    await syncPlaid('item-chase', {
      fetchPage: async () => {
        const p = JSON.parse(pages[idx++])
        return {
          added: p.added,
          modified: [],
          removed: [],
          next_cursor: p.cursor,
          has_more: p.has_more
        }
      }
    })

    expect(countTxns()).toBe(3)
    expect(getItem('item-chase').cursor).toBe('cursor-2')
  })

  it('writes a sync_events row with the total records updated', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    const { syncPlaid } = await import('./sync')
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [
          makeTxn({ transaction_id: 'TX-A', merchant_name: 'A' }),
          makeTxn({ transaction_id: 'TX-B', merchant_name: 'B' })
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-end',
        has_more: false
      })
    })

    const evt = sqlite.prepare('SELECT records_updated, errors FROM sync_events').get() as {
      records_updated: number
      errors: string | null
    }
    expect(evt.records_updated).toBe(2)
    expect(evt.errors).toBeNull()
  })
})

describe('syncPlaid — removed transactions', () => {
  it('deletes the matching finance_transactions row by sourceFile', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    const { syncPlaid } = await import('./sync')

    // First sync: add TX-A.
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [makeTxn({ transaction_id: 'TX-A', merchant_name: 'A' })],
        modified: [],
        removed: [],
        next_cursor: 'cursor-1',
        has_more: false
      })
    })
    expect(countTxns()).toBe(1)

    // Second sync: Plaid says TX-A was removed.
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [],
        modified: [],
        removed: [{ transaction_id: 'TX-A', account_id: 'ACC-001' }],
        next_cursor: 'cursor-2',
        has_more: false
      })
    })
    expect(countTxns()).toBe(0)
  })

  it('processes removed before added (pending→posted dance)', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    // Pre-seed a "pending" row from a prior sync.
    const { syncPlaid } = await import('./sync')
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [makeTxn({ transaction_id: 'TX-pending', amount: 12.34, merchant_name: 'Coffee' })],
        modified: [],
        removed: [],
        next_cursor: 'cursor-1',
        has_more: false
      })
    })
    expect(countTxns()).toBe(1)

    // Next sync: pending was removed, posted version added with new txn_id.
    // Both share the same natural-field hash so the dedupe path must NOT
    // confuse the two — removed-first lets the new row land cleanly.
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [makeTxn({ transaction_id: 'TX-posted', amount: 12.34, merchant_name: 'Coffee' })],
        modified: [],
        removed: [{ transaction_id: 'TX-pending', account_id: 'ACC-001' }],
        next_cursor: 'cursor-2',
        has_more: false
      })
    })

    expect(countTxns()).toBe(1)
    const row = sqlite.prepare('SELECT source_file FROM finance_transactions').get() as {
      source_file: string
    }
    expect(row.source_file).toBe('plaid:Chase:TX-posted')
  })
})

describe('syncPlaid — ITEM_LOGIN_REQUIRED', () => {
  it('records error_code on the Item row and returns without throwing', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()

    // Build a thrown error that mimics the Plaid SDK's Axios shape.
    const plaidErr = Object.assign(new Error('Auth expired'), {
      response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } }
    })

    const { syncPlaid } = await import('./sync')
    const res = await syncPlaid('item-chase', {
      fetchPage: async () => {
        throw plaidErr
      }
    })

    expect(res.errorCode).toBe('ITEM_LOGIN_REQUIRED')
    expect(res.errorMessage).toMatch(/Auth expired/)
    expect(getItem('item-chase').error_code).toBe('ITEM_LOGIN_REQUIRED')
  })

  it('clears a stale error_code on the next successful sync', async () => {
    seedItem('item-chase')
    seedAccount('Chase Checking', 'ACC-001')
    seedIntegration()
    // Manually set a stale error from a prior failure.
    sqlite
      .prepare("UPDATE plaid_items SET error_code = 'ITEM_LOGIN_REQUIRED' WHERE item_id = ?")
      .run('item-chase')

    const { syncPlaid } = await import('./sync')
    await syncPlaid('item-chase', {
      fetchPage: async () => ({
        added: [],
        modified: [],
        removed: [],
        next_cursor: 'cursor-1',
        has_more: false
      })
    })

    expect(getItem('item-chase').error_code).toBeNull()
  })
})

describe('syncPlaid — unknown Item', () => {
  it('returns an error result without throwing if the Item is unknown', async () => {
    const { syncPlaid } = await import('./sync')
    const res = await syncPlaid('item-ghost', {
      fetchPage: async () => {
        throw new Error('should not be called')
      }
    })
    expect(res.errorMessage).toMatch(/No plaid_items row/)
    expect(res.cursorAdvanced).toBe(false)
  })
})
