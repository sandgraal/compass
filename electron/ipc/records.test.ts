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
import { makePdf } from '../lib/__fixtures__/make-pdf'
import { makeZip } from '../lib/__fixtures__/make-zip'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
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
    CREATE TABLE snapshot_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, category TEXT NOT NULL,
      label TEXT, value TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
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

describe('records:search (FTS5)', () => {
  type Hit = { title: string; source: string; titleSnippet: string; rank: number }
  it('bm25-ranks matches across the whole timeline (via the AFTER INSERT trigger)', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'),
      fixture(
        'Download.csv',
        'Date,Name,Type,Status,Currency,Gross,Transaction ID\n01/15/2026,Jane Doe,Money Sent,Completed,USD,-25.00,TX-Q1\n'
      )
    ])
    // prefix match: "matr" → "The Matrix"
    const hits = (await invoke('records:search', { q: 'matr' })) as Hit[]
    expect(hits.map((h) => h.title)).toEqual(['The Matrix'])
    expect(hits[0].titleSnippet).toContain('[Matrix]') // snippet brackets the match
    // body match: "Money Sent" lives in the PayPal record's body
    const body = (await invoke('records:search', { q: 'money sent' })) as Hit[]
    expect(body.map((h) => h.title)).toEqual(['Jane Doe'])
  })

  it('returns [] for an empty / malformed query rather than throwing', async () => {
    expect(await invoke('records:search', { q: '   ' })).toEqual([])
    expect(await invoke('records:search', {})).toEqual([])
  })
})

describe('records:on-this-day', () => {
  it("returns prior-year records sharing today's month/day, excluding this year", async () => {
    // Freeze the clock to a fixed, non-leap-day date: the handler matches against
    // `new Date()` in UTC, so a real date would be flaky on Feb 29 (prior non-leap
    // years roll to Mar 1). Fixed UTC fixtures keep it deterministic across zones.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'))
    try {
      const ins = sqlite.prepare(
        'INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?,?,?,?,?)'
      )
      ins.run('netflix', 'watch', Date.parse('2023-06-16T20:00:00Z'), 'Anniversary Movie', 'otd1')
      ins.run('youtube', 'watch', Date.parse('2026-06-16T09:00:00Z'), 'Today Thing', 'otd2') // this year
      ins.run('spotify', 'listen', Date.parse('2024-02-10T12:00:00Z'), 'Wrong Day', 'otd3')

      const titles = ((await invoke('records:on-this-day')) as Rec[]).map((r) => r.title)
      expect(titles).toContain('Anniversary Movie')
      expect(titles).not.toContain('Today Thing') // current year is excluded
      expect(titles).not.toContain('Wrong Day') // different month/day
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('records:stats', () => {
  it('returns true totals, distinct source count, and the dated span', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'),
      fixture(
        'StreamingHistory0.json',
        JSON.stringify([
          { endTime: '2024-06-01 10:00', artistName: 'A', trackName: 'T', msPlayed: 1000 }
        ])
      )
    ])
    const stats = (await invoke('records:stats')) as {
      total: number
      sources: number
      earliest: number | null
      latest: number | null
    }
    expect(stats.total).toBe(3) // 2 netflix + 1 spotify
    expect(stats.sources).toBe(2) // netflix + spotify
    expect(stats.earliest).toBe(Date.parse('2024-06-01 10:00')) // oldest (spotify)
    expect(stats.latest).toBe(new Date(2026, 0, 2).getTime()) // newest (The Matrix, Jan 2 2026)
  })
})

describe('records:facets', () => {
  it('returns the sorted, distinct sources and kinds across the whole table', async () => {
    await invoke('records:import-paths', [
      fixture('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'),
      fixture(
        'StreamingHistory0.json',
        JSON.stringify([
          { endTime: '2024-06-01 10:00', artistName: 'A', trackName: 'T', msPlayed: 1000 }
        ])
      )
    ])
    const facets = (await invoke('records:facets')) as { sources: string[]; types: string[] }
    // Distinct sources, sorted — not duplicated by the two Netflix rows.
    expect(facets.sources).toEqual(['netflix', 'spotify'])
    // Distinct kinds (the `type` column): Netflix → watch, Spotify → listen.
    expect(facets.types).toEqual(['listen', 'watch'])
  })

  it('is empty for an empty timeline', async () => {
    const facets = (await invoke('records:facets')) as { sources: string[]; types: string[] }
    expect(facets).toEqual({ sources: [], types: [] })
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

describe('records:import-paths — Goodreads books (CSV)', () => {
  it('imports a Goodreads library export and dedupes on re-import', async () => {
    const p = fixture(
      'goodreads_library_export.csv',
      [
        'Book Id,Title,Author,My Rating,Date Read,Date Added,Exclusive Shelf',
        '54493401,Project Hail Mary,Andy Weir,5,2026/01/15,2025/12/01,read',
        '2767052,The Hunger Games,Suzanne Collins,0,,2026/02/01,to-read'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('goodreads')
    expect(r1.imported).toBe(2)

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})

describe('records:import-paths — Venmo transactions (CSV with preamble)', () => {
  it('skips the preamble, imports transactions, and dedupes on re-import', async () => {
    const p = fixture(
      'venmo_statement.csv',
      [
        'Account Statement - (@janedoe) - January 2026',
        'Account Activity',
        ',ID,Datetime,Type,Status,Note,From,To,Amount (total)',
        ',,,,,,,,$100.00',
        ',331,2026-01-15T10:30:00,Payment,Complete,Dinner,Jane Doe,John Smith,- $25.00',
        ',332,2026-01-20T14:00:00,Payment,Complete,Tickets,Bob,Jane Doe,+ $50.00'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('venmo')
    expect(r1.imported).toBe(2) // summary row skipped

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})

describe('records:import-paths — credit report (PDF)', () => {
  it('extracts a credit-report PDF, indexes it, and dedupes on re-import', async () => {
    const p = join(dir, 'creditreport.pdf')
    writeFileSync(p, makePdf('TransUnion Credit Report Report Date 2026-02-01 FICO Score 705'))
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('credit-report')
    expect(r1.imported).toBe(1)

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(1)
  })

  it('reaches a PDF nested inside an imported ZIP (rights-disclosure archive)', async () => {
    const pdf = makePdf('Equifax Credit Report Report Date 2026-03-15 FICO Score 760')
    const p = join(dir, 'rights.zip')
    writeFileSync(p, makeZip([{ name: 'disclosures/equifax.pdf', data: pdf }]))
    const r = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r.perFile.some((f) => f.recognizer === 'credit-report')).toBe(true)
    expect(r.imported).toBe(1)
  })
})

describe('records:import-paths — LinkedIn connections (CSV with preamble)', () => {
  it('skips the Notes preamble, imports connections, and dedupes on re-import', async () => {
    const p = fixture(
      'Connections.csv',
      [
        'Notes:',
        '"Some fields may be missing if the member limited visibility."',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        'John,Doe,https://www.linkedin.com/in/johndoe,,Acme Inc,Engineer,15 Jan 2026',
        'Jane,Smith,https://www.linkedin.com/in/janesmith,,Globex,PM,03 Mar 2024'
      ].join('\n')
    )
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.perFile[0].recognizer).toBe('linkedin')
    expect(r1.imported).toBe(2)

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})

describe('snapshot facts (ad profile)', () => {
  type Fact = {
    id: number
    category: string
    label: string | null
    value: string
    position: number
  }
  const ADVERTISERS = `<!doctype html><html><body>
    <table class="_a6_q">
      <tr><td><div class="_2pin _a6-p">Acme Corp</div></td></tr>
      <tr><td><div class="_2pin _a6-p">Globex</div></td></tr>
    </table></body></html>`

  it('routes a FB ad-profile file to snapshot_facts (not the timeline) and dedupes', async () => {
    const p = fixture('advertisers_using_your_activity_or_information.html', ADVERTISERS)
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult & { snapshots: number }
    expect(r1.snapshots).toBe(2)
    expect(r1.imported).toBe(0) // nothing on the timeline
    expect(r1.perFile[0].recognizer).toBe('facebook-ad-profile') // recognized, not unrecognized
    expect(r1.unrecognized).toHaveLength(0)

    const facts = (await invoke('snapshot:list', {
      source: 'facebook',
      category: 'ad-profile'
    })) as Fact[]
    expect(facts.map((f) => f.value)).toEqual(['Acme Corp', 'Globex'])
    expect(facts[0]).toMatchObject({ label: 'Advertiser', position: 0 })

    // Re-import is idempotent.
    const again = (await invoke('records:import-paths', [p])) as ImportResult & {
      snapshots: number
    }
    expect(again.snapshots).toBe(0)
    const after = (await invoke('snapshot:list', { source: 'facebook' })) as Fact[]
    expect(after).toHaveLength(2)
  })
})

describe('Google My Activity import', () => {
  const MYACTIVITY = `<!doctype html><html><body><div class="mdl-grid">
    <div class="outer-cell mdl-shadow--2dp"><div class="mdl-grid">
      <div class="header-cell"><p class="mdl-typography--title">Search<br></p></div>
      <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Searched for tiny desk<br>Jan 02, 2025, 8:00:00 AM EST<br></div>
    </div></div>
    <div class="outer-cell mdl-shadow--2dp"><div class="mdl-grid">
      <div class="header-cell"><p class="mdl-typography--title">YouTube<br></p></div>
      <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched <a href="https://youtu.be/x">A Video</a><br>Jan 03, 2025, 9:00:00 PM EST<br></div>
    </div></div></div></body></html>`

  it('imports My Activity HTML as google timeline records and dedupes on re-import', async () => {
    const p = fixture('MyActivity.html', MYACTIVITY)
    const r1 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r1.imported).toBe(2)
    expect(r1.perFile[0].recognizer).toBe('google')

    const rows = (await invoke('records:list', { source: 'google' })) as Rec[]
    expect(rows.map((r) => r.title).sort()).toEqual(['Searched for tiny desk', 'Watched A Video'])

    const r2 = (await invoke('records:import-paths', [p])) as ImportResult
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
  })
})
