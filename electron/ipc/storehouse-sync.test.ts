/**
 * storehouse-sync IPC — projects live finance data into the records spine and
 * rebuilds the derived-entity cache. Real in-memory SQLite for records + owned
 * tables; `captureSnapshots` is stubbed (it has its own tests) so this focuses on
 * the projection + refresh orchestration and the defensive post-sync hook.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
const captureSnapshots = vi.fn()
vi.mock('../integrations/finance-snapshot', () => ({
  captureSnapshots: (...args: unknown[]) => captureSnapshots(...args)
}))

import {
  afterFinanceSync,
  projectAllToRecords,
  registerStorehouseSyncHandlers
} from './storehouse-sync'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

function addTxn(
  hash: string,
  date: string,
  amount: number,
  description: string,
  category = 'Dining'
) {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash,date,amount,currency,description,category) VALUES (?,?,?,?,?,?)'
    )
    .run(hash, date, amount, 'USD', description, category)
}

beforeEach(() => {
  captureSnapshots.mockReset()
  for (const c in handlers) delete handlers[c]
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', description TEXT NOT NULL,
      category TEXT DEFAULT 'Uncategorized'
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL
    );
    CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT);
    CREATE TABLE places (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
      name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
    CREATE UNIQUE INDEX derived_entities_kind_key ON derived_entities (kind, match_key);
  `)
})

describe('projectAllToRecords', () => {
  it('projects finance transactions into records and rebuilds derived entities', () => {
    addTxn('h1', '2026-06-01', -6.5, 'Starbucks')
    addTxn('h2', '2026-06-02', -42, 'Whole Foods', 'Groceries')

    const res = projectAllToRecords()
    expect(res.imported).toBe(2)

    const rows = sqlite
      .prepare('SELECT source, type, title, body FROM records ORDER BY title')
      .all()
    expect(rows).toEqual([
      { source: 'finance', type: 'txn', title: 'Starbucks', body: '-6.50 USD · Dining' },
      { source: 'finance', type: 'txn', title: 'Whole Foods', body: '-42.00 USD · Groceries' }
    ])
    // Merchants materialized into the derived-entity cache.
    const merchants = sqlite
      .prepare("SELECT name FROM derived_entities WHERE kind='merchant' ORDER BY name")
      .all()
    expect(merchants).toEqual([{ name: 'Starbucks' }, { name: 'Whole Foods' }])
    expect(res.entities).toBeGreaterThanOrEqual(2)
  })

  it('is idempotent — re-projection inserts nothing new (dedupe by hash)', () => {
    addTxn('h1', '2026-06-01', -6.5, 'Starbucks')
    expect(projectAllToRecords().imported).toBe(1)
    expect(projectAllToRecords().imported).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
  })
})

describe('afterFinanceSync', () => {
  it('captures snapshots then projects', () => {
    addTxn('h1', '2026-06-01', -6.5, 'Starbucks')
    afterFinanceSync()
    expect(captureSnapshots).toHaveBeenCalledOnce()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
  })

  it('never throws even when snapshot capture fails, and still projects', () => {
    captureSnapshots.mockImplementation(() => {
      throw new Error('boom')
    })
    addTxn('h1', '2026-06-01', -6.5, 'Starbucks')
    expect(() => afterFinanceSync()).not.toThrow()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
  })
})

describe('storehouse:backfill handler', () => {
  it('runs the projection on demand', () => {
    addTxn('h1', '2026-06-01', -6.5, 'Starbucks')
    registerStorehouseSyncHandlers(fakeIpcMain as IpcMain)
    const res = handlers['storehouse:backfill']({}) as { imported: number; entities: number }
    expect(res.imported).toBe(1)
    expect(res.entities).toBeGreaterThanOrEqual(1)
  })
})
