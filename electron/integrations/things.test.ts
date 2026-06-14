/**
 * Tests for the Things 3 integration (Phase 7 Track B, local-first): the
 * bit-packed date decoder, the Things-DB path resolver, the read-only
 * `TMTask` reader (against a synthetic Things SQLite file), the pure
 * row transformer (due-window filtering), and the syncThings pipeline
 * (import into today's checklist, dedup + local-completion preservation,
 * prune, not-found error, disconnected self-gate) against a real
 * in-memory SQLite Compass DB.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
let today = '2026-06-13'
const tmpPaths: string[] = []

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// syncThings reads `today` via localYmd(); pin it.
vi.mock('../lib/dates', () => ({
  localYmd: () => today
}))

/** Encode a calendar date into Things' bit-packed integer (inverse of the
 * decoder under test): year << 16 | month << 12 | day << 7. */
function enc(y: number, m: number, d: number): number {
  return (y << 16) | (m << 12) | (d << 7)
}

interface TMTaskInsert {
  uuid: string
  title: string | null
  status?: number
  type?: number
  trashed?: number
  startDate?: number | null
  deadline?: number | null
}

/** Build a throwaway Things SQLite file with a `TMTask` table + rows, and
 * return its path. Cleaned up in afterEach. */
function makeThingsDb(rows: TMTaskInsert[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'things-test-'))
  tmpPaths.push(dir)
  const path = join(dir, 'main.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE TMTask (
      uuid TEXT PRIMARY KEY, title TEXT, notes TEXT,
      status INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0, startDate INTEGER, deadline INTEGER
    );
  `)
  const insert = db.prepare(
    'INSERT INTO TMTask (uuid, title, status, type, trashed, startDate, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of rows) {
    insert.run(
      r.uuid,
      r.title,
      r.status ?? 0,
      r.type ?? 0,
      r.trashed ?? 0,
      r.startDate ?? null,
      r.deadline ?? null
    )
  }
  db.close()
  return path
}

beforeEach(() => {
  today = '2026-06-13'
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL UNIQUE,
      connected_at INTEGER, last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected', scopes TEXT, error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id INTEGER NOT NULL,
      synced_at INTEGER, records_updated INTEGER DEFAULT 0, errors TEXT
    );
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list_type TEXT NOT NULL, list_date TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, checked INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal', sort_order INTEGER DEFAULT 0, due_date TEXT,
      source TEXT DEFAULT 'manual', source_id TEXT, created_at INTEGER NOT NULL DEFAULT 0
    );
  `)
})

afterEach(() => {
  sqlite.close()
  for (const p of tmpPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true })
  }
})

// ── decodeThingsDate (pure) ──────────────────────────────────────────────────

describe('decodeThingsDate', () => {
  it('unpacks the documented example 132464128 → 2021-03-28', async () => {
    const { decodeThingsDate } = await import('./things')
    expect(decodeThingsDate(132464128)).toBe('2021-03-28')
  })

  it('round-trips encoded dates with zero-padding', async () => {
    const { decodeThingsDate } = await import('./things')
    expect(decodeThingsDate(enc(2026, 6, 13))).toBe('2026-06-13')
    expect(decodeThingsDate(enc(2026, 1, 5))).toBe('2026-01-05')
    expect(decodeThingsDate(enc(2026, 12, 31))).toBe('2026-12-31')
  })

  it('returns null for null/0/negative/out-of-range', async () => {
    const { decodeThingsDate } = await import('./things')
    expect(decodeThingsDate(null)).toBeNull()
    expect(decodeThingsDate(undefined)).toBeNull()
    expect(decodeThingsDate(0)).toBeNull()
    expect(decodeThingsDate(-1)).toBeNull()
    expect(decodeThingsDate(enc(2026, 0, 10))).toBeNull() // month 0
    expect(decodeThingsDate(enc(2026, 13, 10))).toBeNull() // month 13
  })
})

// ── resolveThingsDbPath ──────────────────────────────────────────────────────

describe('resolveThingsDbPath', () => {
  it('finds the database in the direct container layout', async () => {
    const { resolveThingsDbPath } = await import('./things')
    const root = mkdtempSync(join(tmpdir(), 'gc-direct-'))
    tmpPaths.push(root)
    const dbDir = join(
      root,
      'JLMPQHK86H.com.culturedcode.ThingsMac',
      'Things Database.thingsdatabase'
    )
    mkdirSync(dbDir, { recursive: true })
    writeFileSync(join(dbDir, 'main.sqlite'), '')
    expect(resolveThingsDbPath(root)).toBe(join(dbDir, 'main.sqlite'))
  })

  it('finds the database in the nested ThingsData-* layout (any team id)', async () => {
    const { resolveThingsDbPath } = await import('./things')
    const root = mkdtempSync(join(tmpdir(), 'gc-nested-'))
    tmpPaths.push(root)
    const dbDir = join(
      root,
      'ABCDE12345.com.culturedcode.ThingsMac',
      'ThingsData-XYZ',
      'Things Database.thingsdatabase'
    )
    mkdirSync(dbDir, { recursive: true })
    writeFileSync(join(dbDir, 'main.sqlite'), '')
    expect(resolveThingsDbPath(root)).toBe(join(dbDir, 'main.sqlite'))
  })

  it('returns null when Things is not installed', async () => {
    const { resolveThingsDbPath } = await import('./things')
    const root = mkdtempSync(join(tmpdir(), 'gc-empty-'))
    tmpPaths.push(root)
    expect(resolveThingsDbPath(root)).toBeNull()
    expect(resolveThingsDbPath(join(root, 'does-not-exist'))).toBeNull()
  })
})

// ── readThingsTasks (real SQLite) ────────────────────────────────────────────

describe('readThingsTasks', () => {
  it('returns only open to-dos with decoded dates, skipping done/trashed/projects', async () => {
    const { readThingsTasks } = await import('./things')
    const path = makeThingsDb([
      { uuid: 'open', title: 'Open todo', deadline: enc(2026, 6, 13) },
      { uuid: 'sched', title: 'Scheduled', startDate: enc(2026, 6, 12) },
      { uuid: 'done', title: 'Completed', status: 3, deadline: enc(2026, 6, 13) },
      { uuid: 'canceled', title: 'Canceled', status: 2 },
      { uuid: 'trashed', title: 'Trashed', trashed: 1 },
      { uuid: 'project', title: 'A project', type: 1 }
    ])
    const rows = readThingsTasks(path)
    expect(rows.map((r) => r.uuid).sort()).toEqual(['open', 'sched'])
    const open = rows.find((r) => r.uuid === 'open')
    expect(open).toMatchObject({ title: 'Open todo', deadline: '2026-06-13', startDate: null })
  })
})

// ── normalizeThingsTasks (pure) ──────────────────────────────────────────────

describe('normalizeThingsTasks', () => {
  it('keeps overdue + due-today, drops future/un-dated/completed/non-todo/untitled', async () => {
    const { normalizeThingsTasks } = await import('./things')
    const row = (over: Record<string, unknown>) => ({
      uuid: 'x',
      title: 'T',
      status: 0,
      type: 0,
      trashed: 0,
      startDate: null,
      deadline: null,
      ...over
    })
    const rows = normalizeThingsTasks(
      [
        row({ uuid: 'today', deadline: '2026-06-13' }),
        row({ uuid: 'overdue', deadline: '2026-06-01' }),
        row({ uuid: 'future', deadline: '2026-06-20' }),
        row({ uuid: 'undated' }),
        row({ uuid: 'done', status: 3, deadline: '2026-06-13' }),
        row({ uuid: 'project', type: 1, deadline: '2026-06-13' }),
        row({ uuid: 'trashed', trashed: 1, deadline: '2026-06-13' }),
        row({ uuid: 'untitled', title: null, deadline: '2026-06-13' })
      ] as never,
      today
    )
    expect(rows.map((r) => r.sourceId).sort()).toEqual(['overdue', 'today'])
  })

  it('prefers deadline over startDate for the effective due date', async () => {
    const { normalizeThingsTasks } = await import('./things')
    const rows = normalizeThingsTasks(
      [
        {
          uuid: 'a',
          title: 'Has both',
          status: 0,
          type: 0,
          trashed: 0,
          startDate: '2026-06-10',
          deadline: '2026-06-13'
        },
        {
          uuid: 'b',
          title: 'Scheduled only',
          status: 0,
          type: 0,
          trashed: 0,
          startDate: '2026-06-12',
          deadline: null
        }
      ],
      today
    )
    expect(rows).toEqual([
      { sourceId: 'a', title: 'Has both', dueDate: '2026-06-13' },
      { sourceId: 'b', title: 'Scheduled only', dueDate: '2026-06-12' }
    ])
  })
})

// ── syncThings ───────────────────────────────────────────────────────────────

describe('syncThings', () => {
  it("imports actionable to-dos into today's daily checklist as source='things'", async () => {
    const { syncThings } = await import('./things')
    const dbPath = makeThingsDb([
      { uuid: 'a', title: 'Task A', deadline: enc(2026, 6, 13) },
      { uuid: 'future', title: 'Later', deadline: enc(2026, 7, 1) }
    ])
    const r = await syncThings(null, { dbPath })
    expect(r).toMatchObject({ service: 'things', success: true, recordsUpdated: 1 })

    const row = sqlite.prepare('SELECT * FROM checklist_items').get() as Record<string, unknown>
    expect(row).toMatchObject({
      list_type: 'daily',
      list_date: today,
      title: 'Task A',
      source: 'things',
      source_id: 'a',
      due_date: today
    })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='things'").get()
    ).toMatchObject({ status: 'connected' })
  })

  it('preserves local checked state across a re-sync (updates title only)', async () => {
    const { syncThings } = await import('./things')
    await syncThings(null, {
      dbPath: makeThingsDb([{ uuid: 'a', title: 'Original', deadline: enc(2026, 6, 13) }])
    })
    // User checks the imported task in Compass.
    sqlite
      .prepare("UPDATE checklist_items SET checked = 1, status = 'done' WHERE source_id = 'a'")
      .run()

    await syncThings(null, {
      dbPath: makeThingsDb([{ uuid: 'a', title: 'Renamed', deadline: enc(2026, 6, 13) }])
    })

    const row = sqlite
      .prepare("SELECT * FROM checklist_items WHERE source_id = 'a'")
      .get() as Record<string, unknown>
    expect(row.title).toBe('Renamed') // display refreshed
    expect(row.checked).toBe(1) // local completion preserved
    expect(row.status).toBe('done')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toMatchObject({ c: 1 })
  })

  it('prunes today things items no longer returned, leaving manual items alone', async () => {
    const { syncThings } = await import('./things')
    // A manual task the user added today — must survive the prune.
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, source, created_at) VALUES ('daily', ?, 'My manual task', 'manual', 0)"
      )
      .run(today)
    await syncThings(null, {
      dbPath: makeThingsDb([
        { uuid: 'a', title: 'A', deadline: enc(2026, 6, 13) },
        { uuid: 'b', title: 'B', deadline: enc(2026, 6, 13) }
      ])
    })
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM checklist_items WHERE source='things'").get()
    ).toMatchObject({ c: 2 })

    // Next sync: only 'a' remains → 'b' is pruned, manual untouched.
    const r = await syncThings(null, {
      dbPath: makeThingsDb([{ uuid: 'a', title: 'A', deadline: enc(2026, 6, 13) }])
    })
    expect(r.recordsUpdated).toBe(2) // 'a' refreshed (1) + 'b' pruned (1)
    const sources = (
      sqlite.prepare('SELECT source, source_id FROM checklist_items').all() as Array<{
        source: string
        source_id: string | null
      }>
    ).map((x) => `${x.source}:${x.source_id ?? ''}`)
    expect(sources.sort()).toEqual(['manual:', 'things:a'])
  })

  it('surfaces a not-found database as an error on the integration row', async () => {
    const { syncThings } = await import('./things')
    const root = mkdtempSync(join(tmpdir(), 'gc-none-'))
    tmpPaths.push(root)
    const r = await syncThings(null, { root })
    expect(r.success).toBe(false)
    expect(r.error).toContain('not found')
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='things'").get()
    ).toMatchObject({ status: 'error' })
  })

  it('self-gates when the integration row is disconnected (no re-import)', async () => {
    const { syncThings } = await import('./things')
    sqlite
      .prepare("INSERT INTO integrations (service, status) VALUES ('things', 'disconnected')")
      .run()
    const r = await syncThings(null, {
      dbPath: makeThingsDb([{ uuid: 'a', title: 'A', deadline: enc(2026, 6, 13) }])
    })
    expect(r).toEqual({ service: 'things', success: false, error: 'Not connected' })
    // Nothing imported, and the row stays disconnected.
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toMatchObject({ c: 0 })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='things'").get()
    ).toMatchObject({ status: 'disconnected' })
  })
})
