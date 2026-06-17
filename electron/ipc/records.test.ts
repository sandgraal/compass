/**
 * Tests for the records:* / Drop Zone IPC (Phase 10.1). Real in-memory SQLite for
 * the `records` table; `dialog` and the knowledge extractor are mocked so the
 * import flow touches no real filesystem beyond the temp fixtures it reads.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))
const mockDialog = { showOpenDialog: vi.fn() }
vi.mock('electron', () => ({ dialog: mockDialog }))
vi.mock('../knowledge/records-extractor', () => ({ updateRecordsKnowledge: vi.fn() }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return Promise.resolve().then(() => h({}, ...args))
}

let dir: string
function fixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

type ImportResult = {
  imported: number
  duplicates: number
  perFile: Array<{ file: string; recognizer: string | null }>
  unrecognized: string[]
}
type Rec = { id: number; source: string; title: string; occurredAt: number | null }

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  mockDialog.showOpenDialog.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'compass-records-'))
  const mod = await import('./records')
  mod.registerRecordsHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('records:import-paths', () => {
  it('imports Netflix viewing history and dedupes on re-import', async () => {
    const p = fixture(
      'NetflixViewingHistory.csv',
      'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'
    )

    const first = (await invoke('records:import-paths', [p])) as ImportResult
    expect(first.imported).toBe(2)
    expect(first.perFile[0].recognizer).toBe('netflix')

    const second = (await invoke('records:import-paths', [p])) as ImportResult
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(2)
  })

  it('recognizes Spotify JSON and a generic dated CSV; flags unrecognized', async () => {
    const spotify = fixture(
      'StreamingHistory0.json',
      JSON.stringify([
        {
          endTime: '2026-01-03 14:33',
          artistName: 'Daft Punk',
          trackName: 'One More Time',
          msPlayed: 320000
        }
      ])
    )
    const generic = fixture('misc.csv', 'when,event\n2026-02-01,Did a thing\n')
    const junk = fixture('junk.json', '{"not":"an array"}')

    const res = (await invoke('records:import-paths', [spotify, generic, junk])) as ImportResult
    expect(res.imported).toBe(2)
    const recognizers = res.perFile.map((f) => f.recognizer)
    expect(recognizers).toContain('spotify')
    expect(recognizers).toContain('generic')
    expect(res.unrecognized).toContain('junk.json')
  })

  it('rejects a non-array or all-non-string payload arg', async () => {
    const nonArray = (await invoke('records:import-paths', null)) as { success: boolean }
    expect(nonArray.success).toBe(false)
    const noStrings = (await invoke('records:import-paths', [123, null])) as { success: boolean }
    expect(noStrings.success).toBe(false)
  })
})

describe('records:list', () => {
  it('returns newest-first and filters by source', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n')
    ])
    const all = (await invoke('records:list')) as Rec[]
    expect(all).toHaveLength(2)
    expect(all[0].title).toBe('The Matrix') // Jan 2026 newer than Dec 2025

    const none = (await invoke('records:list', { source: 'spotify' })) as Rec[]
    expect(none).toHaveLength(0)
    const netflix = (await invoke('records:list', { source: 'netflix' })) as Rec[]
    expect(netflix).toHaveLength(2)
  })

  it('filters by a full-text query over title and body', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'),
      // PayPal: the transaction Type ("Money Sent") lives in the BODY, not the title
      // (title is the counterparty "Jane Doe") — so it exercises the body LIKE branch.
      fixture(
        'Download.csv',
        'Date,Name,Type,Status,Currency,Gross,Transaction ID\n01/15/2026,Jane Doe,Money Sent,Completed,USD,-25.00,TX-Q1\n'
      )
    ])
    // Title hit (Netflix has no body).
    const byTitle = (await invoke('records:list', { q: 'matrix' })) as Rec[]
    expect(byTitle).toHaveLength(1)
    expect(byTitle[0].title).toBe('The Matrix') // case-insensitive substring match
    // Body hit: "Money Sent" is only in the PayPal record's body, not its title.
    const byBody = (await invoke('records:list', { q: 'money sent' })) as Rec[]
    expect(byBody).toHaveLength(1)
    expect(byBody[0].title).toBe('Jane Doe')
    const none = (await invoke('records:list', { q: 'zzz-nope' })) as Rec[]
    expect(none).toHaveLength(0)
  })
})

describe('records:import (dialog)', () => {
  it('imports the chosen files', async () => {
    const p = fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [p] })
    const res = (await invoke('records:import')) as ImportResult & { success: boolean }
    expect(res.success).toBe(true)
    expect(res.imported).toBe(1)
  })

  it('returns canceled when dismissed', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('records:import')).toMatchObject({ canceled: true })
  })
})

describe('buildRecordsCsv', () => {
  it('serializes records newest-first', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    ])
    const { buildRecordsCsv } = await import('./records')
    const csv = buildRecordsCsv()
    expect(csv).toContain('occurred_at,source,type,title,body')
    expect(csv).toContain('The Matrix')
    expect(csv).toContain('netflix')
  })
})

describe('records:import-paths — Apple Health (streaming)', () => {
  it('aggregates a health export and dedupes on re-import', async () => {
    const xml = fixture(
      'export.xml',
      [
        '<HealthData>',
        '<Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-01-02 08:00:00 -0700" endDate="2026-01-02 08:05:00 -0700" value="2000"/>',
        '<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="20" durationUnit="min" startDate="2026-01-02 09:00:00 -0700" endDate="2026-01-02 09:20:00 -0700"/>',
        '</HealthData>'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [xml])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('apple-health')
    expect(r1.imported).toBe(2) // 1 daily steps rollup + 1 workout

    const r2 = (await invoke('records:import-paths', [xml])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})

describe('records:import-paths — Email mbox (streaming)', () => {
  it('imports an mbox and dedupes on re-import', async () => {
    const mbox = fixture(
      'All mail.mbox',
      [
        'From 1@mx Mon Jan 02 08:00:00 +0000 2026',
        'Date: Mon, 2 Jan 2026 08:00:00 +0000',
        'From: Alice <alice@example.com>',
        'Subject: Hello',
        'Message-ID: <m1@example.com>',
        '',
        'body one',
        '',
        'From 2@mx Tue Jan 03 09:00:00 +0000 2026',
        'Date: Tue, 3 Jan 2026 09:00:00 +0000',
        'From: Bob <bob@example.com>',
        'Subject: Hi',
        'Message-ID: <m2@example.com>',
        '',
        'body two'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [mbox])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('email')
    expect(r1.imported).toBe(2)

    const r2 = (await invoke('records:import-paths', [mbox])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})

describe('records:import-paths — Google Takeout (.zip container)', () => {
  it('unwraps a Takeout zip and routes entries through the recognizers', async () => {
    const zip = join(process.cwd(), 'electron', 'lib', '__fixtures__', 'takeout-sample.zip')
    const r1 = (await invoke('records:import-paths', [zip])) as ImportResult
    expect(r1.imported).toBe(3) // 2 emails (mbox) + 1 youtube watch
    const recognizers = r1.perFile.map((f) => f.recognizer)
    expect(recognizers).toContain('email')
    expect(recognizers).toContain('youtube')
    expect(r1.unrecognized.join(' ')).toContain('photo.jpg') // binary skipped, not extracted

    const r2 = (await invoke('records:import-paths', [zip])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(3)
  })
})

describe('records:import-paths — browser history (SQLite)', () => {
  it('imports a Chrome History DB and dedupes on re-import', async () => {
    const dbPath = join(dir, 'History')
    const h = new Database(dbPath)
    h.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)')
    h.exec('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)')
    h.prepare('INSERT INTO urls (id, url, title) VALUES (1, ?, ?)').run('https://a.com/p', 'A')
    h.prepare('INSERT INTO visits (url, visit_time) VALUES (1, ?)').run(13350000000000000)
    h.close()

    const r1 = (await invoke('records:import-paths', [dbPath])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('chrome')
    expect(r1.imported).toBe(1)

    const r2 = (await invoke('records:import-paths', [dbPath])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(1)
  })
})

describe('records:import-paths — iMessage (chat.db)', () => {
  it('aggregates a chat.db into daily message records and dedupes', async () => {
    const dbPath = join(dir, 'chat.db')
    const h = new Database(dbPath)
    h.exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER)')
    h.exec('CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT)')
    h.exec('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)')
    h.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (1, ?, NULL)').run(
      'bob@x.com'
    )
    const ns = BigInt(Date.UTC(2026, 0, 5, 12, 0, 0) / 1000 - 978307200) * 1000000000n
    h.prepare('INSERT INTO message (ROWID, date) VALUES (1, ?)').run(ns)
    h.prepare('INSERT INTO message (ROWID, date) VALUES (2, ?)').run(ns)
    h.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)').run()
    h.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2)').run()
    h.close()

    const r1 = (await invoke('records:import-paths', [dbPath])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('imessage')
    expect(r1.imported).toBe(1) // one (day, conversation) record covering both messages

    const r2 = (await invoke('records:import-paths', [dbPath])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(1)
  })
})

describe('records:import-paths — Amazon orders (CSV)', () => {
  it('imports an Amazon order export and dedupes on re-import', async () => {
    const p = fixture(
      'Retail.OrderHistory.1.csv',
      [
        'Order ID,Order Date,Currency,Total Owed,Quantity,Product Name',
        '111-0001,2026-01-05,USD,12.99,1,USB-C Cable',
        '111-0001,2026-01-05,USD,17.00,2,AA Batteries',
        '222-0002,2025-12-20,USD,49.99,1,Mechanical Keyboard'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('amazon')
    expect(r1.imported).toBe(3) // one record per ordered item

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(3)
  })
})

describe('records:import-paths — PayPal transactions (CSV)', () => {
  it('imports a PayPal statement and dedupes on re-import', async () => {
    const p = fixture(
      'Download.csv',
      [
        'Date,Name,Type,Status,Currency,Gross,Transaction ID',
        '01/15/2026,Jane Doe,Money Sent,Completed,USD,-25.00,TX-AAA111',
        '01/22/2026,John Smith,Money Received,Completed,USD,75.00,TX-BBB222'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('paypal')
    expect(r1.imported).toBe(2)

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})
