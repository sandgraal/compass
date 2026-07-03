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
    CREATE TABLE gmail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL UNIQUE, subject TEXT NOT NULL,
      from_address TEXT NOT NULL, action_summary TEXT, snippet TEXT, received_at INTEGER,
      snoozed_until TEXT, done INTEGER DEFAULT 0, synced_at INTEGER
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, start_at INTEGER, end_at INTEGER, all_day INTEGER DEFAULT 0,
      location TEXT, description TEXT, html_link TEXT, synced_at INTEGER
    );
    CREATE TABLE github_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, repo TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
      body TEXT, labels TEXT, due_date TEXT, author TEXT, updated_at TEXT, synced_at INTEGER
    );
    CREATE TABLE linear_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, identifier TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL, state_type TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0, team TEXT, due_date TEXT, updated_at TEXT, synced_at INTEGER
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

function addGmail(threadId: string, from: string, subject = 'hi', receivedAt = 1700000000000) {
  sqlite
    .prepare(
      'INSERT INTO gmail_actions (thread_id,subject,from_address,snippet,received_at) VALUES (?,?,?,?,?)'
    )
    .run(threadId, subject, from, 'preview', receivedAt)
}

function addEvent(externalId: string, title: string, location: string | null) {
  sqlite
    .prepare(
      "INSERT INTO calendar_events (source,external_id,title,location,start_at) VALUES ('google',?,?,?,?)"
    )
    .run(externalId, title, location, 1700000000000)
}

function addGithub(
  externalId: string,
  type: string,
  repo: string,
  title: string,
  author: string | null
) {
  sqlite
    .prepare(
      "INSERT INTO github_items (type,repo,external_id,title,url,state,author,updated_at) VALUES (?,?,?,?,'http://x','open',?,'2026-06-01T00:00:00Z')"
    )
    .run(type, repo, externalId, title, author)
}

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

  it('projects Gmail senders → people and calendar locations → places', () => {
    addGmail('t1', 'Jane Doe <jane@example.com>')
    addEvent('e1', 'Offsite', 'Cartago, CR')

    const res = projectAllToRecords()
    expect(res.imported).toBe(2) // one email + one event

    const bySource = sqlite
      .prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source ORDER BY source')
      .all()
    expect(bySource).toEqual([
      { source: 'gcal', n: 1 },
      { source: 'gmail', n: 1 }
    ])

    const person = sqlite.prepare("SELECT name FROM derived_entities WHERE kind='person'").get()
    expect(person).toEqual({ name: 'Jane Doe' })
    const place = sqlite.prepare("SELECT name FROM derived_entities WHERE kind='place'").get()
    expect(place).toEqual({ name: 'Cartago, CR' })
  })

  it('projects GitHub issues/PRs → records; derives a person only for a real collaborator', () => {
    addGithub('g1', 'pr', 'sandgraal/worldspine', 'Fix scene timing', 'sandgraal') // self, single-token
    addGithub('g2', 'issue', 'acme/app', 'Bug: crash on load', 'jane-doe') // collaborator
    addGithub('g3', 'pr', 'acme/app', 'Automated bump', 'dependabot[bot]') // bot

    const res = projectAllToRecords()
    expect(res.imported).toBe(3) // all three become searchable records

    const github = sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='github'").get()
    expect(github).toEqual({ n: 3 })

    // Only the humanizable collaborator login becomes a person; self + bot are dropped.
    const people = sqlite
      .prepare("SELECT name FROM derived_entities WHERE kind='person' ORDER BY name")
      .all()
    expect(people).toEqual([{ name: 'Jane Doe' }])
  })

  it('UPSERTS a live row on a changed timestamp — no duplicate timeline spam', () => {
    addGithub('g1', 'issue', 'acme/app', 'Original title', 'jane-doe')
    projectAllToRecords()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='github'").get()).toEqual(
      {
        n: 1
      }
    )

    // Simulate the issue being updated on GitHub: new updated_at + edited title.
    sqlite
      .prepare(
        "UPDATE github_items SET updated_at='2026-08-01T00:00:00Z', title='Edited title' WHERE external_id='g1'"
      )
      .run()
    const res = projectAllToRecords()

    // Still ONE github record (updated in place, not a second row), reflecting the edit.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='github'").get()).toEqual(
      {
        n: 1
      }
    )
    const row = sqlite
      .prepare("SELECT title, occurred_at FROM records WHERE source='github'")
      .get() as { title: string; occurred_at: number }
    expect(row.title).toBe('Edited title')
    expect(row.occurred_at).toBe(Date.parse('2026-08-01T00:00:00Z'))
    expect(res.imported).toBe(0) // an update, not a new insert
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
