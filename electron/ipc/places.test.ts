/**
 * places IPC — tracked list w/ live visit stats, the profile aggregation
 * (visits + activity + documents), validated updates, manual create, the
 * untrack → un-promote contract, and the `promoteDerivedPlace` writer, over
 * a real in-memory DB (including records FTS for the activity feed).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { PlaceProfile, TrackedPlace } from './places'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
const invoke = (channel: string, ...args: unknown[]): unknown => handlers[channel]({}, ...args)

const DDL = `
  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
    name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER, meta TEXT
  );
  CREATE TABLE derived_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL,
    name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]',
    first_seen INTEGER, last_seen INTEGER, attrs TEXT, promoted_kind TEXT, promoted_id INTEGER,
    refreshed_at INTEGER
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
    mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL UNIQUE, stored_path TEXT NOT NULL,
    extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE document_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id),
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER
  );
  CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
    occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
    dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
  );
  CREATE VIRTUAL TABLE records_fts USING fts5(
    title, body, payload, content='records', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
  END;
`

let promoteDerivedPlace: typeof import('./places').promoteDerivedPlace

let seq = 0
function seedRecord(over: {
  source: string
  type: string
  title: string
  body?: string | null
  occurredAt?: number
}): void {
  seq++
  sqlite
    .prepare(
      `INSERT INTO records (source, type, occurred_at, title, body, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      over.source,
      over.type,
      over.occurredAt ?? 1700000000000 + seq,
      over.title,
      over.body ?? null,
      `d${seq}`
    )
}

function seedPlace(over?: { externalId?: string; name?: string; kind?: string }): number {
  const res = sqlite
    .prepare(
      `INSERT INTO places (external_id, kind, name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'derived', 0, 0)`
    )
    .run(
      over?.externalId ?? 'derived:place:blue bottle cafe',
      over?.kind ?? 'place',
      over?.name ?? 'Blue Bottle Cafe'
    )
  return Number(res.lastInsertRowid)
}

const ms = (iso: string): number => new Date(iso).getTime()

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
  for (const k of Object.keys(handlers)) delete handlers[k]
  const mod = await import('./places')
  mod.registerPlacesHandlers(fakeIpcMain as IpcMain)
  promoteDerivedPlace = mod.promoteDerivedPlace
})
afterEach(() => sqlite.close())

describe('promoteDerivedPlace', () => {
  it('inserts a merchant idempotently by its derived external id', () => {
    const a = promoteDerivedPlace('merchant', 'Amazon', 'amazon', { totalSpend: 42 })
    expect(a.alreadyExisted).toBe(false)
    const b = promoteDerivedPlace('merchant', 'Amazon', 'amazon')
    expect(b.alreadyExisted).toBe(true)
    expect(b.id).toBe(a.id)
    const rows = sqlite.prepare('SELECT COUNT(*) c FROM places').get() as { c: number }
    expect(rows.c).toBe(1)
  })
})

describe('places:list-tracked', () => {
  it('returns place rows with live visit stats, skipping kind=merchant', () => {
    seedPlace()
    seedPlace({ externalId: 'derived:merchant:amazon', name: 'Amazon', kind: 'merchant' })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Coffee with Ana',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10')
    })
    seedRecord({
      source: 'uber',
      type: 'ride',
      title: 'Ride',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-03-02')
    })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Elsewhere',
      body: 'Somewhere Else',
      occurredAt: ms('2026-02-01')
    })

    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list).toHaveLength(1)
    expect(list[0].matchKey).toBe('blue bottle cafe')
    expect(list[0].live).toEqual({
      visitCount: 2,
      firstVisit: ms('2026-01-10'),
      lastVisit: ms('2026-03-02'),
      topSource: 'gcal'
    })
  })

  it('a place with no matching records gets live: null', () => {
    seedPlace({ externalId: 'derived:place:ghost town', name: 'Ghost Town' })
    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list[0].live).toBeNull()
  })

  it('manual places match visits via their normalized name', () => {
    seedPlace({ externalId: 'manual:abc', name: 'Blue  Bottle Cafe' })
    seedRecord({ source: 'lyft', type: 'ride', title: 'Ride', body: 'blue bottle cafe' })
    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list[0].matchKey).toBe('blue bottle cafe')
    expect(list[0].live?.visitCount).toBe(1)
  })
})

describe('places:profile', () => {
  it('aggregates visits, stats, monthly buckets, and documents', () => {
    const id = seedPlace()
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Coffee',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10')
    })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'More coffee',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-20')
    })
    seedRecord({
      source: 'uber',
      type: 'ride',
      title: 'Ride home',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-03-02')
    })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Unrelated',
      body: 'Somewhere Else',
      occurredAt: ms('2026-02-01')
    })

    sqlite
      .prepare(
        `INSERT INTO documents (title, file_name, sha256, stored_path, doc_date, mime_type)
         VALUES ('Menu', 'm.pdf', 'sha', 'docs/m.pdf', '2026-01-10', 'application/pdf')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO document_links (document_id, target_kind, target_id)
         VALUES (1, 'place', 'derived:place:blue bottle cafe')`
      )
      .run()

    const p = invoke('places:profile', id) as PlaceProfile
    expect(p.matchKey).toBe('blue bottle cafe')
    expect(p.stats.visitCount).toBe(3)
    expect(p.stats.firstVisit).toBe(ms('2026-01-10'))
    expect(p.stats.lastVisit).toBe(ms('2026-03-02'))
    expect(p.stats.bySource).toEqual([
      { source: 'gcal', count: 2 },
      { source: 'uber', count: 1 }
    ])
    expect(p.monthly).toEqual([
      { month: '2026-01', visits: 2 },
      { month: '2026-03', visits: 1 }
    ])
    expect(p.visits[0].title).toBe('Ride home') // newest first
    expect(p.visits).toHaveLength(3)
    expect(p.documents).toEqual([
      {
        linkId: 1,
        documentId: 1,
        title: 'Menu',
        docDate: '2026-01-10',
        mimeType: 'application/pdf'
      }
    ])
  })

  it('activity surfaces timeline hits but filters visit-source records', () => {
    const id = seedPlace()
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Blue Bottle Cafe meetup',
      body: 'Blue Bottle Cafe'
    })
    seedRecord({
      source: 'email-receipt',
      type: 'order',
      title: 'Blue Bottle Cafe receipt'
    })
    const p = invoke('places:profile', id) as PlaceProfile
    expect(p.activity).toHaveLength(1)
    expect(p.activity[0]).toMatchObject({
      source: 'email-receipt',
      title: 'Blue Bottle Cafe receipt'
    })
  })

  it('throws for an unknown id', () => {
    expect(() => invoke('places:profile', 999)).toThrow()
  })
})

describe('places:update', () => {
  it('persists editable fields and bumps updatedAt', () => {
    const id = seedPlace()
    invoke('places:update', id, {
      category: 'Coffee shop',
      address: '123 Main St',
      url: 'https://bluebottle.com',
      notes: 'good wifi'
    })
    const row = sqlite.prepare('SELECT * FROM places WHERE id = ?').get(id) as {
      category: string
      address: string
      url: string
      notes: string
      updated_at: number
    }
    expect(row.category).toBe('Coffee shop')
    expect(row.address).toBe('123 Main St')
    expect(row.url).toBe('https://bluebottle.com')
    expect(row.notes).toBe('good wifi')
    expect(row.updated_at).toBeGreaterThan(0)
  })

  it('rejects a non-http url and an empty name', () => {
    const id = seedPlace()
    expect(() => invoke('places:update', id, { url: 'javascript:alert(1)' })).toThrow()
    expect(() => invoke('places:update', id, { name: '   ' })).toThrow()
  })

  it('clearing a field with null nulls the column', () => {
    const id = seedPlace()
    invoke('places:update', id, { category: 'Coffee shop' })
    invoke('places:update', id, { category: null })
    const row = sqlite.prepare('SELECT category FROM places WHERE id = ?').get(id) as {
      category: string | null
    }
    expect(row.category).toBeNull()
  })
})

describe('places:create-manual', () => {
  it('creates a manual place with a manual: external id', () => {
    const res = invoke('places:create-manual', {
      name: 'Grandma’s House',
      address: '456 Oak Ave'
    }) as { success: boolean; id: number }
    expect(res.success).toBe(true)
    const row = sqlite.prepare('SELECT * FROM places WHERE id = ?').get(res.id) as {
      external_id: string
      kind: string
      name: string
      address: string
      source: string
    }
    expect(row.external_id).toMatch(/^manual:/)
    expect(row.kind).toBe('place')
    expect(row.name).toBe('Grandma’s House')
    expect(row.address).toBe('456 Oak Ave')
    expect(row.source).toBe('manual')
  })

  it('rejects a missing name', () => {
    expect(() => invoke('places:create-manual', { name: '  ' })).toThrow()
    expect(() => invoke('places:create-manual', {})).toThrow()
  })
})

describe('places:untrack', () => {
  it('deletes the place and clears the projection promoted flags', () => {
    const id = seedPlace()
    sqlite
      .prepare(
        `INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id)
         VALUES ('place', 'blue bottle cafe', 'Blue Bottle Cafe', 'place', ?)`
      )
      .run(id)

    invoke('places:untrack', id)
    expect(sqlite.prepare('SELECT COUNT(*) n FROM places').get()).toEqual({ n: 0 })
    const de = sqlite
      .prepare('SELECT promoted_kind AS pk, promoted_id AS pid FROM derived_entities')
      .get() as { pk: string | null; pid: number | null }
    expect(de.pk).toBeNull()
    expect(de.pid).toBeNull()
  })

  it('untracking a manual place (no projection row) is fine, and missing ids are a no-op', () => {
    const id = seedPlace({ externalId: 'manual:xyz', name: 'Corner Spot' })
    expect(invoke('places:untrack', id)).toEqual({ success: true })
    expect(invoke('places:untrack', 999)).toEqual({ success: true })
  })
})
