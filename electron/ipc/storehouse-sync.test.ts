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
  SPINE_EXPANSION_BACKFILL_KEY,
  afterFinanceSync,
  projectAllToRecords,
  registerStorehouseSyncHandlers,
  runSpineExpansionBackfillIfNeeded
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
    CREATE TABLE oura_daily_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
      sleep_score INTEGER, readiness_score INTEGER, activity_score INTEGER,
      steps INTEGER, total_sleep_minutes INTEGER, synced_at INTEGER
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      emails TEXT, phones TEXT, enrichment TEXT, updated_at INTEGER
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
    -- Spine-expansion domains (data-access policy)
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT, color TEXT DEFAULT '#6272f1',
      active INTEGER DEFAULT 1, created_at INTEGER, auto_link_source TEXT, auto_link_threshold REAL
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, date TEXT NOT NULL,
      completed INTEGER DEFAULT 0, source TEXT
    );
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list_type TEXT NOT NULL, list_date TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, checked INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal', sort_order INTEGER DEFAULT 0, due_date TEXT,
      source TEXT DEFAULT 'manual', source_id TEXT, created_at INTEGER
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      description TEXT, code TEXT, status TEXT, recorded_at TEXT, ingested_at INTEGER
    );
    CREATE TABLE lab_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, test_name TEXT NOT NULL, panel TEXT, value REAL,
      value_text TEXT, unit TEXT, ref_range TEXT, flag TEXT, taken_at TEXT NOT NULL,
      encounter_id TEXT, source TEXT NOT NULL DEFAULT 'manual', notes TEXT, created_at INTEGER
    );
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, notes TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
    );
    CREATE TABLE argyle_paystubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
      gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
      currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT, paid_at TEXT,
      pay_cycle TEXT, ingested_at INTEGER
    );
    CREATE TABLE utility_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, provider TEXT,
      service_address TEXT, statement_date TEXT, period_start TEXT, period_end TEXT,
      amount REAL, currency TEXT NOT NULL DEFAULT 'USD', usage_kwh REAL, ingested_at INTEGER
    );
    CREATE TABLE financial_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
      target_amount REAL NOT NULL DEFAULT 0, target_date TEXT, source TEXT NOT NULL DEFAULT 'manual',
      manual_current REAL NOT NULL DEFAULT 0, monthly_contribution REAL NOT NULL DEFAULT 0,
      notes TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE rental_comps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      zone TEXT NOT NULL DEFAULT 'Cartago', bedrooms INTEGER NOT NULL DEFAULT 2, nightly_usd REAL,
      occupancy_pct REAL, rating REAL, review_count INTEGER, notes TEXT, saved_at TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE snapshot_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, category TEXT NOT NULL,
      label TEXT, value TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
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

function addOura(date: string, sleepScore: number | null, steps: number | null) {
  sqlite
    .prepare(
      'INSERT INTO oura_daily_metrics (date, sleep_score, readiness_score, activity_score, steps) VALUES (?,?,?,?,?)'
    )
    .run(date, sleepScore, 70, 80, steps)
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

  it('projects Oura daily metrics → wellness records, upserting on re-projection', () => {
    addOura('2026-06-12', 82, 8412)

    const res = projectAllToRecords()
    expect(res.imported).toBe(1)

    const row = sqlite
      .prepare("SELECT source, type, title, body FROM records WHERE source='oura'")
      .get()
    expect(row).toEqual({
      source: 'oura',
      type: 'wellness',
      title: 'Oura: Sleep 82 · Readiness 70 · Activity 80',
      body: '8,412 steps'
    })

    // A rescored day (Oura revises after processing) re-projects the SAME row.
    sqlite.prepare("UPDATE oura_daily_metrics SET sleep_score = 90 WHERE date = '2026-06-12'").run()
    const res2 = projectAllToRecords()
    expect(res2.imported).toBe(0) // update, not a new insert
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='oura'").get()).toEqual({
      n: 1
    })
    const updated = sqlite.prepare("SELECT title FROM records WHERE source='oura'").get() as {
      title: string
    }
    expect(updated.title).toBe('Oura: Sleep 90 · Readiness 70 · Activity 80')
  })
})

describe('spine expansion (data-access policy)', () => {
  it('projects a completed habit check and reconcile-deletes it when unchecked', () => {
    sqlite.prepare("INSERT INTO habits (id, name) VALUES (3, 'Meditate')").run()
    sqlite
      .prepare("INSERT INTO habit_entries (habit_id, date, completed) VALUES (3, '2026-07-01', 1)")
      .run()

    projectAllToRecords()
    const row = sqlite.prepare("SELECT type, title, body FROM records WHERE source='habit'").get()
    expect(row).toEqual({ type: 'habit-check', title: 'Meditate', body: 'checked' })

    // Uncheck the day → the projector stops producing it → reconcile removes the ghost.
    sqlite.prepare('UPDATE habit_entries SET completed = 0').run()
    projectAllToRecords()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='habit'").get()).toEqual({
      n: 0
    })
  })

  it('projects tasks and reconcile-deletes removed ones', () => {
    sqlite
      .prepare(
        "INSERT INTO checklist_items (id, list_type, list_date, title, status) VALUES (7, 'daily', '2026-07-02', 'Call the bank', 'done')"
      )
      .run()
    projectAllToRecords()
    expect(sqlite.prepare("SELECT title, body FROM records WHERE source='task'").get()).toEqual({
      title: 'Call the bank',
      body: 'daily · done · personal'
    })

    sqlite.prepare('DELETE FROM checklist_items WHERE id = 7').run()
    projectAllToRecords()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source='task'").get()).toEqual({
      n: 0
    })
  })

  it('projects medical records in FULL detail (policy: no aggregates-only wall)', () => {
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, code, status, recorded_at) VALUES ('m1', 'medication', 'Aspirin 81mg', 'RxNorm:243670', 'active', '2026-03-10')"
      )
      .run()
    projectAllToRecords()
    const row = sqlite.prepare("SELECT type, title, body FROM records WHERE source='medical'").get()
    expect(row).toEqual({
      type: 'medication',
      title: 'Aspirin 81mg',
      body: 'active · RxNorm:243670'
    })
  })

  it('re-categorized medical rows re-project without leaving a stale ghost', () => {
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description) VALUES ('m1', 'condition', 'Migraine')"
      )
      .run()
    projectAllToRecords()
    // Metriport corrects the category → the (source,type,key) hash changes.
    sqlite.prepare("UPDATE medical_records SET category = 'encounter' WHERE external_id='m1'").run()
    projectAllToRecords()
    const rows = sqlite
      .prepare("SELECT type FROM records WHERE source='medical' ORDER BY type")
      .all()
    expect(rows).toEqual([{ type: 'encounter' }])
  })

  it('projects trips, paystubs, bills, goals, comps, and facts onto the spine', () => {
    sqlite
      .prepare(
        "INSERT INTO travel_segments (id, country, start_date, end_date, notes) VALUES (4, 'CR', '2026-02-01', '2026-02-14', NULL)"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, paid_at) VALUES ('ps-1', 'Initech', 4000, 3000, '2026-06-16')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO utility_bills (external_id, provider, amount, statement_date) VALUES ('ub-1', 'CNFL', 84.5, '2026-06-20')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO financial_goals (id, name, category, target_amount, created_at) VALUES (2, 'Emergency fund', 'emergency', 25000, 1750000000000)"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO rental_comps (id, name, zone, bedrooms, nightly_usd, saved_at) VALUES (9, 'Casa Verde', 'Cartago', 2, 95, '2026-05-05')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO snapshot_facts (source, category, label, value, dedup_hash) VALUES ('facebook', 'ad-profile', 'Interest', 'Woodworking', 'fh-1')"
      )
      .run()

    projectAllToRecords()
    const bySource = Object.fromEntries(
      (
        sqlite.prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source').all() as Array<{
          source: string
          n: number
        }>
      ).map((r) => [r.source, r.n])
    )
    expect(bySource.travel).toBe(1)
    expect(bySource.paystub).toBe(1)
    expect(bySource.utility).toBe(1)
    expect(bySource.goal).toBe(1)
    expect(bySource['rental-comp']).toBe(1)
    expect(bySource.facebook).toBe(1) // the snapshot fact, as an undated 'fact' record

    // Facts are searchable but undated — never on the dated timeline.
    const fact = sqlite.prepare("SELECT occurred_at FROM records WHERE type='fact'").get() as {
      occurred_at: number | null
    }
    expect(fact.occurred_at).toBeNull()

    // Whole-run idempotency: nothing duplicates on re-projection.
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }
    projectAllToRecords()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: before.n })
  })

  it('deleting a trip / goal / comp reconcile-deletes its spine row', () => {
    sqlite
      .prepare(
        "INSERT INTO travel_segments (id, country, start_date, end_date) VALUES (4, 'CR', '2026-02-01', '2026-02-14')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO financial_goals (id, name, created_at) VALUES (2, 'Fund', 1750000000000)"
      )
      .run()
    projectAllToRecords()
    sqlite.prepare('DELETE FROM travel_segments').run()
    sqlite.prepare('DELETE FROM financial_goals').run()
    projectAllToRecords()
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE source IN ('travel','goal')").get()
    ).toEqual({ n: 0 })
  })
})

describe('runSpineExpansionBackfillIfNeeded', () => {
  it('projects once, writes the gate key, and no-ops on later launches', () => {
    sqlite.prepare("INSERT INTO habits (id, name) VALUES (1, 'Run')").run()
    sqlite
      .prepare("INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, '2026-07-01', 1)")
      .run()

    const first = runSpineExpansionBackfillIfNeeded(sqlite)
    expect(first.ran).toBe(true)
    expect(first.imported).toBe(1)
    expect(
      sqlite
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(SPINE_EXPANSION_BACKFILL_KEY)
    ).toBeTruthy()

    const second = runSpineExpansionBackfillIfNeeded(sqlite)
    expect(second.ran).toBe(false)
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
