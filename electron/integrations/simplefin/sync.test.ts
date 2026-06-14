/**
 * End-to-end tests for the SimpleFIN date-windowed sync.
 *
 * Mirrors the Plaid sync test harness: an in-memory SQLite with the schema
 * slice the sync writes to, `getDb` mocked onto it, and a scripted
 * `fetchAccountsFn` injected so no network/vault is touched.
 *
 * Headline assertions:
 *   - accounts upserted + transactions ingested with NO sign flip
 *   - running the SAME window twice inserts zero the second time (the hash
 *     UNIQUE constraint is the entire idempotency story — there is no cursor)
 *   - SimpleFIN `errors[]` sticks on the connection row + integrations status
 *   - account name is preserved across syncs (user renames survive) while the
 *     balance is refreshed
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema'
import type { SimplefinAccountsResponse } from './client'

let sqlite: Database.Database

vi.mock('../../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// Injected fetchAccountsFn is always used in these tests, so the vault is never
// read — mock it only to satisfy the import chain (vault → crypto-vault →
// electron) without pulling in safeStorage.
vi.mock('./vault', () => ({
  getAccessUrl: () => 'https://u:p@bridge.simplefin.org/simplefin',
  assertValidAccessUrl: (u: string) => new URL(u)
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE simplefin_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL UNIQUE,
      org_name TEXT NOT NULL DEFAULT '',
      org_domain TEXT,
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
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      plaid_item_id INTEGER,
      plaid_account_id TEXT,
      mask TEXT,
      simplefin_connection_id INTEGER REFERENCES simplefin_connections(id),
      simplefin_account_id TEXT,
      updated_at INTEGER
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
      geo TEXT NOT NULL DEFAULT 'US',
      purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER,
      source_file TEXT,
      ingested_at INTEGER
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
  seedConnection()
  seedIntegration()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

function seedConnection(connectionId = 'conn-1'): void {
  sqlite
    .prepare(
      "INSERT INTO simplefin_connections (connection_id, org_name) VALUES (?, 'American Express')"
    )
    .run(connectionId)
}

function seedIntegration(): void {
  sqlite
    .prepare("INSERT INTO integrations (service, status) VALUES ('simplefin', 'connected')")
    .run()
}

function countTxns(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM finance_transactions').get() as { n: number }).n
}

function fixture(over?: {
  balance?: string
  accountName?: string
  errors?: string[]
}): SimplefinAccountsResponse {
  return {
    errors: over?.errors ?? [],
    accounts: [
      {
        id: 'acc-1',
        name: over?.accountName ?? 'Platinum Card',
        currency: 'USD',
        balance: over?.balance ?? '-1234.56',
        'balance-date': 1_718_452_800,
        org: { name: 'American Express', domain: 'americanexpress.com' },
        transactions: [
          { id: 'tx-1', posted: 1_718_452_800, amount: '-42.50', description: 'Blue Bottle' },
          { id: 'tx-2', posted: 1_718_452_800, amount: '1000.00', description: 'Payroll' }
        ]
      }
    ]
  }
}

describe('syncSimplefin — happy path', () => {
  it('upserts the account and ingests transactions with no sign flip', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', { fetchAccountsFn: async () => fixture() })

    expect(res.accountsUpserted).toBe(1)
    expect(res.added).toBe(2)
    expect(countTxns()).toBe(2)

    const amounts = (
      sqlite.prepare('SELECT amount FROM finance_transactions ORDER BY amount').all() as Array<{
        amount: number
      }>
    ).map((r) => r.amount)
    // −42.50 stays negative (withdrawal), 1000 stays positive (deposit). No flip.
    expect(amounts).toEqual([-42.5, 1000])

    const acct = sqlite
      .prepare('SELECT * FROM finance_accounts WHERE simplefin_account_id = ?')
      .get('acc-1') as { balance: number; institution: string; simplefin_connection_id: number }
    expect(acct.balance).toBeCloseTo(-1234.56)
    expect(acct.institution).toBe('American Express')
    expect(acct.simplefin_connection_id).toBe(1)

    const conn = sqlite
      .prepare(
        'SELECT last_synced_at, error_code FROM simplefin_connections WHERE connection_id = ?'
      )
      .get('conn-1') as { last_synced_at: number | null; error_code: string | null }
    expect(conn.last_synced_at).toBeTruthy()
    expect(conn.error_code).toBeNull()
  })

  it('is idempotent — a second sync of the same window inserts zero', async () => {
    const { syncSimplefin } = await import('./sync')
    await syncSimplefin('conn-1', { fetchAccountsFn: async () => fixture() })
    const second = await syncSimplefin('conn-1', { fetchAccountsFn: async () => fixture() })

    expect(second.added).toBe(0)
    expect(second.duplicates).toBe(2)
    expect(countTxns()).toBe(2) // no cursor, but the hash UNIQUE guard holds
  })

  it('refreshes balance on re-sync but preserves a user-renamed account', async () => {
    const { syncSimplefin } = await import('./sync')
    await syncSimplefin('conn-1', { fetchAccountsFn: async () => fixture({ balance: '-100.00' }) })
    // User renames the account in the Accounts UI.
    sqlite
      .prepare("UPDATE finance_accounts SET name = 'My Amex' WHERE simplefin_account_id = 'acc-1'")
      .run()
    // Next sync sees a different upstream name + a new balance.
    await syncSimplefin('conn-1', {
      fetchAccountsFn: async () => fixture({ balance: '-250.00', accountName: 'Platinum Card' })
    })
    const acct = sqlite
      .prepare('SELECT name, balance FROM finance_accounts WHERE simplefin_account_id = ?')
      .get('acc-1') as { name: string; balance: number }
    expect(acct.name).toBe('My Amex') // user rename survives
    expect(acct.balance).toBeCloseTo(-250) // balance refreshed
  })
})

describe('syncSimplefin — errors', () => {
  it('records SimpleFIN errors[] on the connection row + integrations status', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', {
      fetchAccountsFn: async () =>
        fixture({ errors: ['Connection to American Express needs attention'] })
    })
    expect(res.errorMessage).toMatch(/needs attention/)
    const conn = sqlite
      .prepare('SELECT error_code FROM simplefin_connections WHERE connection_id = ?')
      .get('conn-1') as { error_code: string | null }
    expect(conn.error_code).toMatch(/needs attention/)
    const integ = sqlite
      .prepare("SELECT status FROM integrations WHERE service = 'simplefin'")
      .get() as { status: string }
    expect(integ.status).toBe('error')
  })

  it('returns a clear error when the connection row is missing', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('nope', { fetchAccountsFn: async () => fixture() })
    expect(res.errorMessage).toMatch(/No simplefin_connections row/)
    expect(res.added).toBe(0)
  })

  it('records a transport failure without throwing', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', {
      fetchAccountsFn: async () => {
        throw new Error('SimpleFIN /accounts failed (HTTP 403)')
      }
    })
    expect(res.errorMessage).toMatch(/HTTP 403/)
    const conn = sqlite
      .prepare('SELECT error_code FROM simplefin_connections WHERE connection_id = ?')
      .get('conn-1') as { error_code: string | null }
    expect(conn.error_code).toMatch(/HTTP 403/)
  })
})
