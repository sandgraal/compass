/**
 * Round-trips the derived-entity projection through an in-memory DB: seed
 * `records` + owned rows, run the refresh, assert the `derived_entities` cache.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { subscriptionKey } from './entities'
import { ensureDerivedEntities, refreshDerivedEntities } from './entities-projection'

function makeDb(): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
    CREATE UNIQUE INDEX derived_entities_kind_key ON derived_entities (kind, match_key);
    CREATE TABLE places (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
      name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
  `)
  return { db: drizzle(sqlite, { schema }), sqlite }
}

let seq = 0
function insertRecord(
  sqlite: Database.Database,
  source: string,
  type: string,
  title: string,
  body: string | null,
  iso: string | null
): void {
  sqlite
    .prepare(
      'INSERT INTO records (source, type, title, body, occurred_at, dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(source, type, title, body, iso ? new Date(iso).getTime() : null, `h${seq++}`)
}

describe('refreshDerivedEntities', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: Database.Database
  beforeEach(() => {
    seq = 0
    ;({ db, sqlite } = makeDb())
  })

  it('builds person + merchant + subscription rows and skips firehose sources', () => {
    insertRecord(sqlite, 'linkedin', 'connection', 'Connected with Jane Doe', null, '2026-01-01')
    insertRecord(
      sqlite,
      'facebook',
      'connection',
      'Became friends with Jane Doe',
      null,
      '2026-02-01'
    )
    for (const d of ['2026-01-15', '2026-02-15', '2026-03-15'])
      insertRecord(sqlite, 'paypal', 'payment', 'Netflix', '-15.99 USD', d)
    // Firehose source with no extractor — must be ignored.
    insertRecord(sqlite, 'browser', 'visit', 'Some Page', 'example.com', '2026-01-01')

    const { count } = refreshDerivedEntities(db)
    expect(count).toBeGreaterThan(0)

    const kinds = sqlite.prepare('SELECT kind, name FROM derived_entities').all() as {
      kind: string
      name: string
    }[]
    expect(kinds.find((k) => k.kind === 'person')?.name).toBe('Jane Doe')
    expect(kinds.find((k) => k.kind === 'merchant')?.name).toBe('Netflix')
    expect(kinds.find((k) => k.kind === 'subscription-candidate')?.name).toBe('Netflix')
    // The browser visit produced nothing.
    expect(kinds.some((k) => k.name === 'Some Page')).toBe(false)
  })

  it('links a derived person to an existing contact', () => {
    sqlite
      .prepare('INSERT INTO contacts (external_id, display_name) VALUES (?,?)')
      .run('manual:1', 'Jane Doe')
    insertRecord(sqlite, 'linkedin', 'connection', 'Connected with Jane Doe', null, '2026-01-01')

    refreshDerivedEntities(db)
    const person = sqlite
      .prepare("SELECT promoted_kind, promoted_id FROM derived_entities WHERE kind='person'")
      .get() as { promoted_kind: string; promoted_id: number }
    expect(person.promoted_kind).toBe('contact')
    expect(person.promoted_id).toBe(1)
  })

  it('flags a subscription candidate already tracked in the owned table', () => {
    sqlite
      .prepare('INSERT INTO subscriptions (external_id, name) VALUES (?,?)')
      .run(subscriptionKey('netflix', 'paypal'), 'netflix')
    for (const d of ['2026-01-15', '2026-02-15', '2026-03-15'])
      insertRecord(sqlite, 'paypal', 'payment', 'Netflix', '-15.99 USD', d)

    refreshDerivedEntities(db)
    const sub = sqlite
      .prepare("SELECT promoted_kind FROM derived_entities WHERE kind='subscription-candidate'")
      .get() as { promoted_kind: string }
    expect(sub.promoted_kind).toBe('subscription')
  })

  it('is a full replace — re-running does not duplicate rows', () => {
    insertRecord(sqlite, 'linkedin', 'connection', 'Connected with Jane Doe', null, '2026-01-01')
    refreshDerivedEntities(db)
    refreshDerivedEntities(db)
    const n = sqlite
      .prepare("SELECT COUNT(*) c FROM derived_entities WHERE kind='person'")
      .get() as {
      c: number
    }
    expect(n.c).toBe(1)
  })
})

describe('ensureDerivedEntities', () => {
  it('builds when empty and no-ops once populated', () => {
    const { db, sqlite } = makeDb()
    insertRecord(sqlite, 'linkedin', 'connection', 'Connected with Jane Doe', null, '2026-01-01')

    const first = ensureDerivedEntities(db)
    expect(first.built).toBe(true)
    expect(first.count).toBe(1)

    const second = ensureDerivedEntities(db)
    expect(second.built).toBe(false)
  })
})
