/**
 * Full-text timeline search (Phase 10.7 — "Converse").
 *
 * Real in-memory SQLite with the SAME `records_fts` external-content FTS5 table +
 * triggers that `electron/db/client.ts` creates, so this proves both the query
 * helpers AND the index-sync contract: inserts/updates/deletes stay in sync, the
 * `'rebuild'` backfill indexes pre-existing rows (the upgrade path), payload is
 * searchable, and bm25 weights title above payload.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchRecords, toFtsMatchQuery } from './records-search'

// Mirrors electron/db/client.ts ensureNewTables (records + records_fts + triggers).
const RECORDS_DDL = `CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
  title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
);`
const FTS_DDL = `
CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); END;
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
`

let sqlite: Database.Database

function insert(r: {
  source: string
  type: string
  occurredAt?: number | null
  title: string
  body?: string | null
  payload?: string | null
}): void {
  sqlite
    .prepare(
      'INSERT INTO records (source,type,occurred_at,title,body,payload,dedup_hash) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      r.source,
      r.type,
      r.occurredAt ?? null,
      r.title,
      r.body ?? null,
      r.payload ?? null,
      `${r.source}|${r.title}` // dedup_hash is not under test here
    )
}

const MS = (iso: string): number => Date.parse(iso)

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(RECORDS_DDL)
  sqlite.exec(FTS_DDL)
})
afterEach(() => sqlite.close())

describe('toFtsMatchQuery', () => {
  it('quotes each token and prefix-matches the last', () => {
    expect(toFtsMatchQuery('amazon order')).toBe('"amazon" "order"*')
    expect(toFtsMatchQuery('amaz')).toBe('"amaz"*')
  })
  it('returns null for empty / whitespace-only input', () => {
    expect(toFtsMatchQuery('')).toBeNull()
    expect(toFtsMatchQuery('   ')).toBeNull()
  })
  it('neutralizes FTS operators + punctuation as literal quoted terms (no syntax error)', () => {
    // "AND" must be a literal term, not the boolean operator; quotes are stripped.
    expect(toFtsMatchQuery('a AND b')).toBe('"a" "AND" "b"*')
    insert({ source: 'x', type: 'y', title: 'NEAR(foo) "bar" baz' })
    // A query full of FTS metacharacters must run without throwing.
    expect(() => searchRecords(sqlite, { q: 'NEAR(foo) "bar*' })).not.toThrow()
  })
})

describe('searchRecords', () => {
  beforeEach(() => {
    insert({
      source: 'amazon',
      type: 'order',
      occurredAt: MS('2021-03-01T00:00:00Z'),
      title: 'Echo Dot',
      body: 'smart speaker',
      payload: '{"seller":"AmazonFresh"}'
    })
    insert({
      source: 'netflix',
      type: 'watch',
      occurredAt: MS('2022-06-01T00:00:00Z'),
      title: 'The Matrix'
    })
    insert({
      source: 'spotify',
      type: 'listen',
      occurredAt: MS('2023-01-01T00:00:00Z'),
      title: 'Speaker Knockerz'
    })
  })

  it('matches in title, body, and payload', () => {
    expect(searchRecords(sqlite, { q: 'matrix' }).map((h) => h.title)).toEqual(['The Matrix'])
    expect(searchRecords(sqlite, { q: 'smart' }).map((h) => h.title)).toEqual(['Echo Dot'])
    // payload term (seller name in the JSON) is searchable
    expect(searchRecords(sqlite, { q: 'AmazonFresh' }).map((h) => h.title)).toEqual(['Echo Dot'])
  })

  it('ranks a title hit above a payload-only hit (bm25 weighting)', () => {
    // "speaker" is in Echo Dot's BODY and in Speaker Knockerz's TITLE.
    const hits = searchRecords(sqlite, { q: 'speaker' })
    expect(hits.map((h) => h.title)).toEqual(['Speaker Knockerz', 'Echo Dot'])
  })

  it('applies source / type / date filters alongside the match', () => {
    insert({
      source: 'amazon',
      type: 'order',
      title: 'Speaker stand',
      occurredAt: MS('2024-01-01T00:00:00Z')
    })
    // Both amazon rows match "speaker" (Speaker stand in title, Echo Dot in body);
    // the title hit ranks first. The netflix/spotify "speaker" rows are filtered out.
    expect(searchRecords(sqlite, { q: 'speaker', source: 'amazon' }).map((h) => h.title)).toEqual([
      'Speaker stand',
      'Echo Dot'
    ])
    expect(searchRecords(sqlite, { q: 'speaker', type: 'listen' }).map((h) => h.title)).toEqual([
      'Speaker Knockerz'
    ])
    // date window excludes the 2023 + 2024 "speaker" rows
    expect(
      searchRecords(sqlite, { q: 'speaker', to: MS('2022-12-31T23:59:59Z') }).map((h) => h.title)
    ).toEqual(['Echo Dot'])
  })

  it('clamps limit and returns the hit shape', () => {
    const [hit] = searchRecords(sqlite, { q: 'matrix', limit: 9999 })
    expect(hit).toMatchObject({ source: 'netflix', type: 'watch', title: 'The Matrix' })
    expect(hit.occurredAt).toBe(MS('2022-06-01T00:00:00Z'))
    expect(typeof hit.titleSnippet).toBe('string')
  })

  it('returns [] for an empty query (no FTS syntax error)', () => {
    expect(searchRecords(sqlite, { q: '   ' })).toEqual([])
  })
})

describe('index sync (triggers + rebuild backfill)', () => {
  const matrixCount = (): number => searchRecords(sqlite, { q: 'matrix' }).length

  it('keeps the FTS index in sync on insert / update / delete', () => {
    insert({ source: 'netflix', type: 'watch', title: 'The Matrix' })
    expect(matrixCount()).toBe(1) // AFTER INSERT trigger
    sqlite.prepare("UPDATE records SET title = 'Inception' WHERE title = 'The Matrix'").run()
    expect(matrixCount()).toBe(0) // AFTER UPDATE trigger drops the old term
    expect(searchRecords(sqlite, { q: 'inception' }).length).toBe(1)
    sqlite.prepare("DELETE FROM records WHERE title = 'Inception'").run()
    expect(searchRecords(sqlite, { q: 'inception' }).length).toBe(0) // AFTER DELETE trigger
  })

  it("'rebuild' backfills rows that predate the index (the upgrade path)", () => {
    // Fresh DB where records exist BEFORE the FTS table (triggers never fired for them).
    const db2 = new Database(':memory:')
    db2.exec(RECORDS_DDL)
    db2
      .prepare('INSERT INTO records (source,type,title,dedup_hash) VALUES (?,?,?,?)')
      .run('amazon', 'order', 'Kindle Paperwhite', 'h1')
    db2.exec(FTS_DDL)
    const docsize = (): number =>
      (db2.prepare('SELECT COUNT(*) AS n FROM records_fts_docsize').get() as { n: number }).n
    expect(docsize()).toBe(0) // unindexed
    expect(searchRecords(db2, { q: 'kindle' }).length).toBe(0)
    db2.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')")
    expect(docsize()).toBe(1)
    expect(searchRecords(db2, { q: 'kindle' }).map((h) => h.title)).toEqual(['Kindle Paperwhite'])
    db2.close()
  })
})
