/**
 * Netflix-refile executor — real in-memory SQLite through the production
 * insert paths. Proves misfiled rows leave source 'netflix' for their real
 * homes (prime-video records, google-saved snapshot facts, notes records),
 * real Netflix rows survive untouched, FTS stays consistent, refiled bookmarks
 * dedupe against existing Chrome-bookmark facts, and the launch gate is
 * one-shot.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../knowledge/records-extractor', () => ({ updateRecordsKnowledge: vi.fn() }))
vi.mock('../knowledge/records-embeddings', () => ({
  loadRecordsIndex: () => null,
  saveRecordsIndex: vi.fn(),
  buildRecordsEmbeddingsIndex: vi.fn(),
  searchRecordsSemantic: vi.fn(async () => null)
}))
vi.mock('../integrations/location-residency', () => ({ afterLocationImport: vi.fn() }))

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE location_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, src TEXT NOT NULL,
      dedup_hash TEXT NOT NULL UNIQUE, ingested_at INTEGER
    );
    CREATE TABLE snapshot_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, category TEXT NOT NULL,
      label TEXT, value TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL,
      name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]',
      first_seen INTEGER, last_seen INTEGER, attrs TEXT, promoted_kind TEXT, promoted_id INTEGER,
      refreshed_at INTEGER
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); END;
    CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
  `)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

function seedNetflix(title: string, provenance: string, payload: Record<string, unknown>): void {
  sqlite
    .prepare(
      "INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash, provenance) VALUES ('netflix', 'watch', NULL, ?, ?, ?, ?)"
    )
    .run(title, JSON.stringify(payload), `seed|${provenance}|${title}`, provenance)
}

async function loadModule() {
  return await import('./records')
}

const PV_ROW = {
  'Playback Start Datetime (UTC)': '2024-12-19T18:18:47Z',
  Title: '"Red One"',
  'Seconds Viewed': '5286.00000'
}
const PLACE_ROW = {
  Title: 'Villa Bosque',
  Note: '',
  URL: 'https://www.google.com/maps/place/Villa+Bosque',
  Tags: '',
  Comment: ''
}
const BOOKMARK_ROW = {
  Title: 'ToyoDIY.com',
  URL: 'http://www.toyodiy.com/',
  modifiedOn: 'Friday January 8,2021 2:06 PM GMT',
  favorite: 'no',
  deleted: 'no'
}
const NOTE_ROW = { Title: 'Hot sauce plan', ' Created On': '11-02-2025 11:21:42' }

describe('refileNetflixRecords', () => {
  it('re-files each family, keeps real Netflix rows, keeps FTS consistent', async () => {
    seedNetflix('The Pleasure of Your Company', 'NetflixViewingHistory.csv', {
      Title: 'The Pleasure of Your Company',
      Date: '8/31/08'
    })
    seedNetflix('"Red One"', 'PrimeVideo.ViewingHistory.csv', PV_ROW)
    seedNetflix('Villa Bosque', 'Want to go.csv', PLACE_ROW)
    seedNetflix('ToyoDIY.com', 'Bookmarks_1.csv', BOOKMARK_ROW)
    seedNetflix('Hot sauce plan', 'Notes Details.csv', NOTE_ROW)

    const mod = await loadModule()
    const res = mod.refileNetflixRecords()
    expect(res).toEqual({ moved: 2, facts: 2, deleted: 4 })

    // Real Netflix row untouched.
    expect(sqlite.prepare("SELECT title FROM records WHERE source='netflix'").all()).toEqual([
      { title: 'The Pleasure of Your Company' }
    ])
    // PV session re-sourced with unquoted title + real date.
    const pv = sqlite
      .prepare("SELECT title, occurred_at, body FROM records WHERE source='prime-video'")
      .get() as Record<string, unknown>
    expect(pv.title).toBe('Red One')
    expect(pv.occurred_at).toBe(Date.parse('2024-12-19T18:18:47Z'))
    expect(pv.body).toBe('Watched · 88 min')
    // Note re-sourced.
    expect(sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='notes'").get()).toEqual({
      n: 1
    })
    // Saved place + bookmark became google-saved snapshot facts.
    expect(
      sqlite
        .prepare(
          "SELECT label, value FROM snapshot_facts WHERE category='google-saved' ORDER BY label"
        )
        .all()
    ).toEqual([
      { label: 'Bookmark', value: 'ToyoDIY.com' },
      { label: 'Want to go', value: 'Villa Bosque' }
    ])

    // FTS consistent through the churn.
    const base = sqlite.prepare('SELECT count(*) AS n FROM records').get() as { n: number }
    const indexed = sqlite.prepare('SELECT count(*) AS n FROM records_fts_docsize').get() as {
      n: number
    }
    expect(indexed.n).toBe(base.n)

    // Idempotent: second run finds nothing to move.
    expect(mod.refileNetflixRecords()).toEqual({ moved: 0, facts: 0, deleted: 0 })
  })

  it('dedupes refiled bookmarks against existing Chrome-bookmark facts', async () => {
    const mod = await loadModule()
    // Existing fact with the same URL-keyed hash the Chrome recognizer writes.
    const { hashSnapshot } = await import('../lib/recognizers')
    sqlite
      .prepare(
        "INSERT INTO snapshot_facts (source, category, label, value, position, dedup_hash) VALUES ('google','google-saved','Bookmark','ToyoDIY.com',0,?)"
      )
      .run(hashSnapshot('google', 'google-saved', `Bookmark|${BOOKMARK_ROW.URL}`))
    seedNetflix('ToyoDIY.com', 'Bookmarks_1.csv', BOOKMARK_ROW)

    const res = mod.refileNetflixRecords()
    expect(res.deleted).toBe(1) // netflix row still removed…
    expect(sqlite.prepare('SELECT count(*) AS n FROM snapshot_facts').get()).toEqual({ n: 1 }) // …but no duplicate fact
  })
})

describe('runNetflixRefileIfNeeded', () => {
  it('runs once and then gates', async () => {
    seedNetflix('"Red One"', 'PrimeVideo.ViewingHistory.csv', PV_ROW)
    const mod = await loadModule()
    const first = mod.runNetflixRefileIfNeeded()
    expect(first.ran).toBe(true)
    expect(first.moved).toBe(1)
    expect(mod.runNetflixRefileIfNeeded()).toEqual({ ran: false })
  })
})
