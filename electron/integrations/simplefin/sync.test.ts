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
      currency TEXT NOT NULL DEFAULT 'USD',
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
      currency TEXT NOT NULL DEFAULT 'USD',
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
  orgName?: string
  errors?: string[]
}): SimplefinAccountsResponse {
  const orgName = over?.orgName ?? 'American Express'
  return {
    errors: over?.errors ?? [],
    accounts: [
      {
        id: 'acc-1',
        name: over?.accountName ?? 'Platinum Card',
        currency: 'USD',
        balance: over?.balance ?? '-1234.56',
        'balance-date': 1_718_452_800,
        org: { name: orgName, domain: 'example.com' },
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
      .get('acc-1') as {
      balance: number
      institution: string
      simplefin_connection_id: number
      is_debt: number
      asset_class: string
      type: string
    }
    // "Platinum Card" / "American Express" classifies as a credit card → debt /
    // liability, and the owed balance is stored positive (|−1234.56|).
    expect(acct.type).toBe('credit')
    expect(acct.is_debt).toBe(1)
    expect(acct.asset_class).toBe('liability')
    expect(acct.balance).toBeCloseTo(1234.56)
    expect(acct.institution).toBe('American Express')
    expect(acct.simplefin_connection_id).toBe(1)

    // Synced transactions are linked to their account (not accountId=null).
    const acctId = (
      sqlite
        .prepare("SELECT id FROM finance_accounts WHERE simplefin_account_id = 'acc-1'")
        .get() as { id: number }
    ).id
    const linked = sqlite
      .prepare('SELECT count(*) AS n FROM finance_transactions WHERE account_id = ?')
      .get(acctId) as { n: number }
    expect(linked.n).toBe(2)
    const unlinked = sqlite
      .prepare('SELECT count(*) AS n FROM finance_transactions WHERE account_id IS NULL')
      .get() as { n: number }
    expect(unlinked.n).toBe(0)

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
    // Card → debt account, so the refreshed owed balance is stored positive.
    expect(acct.balance).toBeCloseTo(250)
  })

  it('classifies a plain checking account as a spending asset (balance unchanged)', async () => {
    const { syncSimplefin } = await import('./sync')
    await syncSimplefin('conn-1', {
      fetchAccountsFn: async () =>
        fixture({ accountName: 'Everyday Checking', orgName: 'Local Bank', balance: '4200.00' })
    })
    const acct = sqlite
      .prepare(
        'SELECT type, is_debt, asset_class, balance FROM finance_accounts WHERE simplefin_account_id = ?'
      )
      .get('acc-1') as { type: string; is_debt: number; asset_class: string; balance: number }
    expect(acct.type).toBe('checking')
    expect(acct.is_debt).toBe(0)
    expect(acct.asset_class).toBe('spending')
    expect(acct.balance).toBeCloseTo(4200) // asset balance stored as-is
  })
})

describe('syncSimplefin — warnings vs errors', () => {
  it('treats errors[] as a non-fatal warning when data still came back', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', {
      fetchAccountsFn: async () =>
        fixture({ errors: ['Requested date range exceeds recommended range of 45 days.'] })
    })
    // Accounts came back → sync succeeded; the warning must NOT read as a failure.
    expect(res.errorMessage).toBeUndefined()
    expect(res.added).toBe(2)
    const conn = sqlite
      .prepare('SELECT error_code FROM simplefin_connections WHERE connection_id = ?')
      .get('conn-1') as { error_code: string | null }
    expect(conn.error_code).toBeNull() // not flagged red / "needs attention"
    const integ = sqlite
      .prepare("SELECT status FROM integrations WHERE service = 'simplefin'")
      .get() as { status: string }
    expect(integ.status).toBe('connected')
    // ...but it's still recorded in the Sync Log for visibility.
    const ev = sqlite.prepare('SELECT errors FROM sync_events ORDER BY id DESC LIMIT 1').get() as {
      errors: string | null
    }
    expect(ev.errors).toMatch(/warning: .*recommended range/)
  })

  it('flags a hard failure (no accounts returned + errors) as an error', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', {
      fetchAccountsFn: async () => ({
        errors: ['Connection to American Express needs attention'],
        accounts: []
      })
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

describe('syncSimplefin — sync window', () => {
  it('requests ~90 days on first connect and ~30 on subsequent syncs', async () => {
    const { syncSimplefin } = await import('./sync')
    const windows: number[] = []
    const fetchAccountsFn = async (o: { startDate: number; endDate: number }) => {
      windows.push(Math.round((o.endDate - o.startDate) / 86_400))
      return fixture()
    }
    const now = new Date(1_718_452_800_000) // fixed instant
    await syncSimplefin('conn-1', { fetchAccountsFn, now }) // lastSyncedAt null → first sync
    await syncSimplefin('conn-1', { fetchAccountsFn, now }) // lastSyncedAt now set → incremental
    expect(windows[0]).toBe(90)
    expect(windows[1]).toBe(30)
  })
})

describe('syncSimplefin — account matching (#1)', () => {
  // A SimpleFIN account whose name carries a last-4, used for matching.
  const matchableFixture = (): SimplefinAccountsResponse => ({
    errors: [],
    accounts: [
      {
        id: 'acc-1',
        name: 'Platinum Card (2001)',
        currency: 'USD',
        balance: '-500.00',
        'balance-date': 1_718_452_800,
        org: { name: 'American Express', domain: 'example.com' },
        transactions: [
          { id: 'tx-1', posted: 1_718_452_800, amount: '-42.50', description: 'Coffee' }
        ]
      }
    ]
  })

  it('adopts an existing unlinked account on institution + last-4 instead of duplicating', async () => {
    // Pre-existing manual account the user named, no SimpleFIN/Plaid link.
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, type, is_debt, institution, asset_class, mask) VALUES ('My Amex', 'credit', 1, 'American Express', 'liability', '2001')"
      )
      .run()
    const before = (
      sqlite.prepare('SELECT count(*) AS n FROM finance_accounts').get() as { n: number }
    ).n

    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', { fetchAccountsFn: async () => matchableFixture() })

    expect(res.accountsLinked).toBe(1)
    expect(res.accountsUpserted).toBe(0) // no new row created
    const after = (
      sqlite.prepare('SELECT count(*) AS n FROM finance_accounts').get() as { n: number }
    ).n
    expect(after).toBe(before) // adopted, not duplicated

    const adopted = sqlite
      .prepare(
        "SELECT name, simplefin_account_id, simplefin_connection_id FROM finance_accounts WHERE institution='American Express'"
      )
      .get() as {
      name: string
      simplefin_account_id: string | null
      simplefin_connection_id: number | null
    }
    expect(adopted.name).toBe('My Amex') // user's name preserved
    expect(adopted.simplefin_account_id).toBe('acc-1') // now linked
    expect(adopted.simplefin_connection_id).toBe(1)
    // The transaction is linked to the adopted account.
    const linked = sqlite
      .prepare('SELECT count(*) AS n FROM finance_transactions WHERE account_id IS NOT NULL')
      .get() as { n: number }
    expect(linked.n).toBe(1)
  })

  it('creates a new account when no existing account matches', async () => {
    const { syncSimplefin } = await import('./sync')
    const res = await syncSimplefin('conn-1', { fetchAccountsFn: async () => matchableFixture() })
    expect(res.accountsLinked).toBe(0)
    expect(res.accountsUpserted).toBe(1)
  })
})
