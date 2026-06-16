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
