/**
 * Tests for the expanded-MCP-surface readers (Phase 7 Track C): range
 * normalization/validation and the two query helpers against a real
 * in-memory SQLite mirroring the app schema's relevant columns.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RECENT_NOTES,
  MAX_TASK_RANGE_DAYS,
  TIMELINE_SEARCH_MAX,
  normalizeTaskRange,
  readRecentNotes,
  readTasksRange,
  readTimelineSearch,
  readTimelineSummary
} from './readers.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'personal',
      checked INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual'
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0
    );
  `)
})

afterEach(() => {
  db.close()
})

const NOW = new Date('2026-06-15T12:00:00')

describe('normalizeTaskRange', () => {
  it('defaults to a rolling week from today', () => {
    expect(normalizeTaskRange(undefined, undefined, NOW)).toEqual({
      ok: true,
      from: '2026-06-15',
      to: '2026-06-21'
    })
  })

  it('rejects malformed dates, inverted ranges, and oversized ranges', () => {
    expect(normalizeTaskRange('june 1', undefined, NOW).ok).toBe(false)
    expect(normalizeTaskRange('2026-06-15', '2026-06-10', NOW).ok).toBe(false)
    const big = normalizeTaskRange('2026-01-01', '2026-12-31', NOW)
    expect(big).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${MAX_TASK_RANGE_DAYS}`)
    })
  })
})

describe('readTasksRange', () => {
  function addTask(date: string, title: string, checked = 0, listType = 'daily'): void {
    db.prepare(
      'INSERT INTO checklist_items (list_type, list_date, title, checked) VALUES (?, ?, ?, ?)'
    ).run(listType, date, title, checked)
  }

  it('returns daily tasks in the range ordered by date, excluding other list types', () => {
    addTask('2026-06-16', 'tomorrow')
    addTask('2026-06-15', 'today done', 1)
    addTask('2026-06-22', 'next week')
    addTask('2026-06-15', 'weekly item', 0, 'weekly')

    const rows = readTasksRange(db, '2026-06-15', '2026-06-21')
    expect(rows.map((r) => r.title)).toEqual(['today done', 'tomorrow'])
    expect(rows[0].listDate).toBe('2026-06-15')
  })

  it('filters out checked tasks when includeChecked is false', () => {
    addTask('2026-06-15', 'done', 1)
    addTask('2026-06-15', 'open', 0)
    const rows = readTasksRange(db, '2026-06-15', '2026-06-15', false)
    expect(rows.map((r) => r.title)).toEqual(['open'])
  })
})

describe('readRecentNotes', () => {
  function addNote(path: string, title: string, lastModified: number | null): void {
    db.prepare('INSERT INTO knowledge_files (path, title, last_modified) VALUES (?, ?, ?)').run(
      path,
      title,
      lastModified
    )
  }

  it('returns newest-first, skips never-modified rows, and caps the limit', () => {
    addNote('a.md', 'Oldest', 1000)
    addNote('b.md', 'Newest', 3000)
    addNote('c.md', 'Middle', 2000)
    addNote('d.md', 'No timestamp', null)

    const rows = readRecentNotes(db, 2)
    expect(rows.map((r) => r.title)).toEqual(['Newest', 'Middle'])

    // Pathological limits clamp instead of throwing.
    expect(readRecentNotes(db, 9999)).toHaveLength(3)
    expect(readRecentNotes(db, -5)).toHaveLength(1)
    expect(MAX_RECENT_NOTES).toBe(50)
  })
})

describe('readTimelineSummary', () => {
  function createRecords(): void {
    db.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT
      );
    `)
  }

  it('returns an empty summary when the records table does not exist', () => {
    // The shared setup creates no `records` table (older DB before the migration).
    expect(readTimelineSummary(db)).toEqual({
      total: 0,
      sources: [],
      kinds: [],
      span: null,
      byYear: []
    })
  })

  it('aggregates by source, kind, and UTC year — never raw titles', () => {
    createRecords()
    const ins = db.prepare(
      'INSERT INTO records (source, type, occurred_at, title) VALUES (?, ?, ?, ?)'
    )
    ins.run('paypal', 'payment', Date.UTC(2019, 5, 15), 'Coffee — 4.50 USD')
    ins.run('venmo', 'payment', Date.UTC(2019, 8, 1), 'Split dinner')
    ins.run('netflix', 'watch', Date.UTC(2022, 0, 3), 'Some Show')
    ins.run('amazon', 'order', null, 'Undated order') // excluded from span/byYear

    const out = readTimelineSummary(db)
    expect(out.total).toBe(4)
    expect(out.kinds.find((k) => k.kind === 'payment')?.count).toBe(2)
    expect(out.sources.find((s) => s.source === 'paypal')?.count).toBe(1)
    expect(out.span).toEqual({ earliestYear: 2019, latestYear: 2022 })
    expect(out.byYear).toEqual([
      { year: 2019, count: 2 },
      { year: 2022, count: 1 }
    ])
    // Content-light invariant: no record titles in the summary.
    expect(JSON.stringify(out)).not.toContain('Coffee')
  })

  it('returns an empty summary for an existing-but-empty records table', () => {
    createRecords()
    expect(readTimelineSummary(db).total).toBe(0)
  })
})

describe('readTimelineSearch (raw timeline retrieval — Phase 10.7)', () => {
  function createFts(): void {
    db.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
        title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    `)
  }
  function add(
    source: string,
    type: string,
    title: string,
    occurredAt: number | null,
    body?: string
  ): void {
    db.prepare(
      'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
    ).run(source, type, occurredAt, title, body ?? null, `${source}|${title}`)
  }

  it('returns the actual matching records with date / source / kind / title', () => {
    createFts()
    add('amazon', 'order', 'Echo Dot', Date.UTC(2021, 2, 1), 'smart speaker')
    add('netflix', 'watch', 'The Matrix', Date.UTC(2022, 5, 1))
    const res = readTimelineSearch(db, { q: 'echo' })
    expect(res.count).toBe(1)
    expect(res.records[0]).toMatchObject({
      source: 'amazon',
      type: 'order',
      title: 'Echo Dot',
      date: '2021-03-01',
      detail: 'smart speaker'
    })
  })

  it('honors source + date filters', () => {
    createFts()
    add('amazon', 'order', 'Coffee beans', Date.UTC(2020, 0, 1))
    add('venmo', 'payment', 'Coffee with Sam', Date.UTC(2024, 0, 1))
    expect(
      readTimelineSearch(db, { q: 'coffee', source: 'amazon' }).records.map((r) => r.title)
    ).toEqual(['Coffee beans'])
    expect(
      readTimelineSearch(db, { q: 'coffee', from: '2023-01-01' }).records.map((r) => r.title)
    ).toEqual(['Coffee with Sam'])
  })

  it(`caps results at ${TIMELINE_SEARCH_MAX} and flags more`, () => {
    createFts()
    for (let i = 0; i < 40; i++) add('email', 'email', `Meeting notes ${i}`, null)
    const res = readTimelineSearch(db, { q: 'meeting', limit: 999 })
    expect(res.count).toBeLessThanOrEqual(TIMELINE_SEARCH_MAX)
    expect(res.note).toBeTruthy()
  })

  it('falls back gracefully when the FTS index / records table is absent (legacy DB)', () => {
    // No createFts() — mirrors a DB that predates the Converse migration.
    const res = readTimelineSearch(db, { q: 'anything' })
    expect(res).toMatchObject({ count: 0, records: [] })
    expect(res.note).toBeTruthy()
  })

  it('returns nothing for an empty query (no FTS syntax error)', () => {
    createFts()
    expect(readTimelineSearch(db, { q: '   ' })).toMatchObject({ count: 0, records: [] })
  })
})
