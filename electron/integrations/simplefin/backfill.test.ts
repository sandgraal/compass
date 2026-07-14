/**
 * Tests for `backfillSimplefinHistory` — the one-time "Import full history"
 * backward date-window walk (distinct from the recurring `syncSimplefin`
 * window, covered in sync.test.ts).
 *
 * Same in-memory-SQLite + injected-fetcher harness as sync.test.ts, plus the
 * two backfill-progress columns on `simplefin_connections`.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema'
import type { SimplefinAccountsResponse } from './client'
import { SIMPLEFIN_BACKFILL_MAX_WINDOWS } from './config'

let sqlite: Database.Database

vi.mock('../../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('./vault', () => ({
  getAccessUrl: () => 'https://u:p@bridge.simplefin.org/simplefin',
  assertValidAccessUrl: (u: string) => new URL(u)
}))

const noopSleep = async () => {}

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
      created_at INTEGER,
      history_oldest_date TEXT,
      history_backfill_status TEXT
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
    , is_foreign INTEGER NOT NULL DEFAULT 0);
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
      ingested_at INTEGER,
      normalized_merchant TEXT
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
  sqlite
    .prepare(
      "INSERT INTO simplefin_connections (connection_id, org_name) VALUES ('conn-1', 'American Express')"
    )
    .run()
  sqlite
    .prepare("INSERT INTO integrations (service, status) VALUES ('simplefin', 'connected')")
    .run()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

function countTxns(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM finance_transactions').get() as { n: number }).n
}

function connRow(): { history_oldest_date: string | null; history_backfill_status: string | null } {
  return sqlite
    .prepare(
      'SELECT history_oldest_date, history_backfill_status FROM simplefin_connections WHERE connection_id = ?'
    )
    .get('conn-1') as { history_oldest_date: string | null; history_backfill_status: string | null }
}

/** A window with N distinct transactions, so date-adjacent windows never hash-collide. */
function windowWithTxns(windowIndex: number, count: number): SimplefinAccountsResponse {
  return {
    errors: [],
    accounts: [
      {
        id: 'acc-1',
        name: 'Everyday Checking',
        currency: 'USD',
        balance: '1000.00',
        'balance-date': 1_718_452_800,
        org: { name: 'Local Bank', domain: 'example.com' },
        transactions: Array.from({ length: count }, (_, i) => ({
          id: `tx-w${windowIndex}-${i}`,
          posted: 1_718_452_800 - windowIndex * 90 * 86_400,
          amount: '-10.00',
          description: `Purchase w${windowIndex}-${i}`
        }))
      }
    ]
  }
}

function emptyWindow(): SimplefinAccountsResponse {
  return {
    errors: [],
    accounts: [
      {
        id: 'acc-1',
        name: 'Everyday Checking',
        currency: 'USD',
        balance: '1000.00',
        'balance-date': 1_718_452_800,
        org: { name: 'Local Bank', domain: 'example.com' },
        transactions: []
      }
    ]
  }
}

/** Same transactions every call, plus a non-fatal warning every call — the
 *  live USAA-via-MX shape: the bridge ignores an old start-date and just
 *  re-serves its limited recent window, tripping the "exceeds recommended
 *  range" warning on every 90-day request regardless of date. */
function windowWithWarningAndRepeatedTxns(): SimplefinAccountsResponse {
  return {
    errors: ['Requested date range exceeds recommended range of 45 days.'],
    accounts: [
      {
        id: 'acc-1',
        name: 'Everyday Checking',
        currency: 'USD',
        balance: '1000.00',
        'balance-date': 1_718_452_800,
        org: { name: 'Local Bank', domain: 'example.com' },
        transactions: [
          { id: 'tx-fixed-1', posted: 1_718_452_800, amount: '-10.00', description: 'Purchase' }
        ]
      }
    ]
  }
}

describe('backfillSimplefinHistory — walking backward', () => {
  it('stops on repeated data + a non-fatal warning, not just a literally empty response', async () => {
    // Regression: a first cut of this heuristic required `errors.length === 0`
    // to count a window as "empty", so an institution that warns on every
    // request (real behavior seen live) never tripped the stop condition and
    // silently burned the entire safety cap every run.
    const { backfillSimplefinHistory } = await import('./sync')
    const res = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn: async () => windowWithWarningAndRepeatedTxns(),
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    expect(res.status).toBe('complete')
    // window 1 ingests the 1 txn (added=1), windows 2 & 3 re-see the same
    // txn (added=0, deduped) despite the warning -> two consecutive stops it.
    expect(res.windowsFetched).toBe(3)
    expect(res.added).toBe(1)
  })

  it('stops on two consecutive empty windows and reports complete', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    let call = 0
    const fetchAccountsFn = async () => {
      call++
      // window 1 & 2 have data, 3 & 4 are empty -> two consecutive empties stop it
      return call <= 2 ? windowWithTxns(call, 2) : emptyWindow()
    }
    const res = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    expect(res.status).toBe('complete')
    expect(res.windowsFetched).toBe(4)
    expect(res.added).toBe(4) // 2 windows * 2 txns
    expect(res.oldestDateReached).toBeTruthy()
    expect(countTxns()).toBe(4)

    const row = connRow()
    expect(row.history_backfill_status).toBe('complete')
    expect(row.history_oldest_date).toBe(res.oldestDateReached)
  })

  it('hits the safety cap and reports partial when data never runs out', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    let call = 0
    const fetchAccountsFn = async () => {
      call++
      return windowWithTxns(call, 1)
    }
    const res = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    expect(res.status).toBe('partial')
    expect(res.windowsFetched).toBe(SIMPLEFIN_BACKFILL_MAX_WINDOWS)
    expect(connRow().history_backfill_status).toBe('partial')
  })

  it('stops on a transport error and preserves partial totals', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    let call = 0
    const fetchAccountsFn = async () => {
      call++
      if (call === 3) throw new Error('SimpleFIN /accounts failed (HTTP 500)')
      return windowWithTxns(call, 1)
    }
    const res = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    expect(res.status).toBe('error')
    expect(res.errorMessage).toMatch(/HTTP 500/)
    expect(res.windowsFetched).toBe(2) // the 2 successful windows before the throw
    expect(res.added).toBe(2)
    expect(connRow().history_backfill_status).toBe('error')
  })

  it('stops on a hard failure (no accounts + errors) without throwing', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    const fetchAccountsFn = async () => ({
      errors: ['Connection to Local Bank needs attention'],
      accounts: []
    })
    const res = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })
    expect(res.status).toBe('error')
    expect(res.errorMessage).toMatch(/needs attention/)
  })
})

describe('backfillSimplefinHistory — idempotency + resume', () => {
  it('running twice inserts zero duplicates the second time', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    let call = 0
    const fetchAccountsFn = async () => {
      call++
      return call <= 2 ? windowWithTxns(call, 2) : emptyWindow()
    }
    const first = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })
    expect(first.status).toBe('complete')
    const totalAfterFirst = countTxns()

    // Re-run: status is already 'complete' so this should short-circuit with
    // zero fetches, zero new rows.
    let secondCallCount = 0
    const second = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn: async () => {
        secondCallCount++
        return emptyWindow()
      },
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    expect(secondCallCount).toBe(0) // short-circuited, no network calls
    expect(second.status).toBe('complete')
    expect(second.windowsFetched).toBe(0)
    expect(second.oldestDateReached).toBe(first.oldestDateReached)
    expect(countTxns()).toBe(totalAfterFirst)
  })

  it('resumes from the prior oldestDateReached instead of restarting from now', async () => {
    const { backfillSimplefinHistory } = await import('./sync')
    const seenWindows: Array<{ startDate: number; endDate: number }> = []

    // First run: data never runs out -> hits the safety cap, status 'partial'.
    let call = 0
    const firstFetch = async (o: { startDate: number; endDate: number }) => {
      call++
      seenWindows.push(o)
      return windowWithTxns(call, 1)
    }
    const first = await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn: firstFetch,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })
    expect(first.status).toBe('partial')
    const windowsAfterFirstRun = seenWindows.length

    // Second run: should pick up from the persisted `historyOldestDate`, not
    // restart from `now`. That column is ISO-date (day) granularity, so the
    // resumed endDate is the first run's oldest date at UTC midnight — not
    // necessarily the exact epoch second of its last window's startDate.
    const secondFetch = async (o: { startDate: number; endDate: number }) => {
      seenWindows.push(o)
      return emptyWindow()
    }
    await backfillSimplefinHistory('conn-1', {
      fetchAccountsFn: secondFetch,
      now: new Date(1_718_452_800_000),
      sleepFn: noopSleep
    })

    const firstWindowOfSecondRun = seenWindows[windowsAfterFirstRun]
    const expectedResumeEndDate = Math.floor(
      new Date(`${first.oldestDateReached}T00:00:00Z`).getTime() / 1000
    )
    expect(firstWindowOfSecondRun.endDate).toBe(expectedResumeEndDate)
  })
})
