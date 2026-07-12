/**
 * Reclassify executor (Timeline 2.0, PR 2) — real in-memory SQLite through the
 * production insert paths. Proves the full loop: mis-imported generic rows are
 * re-inserted under their real source with CORRECT dates (provenance
 * preserved), geolocation rows move OFF the records spine into
 * location_points, unmatched telemetry stays, FTS stays consistent, a
 * re-import of the same file dedupes against the reclassified rows, and the
 * app_settings gate makes the launch hook one-shot.
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

function seedGeneric(
  title: string,
  provenance: string,
  payload: Record<string, unknown>,
  occurredAt: number | null = null
): void {
  sqlite
    .prepare(
      "INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash, provenance) VALUES ('generic', 'event', ?, ?, ?, ?, ?)"
    )
    .run(occurredAt, title, JSON.stringify(payload), `seed|${title}`, provenance)
}

const PRIME_ROW = {
  TitleName: 'Welcome to Republic City',
  SecondsWatched: '36',
  MostRecentWatchDate: '2017-06-18T13:42:42Z',
  EntityType: 'TVEpisode'
}

async function loadModule() {
  return await import('./records')
}

describe('insertRecords occurred_at guardrail', () => {
  it('hashes the CLAMPED timestamp so identity matches storage', async () => {
    const mod = await loadModule()
    const base = {
      source: 'youtube',
      type: 'watch',
      title: 'A Video',
      naturalKey: 'video-1'
    }
    // Implausible timestamp (year ~2242) → stored UNDATED…
    const first = mod.insertRecords([{ ...base, occurredAt: 8583494400000 }], 'seed.json')
    expect(first.imported).toBe(1)
    const row = sqlite
      .prepare("SELECT occurred_at AS ms FROM records WHERE source = 'youtube'")
      .get() as { ms: number | null }
    expect(row.ms).toBeNull()
    // …and the same event re-arriving with a corrected/null date DEDUPES
    // instead of creating a second row (the hash encodes the clamped value).
    const again = mod.insertRecords([{ ...base, occurredAt: null }], 'seed.json')
    expect(again.imported).toBe(0)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM records WHERE source = 'youtube'").get()
    ).toEqual({ n: 1 })
  })
})

describe('reclassifyGenericRecords', () => {
  it('moves signal families to real sources, geolocation to location_points, keeps telemetry', async () => {
    // Stored with the WRONG date the old generic import produced (year 2036).
    seedGeneric('Welcome to Republic City', 'PrimeVideo.WatchEvent.1.csv', PRIME_ROW, 2082780000000)
    seedGeneric(
      'alexa stop',
      'Intent-1-1.csv',
      { 'Utterance text': 'alexa stop', 'Utterance Creation Date': '2026-04-21T16:12:36.937Z' },
      Date.parse('2026-04-21T16:12:36.937Z')
    )
    seedGeneric(
      '2023-06-08T00:30:36.252Z',
      'Geolocation-1-1.csv',
      {
        latitudeInDegrees: '9.936',
        longitudeInDegrees: '-84.087',
        coordinatesAccuracyInMeters: '17.5',
        eventDate: '2023-06-08T00:30:36.252Z'
      },
      Date.parse('2023-06-08T00:30:36.252Z')
    )
    seedGeneric('telemetry blob', 'DeviceState-1-1.csv', { state: 'ON' }, 1686184236252)

    const mod = await loadModule()
    const res = mod.reclassifyGenericRecords()
    expect(res).toEqual({ moved: 2, located: 1, deleted: 3 })

    const prime = sqlite
      .prepare("SELECT * FROM records WHERE source = 'prime-video'")
      .get() as Record<string, unknown>
    expect(prime.title).toBe('Welcome to Republic City')
    expect(prime.occurred_at).toBe(Date.parse('2017-06-18T13:42:42Z')) // corrected
    expect(prime.provenance).toBe('PrimeVideo.WatchEvent.1.csv') // preserved

    expect(sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='alexa'").get()).toEqual({
      n: 1
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='generic'").get()
    ).toEqual({ n: 1 }) // telemetry stays
    expect(sqlite.prepare('SELECT lat, lng, src FROM location_points').get()).toEqual({
      lat: 9.936,
      lng: -84.087,
      src: 'amazon-device'
    })

    // FTS stayed consistent through the insert+delete churn.
    const base = sqlite.prepare('SELECT count(*) AS n FROM records').get() as { n: number }
    const indexed = sqlite.prepare('SELECT count(*) AS n FROM records_fts_docsize').get() as {
      n: number
    }
    expect(indexed.n).toBe(base.n)

    // Second run: nothing left to convert.
    expect(mod.reclassifyGenericRecords()).toEqual({ moved: 0, located: 0, deleted: 0 })
  })

  it('lets a future re-import of the same file dedupe against reclassified rows', async () => {
    seedGeneric('Welcome to Republic City', 'PrimeVideo.WatchEvent.1.csv', PRIME_ROW, 2082780000000)
    const mod = await loadModule()
    mod.reclassifyGenericRecords()

    // Fresh import of the same row through the real recognizer path.
    const { PRIME_VIDEO_RECOGNIZER } = await import('../lib/amazon-export')
    const inputs = PRIME_VIDEO_RECOGNIZER.parse({
      name: 'PrimeVideo.WatchEvent.1.csv',
      ext: 'csv',
      text:
        'TitleName,SecondsWatched,MostRecentWatchDate,EntityType\n' +
        'Welcome to Republic City,36,2017-06-18T13:42:42Z,TVEpisode\n'
    })
    const { imported } = mod.insertRecords(inputs, 'PrimeVideo.WatchEvent.1.csv')
    expect(imported).toBe(0) // deduped — no duplicate row
  })
})

describe('runRecordsReclassifyIfNeeded', () => {
  it('runs once and then gates', async () => {
    seedGeneric('alexa stop', 'Intent-1-1.csv', {
      'Utterance text': 'alexa stop',
      'Utterance Creation Date': '2026-04-21T16:12:36.937Z'
    })
    const mod = await loadModule()
    const first = mod.runRecordsReclassifyIfNeeded()
    expect(first.ran).toBe(true)
    expect(first.moved).toBe(1)
    expect(mod.runRecordsReclassifyIfNeeded()).toEqual({ ran: false })
  })

  it('V2 re-runs on installs whose V1 gate is already consumed', async () => {
    const mod = await loadModule()
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run(mod.RECORDS_RECLASSIFY_KEY, '2026-07-09T18:48:11.149Z')
    seedGeneric(
      '2026-06-09 00:15:35.092',
      'rider_app_analytics-0.csv',
      {
        'Event Time (UTC)': '2026-06-09 00:15:27.887',
        'GPS Time (UTC)': '2026-06-09 00:15:24.694',
        'Horizontal Accuracy': '39.78507189614252',
        Latitude: '26.07069',
        Longitude: '-80.14414'
      },
      null
    )
    const res = mod.runRecordsReclassifyIfNeeded()
    expect(res.ran).toBe(true)
    expect(res.located).toBe(1)
    expect(sqlite.prepare('SELECT src FROM location_points').get()).toEqual({
      src: 'amazon-rider'
    })
    // Consumed under the V2 key, not V1's.
    expect(
      sqlite
        .prepare('SELECT count(*) AS n FROM app_settings WHERE key = ?')
        .get(mod.RECORDS_RECLASSIFY_V2_KEY)
    ).toEqual({ n: 1 })
  })
})

describe('reclassifyGenericRecords — V2 families', () => {
  it('promotes rider GPS, digital items and gift-card rows; Digital Orders stays generic', async () => {
    seedGeneric(
      'G071R209316605QG',
      'Digital Orders.csv',
      { OrderId: 'D01-1', BillingAddress: 'X', OrderDate: '2025-09-25T00:44:00Z' } // no product name
    )
    seedGeneric('Amazon Music Unlimited', 'Digital Items.csv', {
      ASIN: 'B09W897871',
      ProductName: 'Amazon Music Unlimited',
      OrderId: 'D01-6241216-2422661',
      DigitalOrderItemId: 'RSMOBNVH3I8DQU27HKBJRFUV8IKKTK7EDS4EETU19HPK2IP728CG',
      OrderDate: '2025-09-25T00:44:00Z',
      OurPrice: '10.99',
      OurPriceCurrencyCode: 'USD'
    })
    seedGeneric('2554883066759615', 'Retail.GiftCertificates.Transaction.csv', {
      serialNumber: '2554883066759615',
      transactionDate: '2026-03-09T20:46:37Z',
      transactionType: 'Settlement',
      transactionAmount: '26.58',
      currencyCode: 'USD'
    })
    seedGeneric('tap', 'rider_app_analytics-0.csv', {
      'Event Time (UTC)': '2026-06-09 00:15:27.887',
      'GPS Time (UTC)': '2026-06-09 00:15:24.694',
      Latitude: '26.07069',
      Longitude: '-80.14414'
    })

    const mod = await loadModule()
    const res = mod.reclassifyGenericRecords()
    expect(res).toEqual({ moved: 2, located: 1, deleted: 3 })

    const amazonRows = sqlite
      .prepare("SELECT type, title FROM records WHERE source='amazon' ORDER BY type")
      .all()
    expect(amazonRows).toEqual([
      { type: 'gift-card', title: 'Gift card · 26.58 USD' },
      { type: 'order', title: 'Amazon Music Unlimited' }
    ])
    // The title-less Digital Orders row is deliberately unclaimed.
    expect(sqlite.prepare("SELECT provenance FROM records WHERE source='generic'").get()).toEqual({
      provenance: 'Digital Orders.csv'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM location_points').get()).toEqual({ n: 1 })
  })
})

describe('runGenericTelemetryPurgeIfNeeded', () => {
  it('refuses to run before the V2 reclassify gate is written', async () => {
    seedGeneric('telemetry blob', 'DeviceState-1-1.csv', { state: 'ON' })
    const mod = await loadModule()
    expect(mod.runGenericTelemetryPurgeIfNeeded()).toEqual({ ran: false })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='generic'").get()
    ).toEqual({ n: 1 })
  })

  it('after V2, deletes only Amazon-telemetry generic rows (FTS consistent), then gates', async () => {
    // A rider row V2 will promote + two telemetry rows + a signal row to keep
    // + a generic row from a NON-Amazon import the purge must never touch.
    seedGeneric('tap', 'rider_app_analytics-0.csv', {
      'GPS Time (UTC)': '2026-06-09 00:15:24.694',
      Latitude: '26.07069',
      Longitude: '-80.14414'
    })
    seedGeneric('telemetry blob', 'DeviceState-1-1.csv', { state: 'ON' })
    seedGeneric('impression', 'AppEngagement.csv', { app: 'x' })
    seedGeneric('unrecognized bank row', 'MyBankExport.csv', { memo: 'rent' })
    sqlite
      .prepare(
        "INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES ('netflix', 'watch', 1, 'Red One', 'nf|1')"
      )
      .run()

    const mod = await loadModule()
    mod.runRecordsReclassifyIfNeeded() // writes the V2 gate, promotes the GPS row
    const purge = mod.runGenericTelemetryPurgeIfNeeded()
    expect(purge).toEqual({ ran: true, deleted: 2 })

    // The non-Amazon generic import survives (provenance-fingerprint scoping).
    expect(sqlite.prepare("SELECT title FROM records WHERE source='generic'").all()).toEqual([
      { title: 'unrecognized bank row' }
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM records').get()).toEqual({ n: 2 }) // netflix + bank
    expect(sqlite.prepare('SELECT count(*) AS n FROM location_points').get()).toEqual({ n: 1 })
    const base = sqlite.prepare('SELECT count(*) AS n FROM records').get() as { n: number }
    const indexed = sqlite.prepare('SELECT count(*) AS n FROM records_fts_docsize').get() as {
      n: number
    }
    expect(indexed.n).toBe(base.n)

    // Gate consumed — a later telemetry-looking generic import is never purged.
    seedGeneric('future import', 'DeviceState-2-1.csv', { a: 1 })
    expect(mod.runGenericTelemetryPurgeIfNeeded()).toEqual({ ran: false })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='generic'").get()
    ).toEqual({ n: 2 })
  })
})
