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
  CREATE TABLE place_merge_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, survivor_place_id INTEGER NOT NULL,
    kind TEXT NOT NULL, alias_key TEXT NOT NULL, alias_name TEXT, created_at INTEGER
  );
  CREATE UNIQUE INDEX place_merge_aliases_kind_alias_unique ON place_merge_aliases (kind, alias_key);
  CREATE TABLE curation_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER
  );
  CREATE UNIQUE INDEX curation_exclusions_kind_target ON curation_exclusions (kind, target);
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
  CREATE TABLE location_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
    lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
    src TEXT NOT NULL, dedup_hash TEXT NOT NULL UNIQUE, ingested_at INTEGER
  );
  CREATE INDEX idx_location_points_occurred_at ON location_points (occurred_at);
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
  occurredAt?: number | null
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
      over.occurredAt === undefined ? 1700000000000 + seq : over.occurredAt,
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

function seedAlias(survivorPlaceId: number, aliasKey: string, kind = 'place'): void {
  sqlite
    .prepare(
      'INSERT INTO place_merge_aliases (survivor_place_id, kind, alias_key) VALUES (?, ?, ?)'
    )
    .run(survivorPlaceId, kind, aliasKey)
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

  it('rolls up visits matched under a merged-in alias into the survivor', () => {
    const survivorId = seedPlace()
    seedAlias(survivorId, 'blue bottle downtown')
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Coffee',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10')
    })
    // Matched under the LOSER's old key — still attributes to the survivor.
    seedRecord({
      source: 'uber',
      type: 'ride',
      title: 'Ride',
      body: 'Blue Bottle Downtown',
      occurredAt: ms('2026-03-02')
    })

    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list).toHaveLength(1)
    expect(list[0].live).toEqual({
      visitCount: 2,
      firstVisit: ms('2026-01-10'),
      lastVisit: ms('2026-03-02'),
      topSource: 'gcal'
    })
  })

  it('derives and caches meta.geo from GPS clusters around visits', () => {
    const id = seedPlace()
    const insPt = sqlite.prepare(
      `INSERT INTO location_points (occurred_at, lat, lng, accuracy, src, dedup_hash)
       VALUES (?, ?, ?, 10, 'gpx', ?)`
    )
    let pt = 0
    for (const day of ['2026-01-10', '2026-01-17', '2026-01-24']) {
      const t = ms(`${day}T18:00:00Z`)
      seedRecord({
        source: 'gcal',
        type: 'event',
        title: 'Class',
        body: 'Blue Bottle Cafe',
        occurredAt: t
      })
      for (let i = 0; i < 4; i++) {
        insPt.run(t + i * 600_000, 9.8644 + i * 0.0002, -83.9194 - i * 0.0002, `pt${pt++}`)
      }
    }

    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list[0].meta?.geo).toMatchObject({ lat: 9.86, lng: -83.92, visitCount: 3 })
    // Persisted — the row now carries the cached coordinate.
    const row = sqlite.prepare('SELECT meta FROM places WHERE id = ?').get(id) as { meta: string }
    expect(JSON.parse(row.meta).geo.lat).toBe(9.86)
  })

  it('caches a negative geo result so it is not recomputed every load', () => {
    seedPlace()
    // One visit, no GPS points near it — correlation fails, but points exist
    // elsewhere so the geo pass runs.
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Class',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10T18:00:00Z')
    })
    sqlite
      .prepare(
        `INSERT INTO location_points (occurred_at, lat, lng, accuracy, src, dedup_hash)
         VALUES (?, 26.71, -80.05, 10, 'gpx', 'far')`
      )
      .run(ms('2025-06-01'))

    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list[0].meta?.geo?.lat).toBeUndefined()
    expect(list[0].meta?.geo?.visitCount).toBe(1)
    // Second load returns the cached attempt unchanged (same computedAt).
    const again = invoke('places:list-tracked') as TrackedPlace[]
    expect(again[0].meta?.geo?.computedAt).toBe(list[0].meta?.geo?.computedAt)
  })

  it('an undated visit does not corrupt firstVisit/lastVisit when dated visits exist', () => {
    // indexVisitsByKey sorts null occurredAt first (treated as epoch 0), so
    // naively reading visits[0]/visits[last] would read a null firstVisit
    // even though two dated visits exist — regression for that bug.
    seedPlace()
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'No date on this one',
      body: 'Blue Bottle Cafe',
      occurredAt: null
    })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Early visit',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10')
    })
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Late visit',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-03-02')
    })
    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list[0].live).toEqual({
      visitCount: 3,
      firstVisit: ms('2026-01-10'),
      lastVisit: ms('2026-03-02'),
      topSource: 'gcal'
    })
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

  it('includes visits matched under a merged-in alias', () => {
    const id = seedPlace()
    seedAlias(id, 'blue bottle downtown')
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Coffee',
      body: 'Blue Bottle Cafe',
      occurredAt: ms('2026-01-10')
    })
    seedRecord({
      source: 'uber',
      type: 'ride',
      title: 'Ride',
      body: 'Blue Bottle Downtown',
      occurredAt: ms('2026-03-02')
    })

    const p = invoke('places:profile', id) as PlaceProfile
    expect(p.stats.visitCount).toBe(2)
    expect(p.visits).toHaveLength(2)
    expect(p.visits[0].title).toBe('Ride') // newest first
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

  it('does not leak a merchant row through the places surface', () => {
    const merchantId = seedPlace({
      externalId: 'derived:merchant:amazon',
      name: 'Amazon',
      kind: 'merchant'
    })
    expect(() => invoke('places:profile', merchantId)).toThrow()
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

  it('cannot mutate a merchant row through the places surface', () => {
    const merchantId = seedPlace({
      externalId: 'derived:merchant:amazon',
      name: 'Amazon',
      kind: 'merchant'
    })
    expect(() => invoke('places:update', merchantId, { category: 'Shopping' })).toThrow()
    const row = sqlite.prepare('SELECT category FROM places WHERE id = ?').get(merchantId) as {
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

  it('cannot delete a tracked merchant through the places surface', () => {
    const merchantId = seedPlace({
      externalId: 'derived:merchant:amazon',
      name: 'Amazon',
      kind: 'merchant'
    })
    expect(invoke('places:untrack', merchantId)).toEqual({ success: true })
    expect(sqlite.prepare('SELECT COUNT(*) n FROM places').get()).toEqual({ n: 1 })
  })

  it('untracking a merge survivor reverts everything it absorbed back to Discovered', () => {
    const survivorId = seedPlace()
    seedAlias(survivorId, 'blue bottle downtown')
    sqlite
      .prepare(
        `INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id)
         VALUES ('place', 'blue bottle downtown', 'Blue Bottle Downtown', 'place', ?)`
      )
      .run(survivorId)

    invoke('places:untrack', survivorId)
    const de = sqlite
      .prepare(
        "SELECT promoted_kind AS pk, promoted_id AS pid FROM derived_entities WHERE match_key='blue bottle downtown'"
      )
      .get() as { pk: string | null; pid: number | null }
    expect(de.pk).toBeNull()
    expect(de.pid).toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) n FROM place_merge_aliases').get()).toEqual({ n: 0 })
  })
})

describe('places:merge', () => {
  it('folds scalar fields, repoints documents/derived_entities, and deletes the loser', () => {
    const survivorId = seedPlace({ name: 'Blue Bottle Cafe' })
    sqlite.prepare('UPDATE places SET category = ? WHERE id = ?').run('Cafe', survivorId)
    const loserId = seedPlace({
      externalId: 'derived:place:blue bottle downtown',
      name: 'Blue Bottle Downtown'
    })
    sqlite
      .prepare('UPDATE places SET address = ?, notes = ? WHERE id = ?')
      .run('123 Main St', 'Great oat milk', loserId)

    sqlite
      .prepare(
        `INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id)
         VALUES ('place', 'blue bottle downtown', 'Blue Bottle Downtown', 'place', ?)`
      )
      .run(loserId)
    sqlite
      .prepare(
        `INSERT INTO documents (title, file_name, sha256, stored_path)
         VALUES ('Receipt', 'r.pdf', 'sha', 'docs/r.pdf')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO document_links (document_id, target_kind, target_id)
         VALUES (1, 'place', 'derived:place:blue bottle downtown')`
      )
      .run()

    const res = invoke('places:merge', {
      kind: 'place',
      survivorId,
      loserIds: [loserId]
    }) as { success: boolean }
    expect(res.success).toBe(true)

    const survivor = sqlite.prepare('SELECT * FROM places WHERE id = ?').get(survivorId) as {
      category: string
      address: string
      notes: string
    }
    expect(survivor.category).toBe('Cafe') // survivor's own value kept
    expect(survivor.address).toBe('123 Main St') // filled in from the loser
    expect(survivor.notes).toBe('Great oat milk')

    expect(sqlite.prepare('SELECT COUNT(*) n FROM places WHERE id = ?').get(loserId)).toEqual({
      n: 0
    })
    const alias = sqlite
      .prepare('SELECT survivor_place_id AS sid FROM place_merge_aliases WHERE alias_key = ?')
      .get('blue bottle downtown') as { sid: number }
    expect(alias.sid).toBe(survivorId)
    const de = sqlite
      .prepare(
        "SELECT promoted_id AS pid FROM derived_entities WHERE match_key='blue bottle downtown'"
      )
      .get() as { pid: number }
    expect(de.pid).toBe(survivorId)
    const link = sqlite
      .prepare('SELECT target_id AS tid FROM document_links WHERE document_id = 1')
      .get() as { tid: string }
    expect(link.tid).toBe('derived:place:blue bottle cafe')
  })

  it('a transaction/visit keyed to the loser now resolves through the survivor', () => {
    const survivorId = seedPlace({ name: 'Blue Bottle Cafe' })
    const loserId = seedPlace({
      externalId: 'derived:place:blue bottle downtown',
      name: 'Blue Bottle Downtown'
    })
    invoke('places:merge', { kind: 'place', survivorId, loserIds: [loserId] })

    // Ingested AFTER the merge, under the loser's old key — still attributes.
    seedRecord({
      source: 'gcal',
      type: 'event',
      title: 'Coffee',
      body: 'Blue Bottle Downtown',
      occurredAt: ms('2026-04-01')
    })
    const list = invoke('places:list-tracked') as TrackedPlace[]
    expect(list).toHaveLength(1)
    expect(list[0].live?.visitCount).toBe(1)
  })

  it('carries forward aliases from a survivor that was itself merged earlier (transitive)', () => {
    const a = seedPlace({ externalId: 'derived:place:a', name: 'A' })
    const b = seedPlace({ externalId: 'derived:place:b', name: 'B' })
    const c = seedPlace({ externalId: 'derived:place:c', name: 'C' })
    invoke('places:merge', { kind: 'place', survivorId: b, loserIds: [a] })
    invoke('places:merge', { kind: 'place', survivorId: c, loserIds: [b] })

    const rows = sqlite
      .prepare('SELECT survivor_place_id AS sid, alias_key AS key FROM place_merge_aliases')
      .all() as Array<{ sid: number; key: string }>
    expect(rows.every((r) => r.sid === c)).toBe(true)
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(['a', 'b']))
  })

  it('returns success:false for an unknown survivor or when no losers match', () => {
    const survivorId = seedPlace()
    expect(
      invoke('places:merge', { kind: 'place', survivorId: 999, loserIds: [survivorId] })
    ).toEqual({
      success: false
    })
    expect(invoke('places:merge', { kind: 'place', survivorId, loserIds: [999] })).toEqual({
      success: false
    })
  })

  it('never merges across kinds', () => {
    const placeId = seedPlace({ name: 'Blue Bottle', kind: 'place' })
    const merchantId = seedPlace({
      externalId: 'derived:merchant:blue bottle',
      name: 'Blue Bottle',
      kind: 'merchant'
    })
    // Asking to merge a merchant id into a place-kind merge is rejected — the
    // merchant row simply doesn't match the kind='place' filter, so it's
    // treated as an unmatched loser (0 rows merged).
    expect(
      invoke('places:merge', { kind: 'place', survivorId: placeId, loserIds: [merchantId] })
    ).toEqual({ success: false })
    expect(sqlite.prepare('SELECT COUNT(*) n FROM places').get()).toEqual({ n: 2 })
  })
})

describe('places:suggest-survivor', () => {
  it('prefers the row with the richer profile', () => {
    const sparse = seedPlace({ externalId: 'derived:place:a', name: 'A' })
    const rich = seedPlace({ externalId: 'derived:place:b', name: 'B' })
    sqlite
      .prepare('UPDATE places SET category = ?, address = ?, notes = ? WHERE id = ?')
      .run('Cafe', '123 Main St', 'Great coffee', rich)

    const res = invoke('places:suggest-survivor', {
      kind: 'place',
      ids: [sparse, rich]
    }) as { survivorId: number }
    expect(res.survivorId).toBe(rich)
  })
})

describe('places:duplicates / places:dismiss-duplicate', () => {
  it('suggests a fuzzy pair and forgets it once dismissed', () => {
    const a = seedPlace({ externalId: 'derived:place:starbucks', name: 'Starbucks' })
    const b = seedPlace({
      externalId: 'derived:place:starbucks coffee 4521',
      name: 'Starbucks Coffee #4521'
    })

    const pairs = invoke('places:duplicates', { kind: 'place' }) as Array<{
      a: { id: number }
      b: { id: number }
    }>
    expect(pairs).toHaveLength(1)
    expect(new Set([pairs[0].a.id, pairs[0].b.id])).toEqual(new Set([a, b]))

    const rowA = sqlite.prepare('SELECT external_id FROM places WHERE id = ?').get(a) as {
      external_id: string
    }
    const rowB = sqlite.prepare('SELECT external_id FROM places WHERE id = ?').get(b) as {
      external_id: string
    }
    invoke('places:dismiss-duplicate', {
      aExternalId: rowA.external_id,
      bExternalId: rowB.external_id
    })
    expect(invoke('places:duplicates', { kind: 'place' })).toEqual([])
  })
})
