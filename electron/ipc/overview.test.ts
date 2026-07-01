/**
 * buildOverview — composes the storehouse rollup + timeline stats + derived-entity
 * suggestions over an in-memory DB.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { buildOverview } from './overview'

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
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
      status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, payment_account TEXT, cancel_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'other',
      name TEXT NOT NULL, value REAL, provider TEXT, reference TEXT, renewal_date TEXT,
      status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
    CREATE UNIQUE INDEX derived_entities_kind_key ON derived_entities (kind, match_key);
  `)
  return { db: drizzle(sqlite, { schema }), sqlite }
}

const day = (iso: string) => new Date(iso).getTime()
let seq = 0
function rec(sqlite: Database.Database, source: string, iso: string): void {
  sqlite
    .prepare('INSERT INTO records (source,type,title,occurred_at,dedup_hash) VALUES (?,?,?,?,?)')
    .run(source, 'event', `${source} event`, day(iso), `h${seq++}`)
}
function ent(
  sqlite: Database.Database,
  kind: string,
  key: string,
  name: string,
  count: number,
  opts: { attrs?: object; promotedKind?: string; promotedId?: number } = {}
): void {
  sqlite
    .prepare(
      'INSERT INTO derived_entities (kind,match_key,name,count,sources,last_seen,attrs,promoted_kind,promoted_id) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      kind,
      key,
      name,
      count,
      '["x"]',
      day('2026-03-01'),
      opts.attrs ? JSON.stringify(opts.attrs) : null,
      opts.promotedKind ?? null,
      opts.promotedId ?? null
    )
}

describe('buildOverview', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: Database.Database
  beforeEach(() => {
    seq = 0
    ;({ db, sqlite } = makeDb())
  })

  it('rolls up timeline stats, suggestions, and the storehouse summary', () => {
    rec(sqlite, 'linkedin', '2020-01-01')
    rec(sqlite, 'paypal', '2026-03-01')
    rec(sqlite, 'paypal', '2026-02-01')

    ent(sqlite, 'person', 'jane doe', 'Jane Doe', 5)
    ent(sqlite, 'person', 'bob smith', 'Bob Smith', 3, { promotedKind: 'contact', promotedId: 1 })
    ent(sqlite, 'subscription-candidate', 'netflix', 'Netflix', 4, {
      attrs: { cadence: 'monthly', annualCost: 191.88 }
    })
    ent(sqlite, 'merchant', 'amazon', 'Amazon', 9)
    ent(sqlite, 'place', 'central park', 'Central Park', 2)

    sqlite
      .prepare("INSERT INTO contacts (external_id, display_name) VALUES ('c1', 'Bob Smith')")
      .run()
    sqlite
      .prepare(
        "INSERT INTO subscriptions (external_id, name, cost, cadence, status) VALUES ('s1','Spotify',10,'monthly','active')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO assets (external_id, name, type, value, status) VALUES ('a1','Car','vehicle',1000,'active')"
      )
      .run()

    const o = buildOverview(db, new Date('2026-03-15'))

    // Timeline
    expect(o.timeline.records).toBe(3)
    expect(o.timeline.sources).toBe(2)

    // Suggestions
    expect(o.suggestions.peopleUnpromoted).toBe(1) // Jane (Bob is promoted)
    expect(o.suggestions.subscriptionsUntracked).toBe(1)
    expect(o.suggestions.merchants).toBe(1)
    expect(o.suggestions.places).toBe(1)
    expect(o.suggestions.topPeople[0]).toMatchObject({ name: 'Jane Doe', count: 5 })
    expect(o.suggestions.topSubscriptions[0]).toMatchObject({
      name: 'Netflix',
      cadence: 'monthly',
      annualCost: 191.88
    })

    // Storehouse rollup
    expect(o.storehouse.contacts.count).toBe(1)
    expect(o.storehouse.subscriptions.activeCount).toBe(1)
    expect(o.storehouse.subscriptions.annualTotal).toBe(120)
    expect(o.storehouse.assets.count).toBe(1)
    expect(o.storehouse.assets.totalValue).toBe(1000)
  })

  it('returns zeroed suggestions on an empty database', () => {
    const o = buildOverview(db, new Date('2026-03-15'))
    expect(o.timeline.records).toBe(0)
    expect(o.suggestions.peopleUnpromoted).toBe(0)
    expect(o.suggestions.topPeople).toEqual([])
    expect(o.suggestions.topSubscriptions).toEqual([])
  })
})
