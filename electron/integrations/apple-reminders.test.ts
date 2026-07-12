/**
 * Tests for the Apple Reminders integration (Phase 7 Track B, local-first): the
 * pure row transformer (due-window filtering), the JXA bridge parser + platform
 * guard (over an injected `run` seam so nothing shells out), and the
 * syncAppleReminders pipeline (import into today's checklist, dedup +
 * local-completion preservation, prune, reader-error surfacing, disconnected
 * self-gate) against a real in-memory SQLite Compass DB.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { ReminderRow } from './apple-reminders'

let sqlite: Database.Database
let today = '2026-06-13'

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// syncAppleReminders reads `today` via localYmd(); pin it.
vi.mock('../lib/dates', () => ({
  localYmd: () => today
}))

/** A minimal ReminderRow with overridable fields. */
function row(over: Partial<ReminderRow> & { id: string }): ReminderRow {
  return { title: 'Task', completed: false, dueDate: null, list: 'Inbox', ...over }
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
})

// ── normalizeReminders (pure) ────────────────────────────────────────────────

describe('normalizeReminders', () => {
  it('keeps overdue + due-today, drops future/un-dated/completed/untitled', async () => {
    const { normalizeReminders } = await import('./apple-reminders')
    const rows = normalizeReminders(
      [
        row({ id: 'today', dueDate: '2026-06-13' }),
        row({ id: 'overdue', dueDate: '2026-06-01' }),
        row({ id: 'future', dueDate: '2026-06-20' }),
        row({ id: 'undated', dueDate: null }),
        row({ id: 'done', dueDate: '2026-06-13', completed: true }),
        row({ id: 'untitled', title: null, dueDate: '2026-06-13' })
      ],
      today
    )
    expect(rows.map((r) => r.sourceId).sort()).toEqual(['overdue', 'today'])
  })

  it('carries the title + effective due date through', async () => {
    const { normalizeReminders } = await import('./apple-reminders')
    expect(
      normalizeReminders([row({ id: 'a', title: 'Pay rent', dueDate: '2026-06-10' })], today)
    ).toEqual([{ sourceId: 'a', title: 'Pay rent', dueDate: '2026-06-10' }])
  })
})

// ── readReminders (JXA parser + platform guard, injected run) ─────────────────

describe('readReminders', () => {
  const onDarwin = process.platform === 'darwin' ? it : it.skip
  const offDarwin = process.platform === 'darwin' ? it.skip : it

  onDarwin('parses the JXA JSON envelope into typed rows', async () => {
    const { readReminders } = await import('./apple-reminders')
    const fakeRun = () =>
      JSON.stringify([
        { id: 'r1', title: 'Buy milk', completed: false, dueDate: '2026-06-13', list: 'Home' },
        { id: 'r2', title: null, completed: false, dueDate: null, list: 'Work' }
      ])
    const rows = readReminders(fakeRun)
    expect(rows).toEqual([
      { id: 'r1', title: 'Buy milk', completed: false, dueDate: '2026-06-13', list: 'Home' },
      { id: 'r2', title: null, completed: false, dueDate: null, list: 'Work' }
    ])
  })

  onDarwin('throws on malformed bridge output', async () => {
    const { readReminders } = await import('./apple-reminders')
    expect(() => readReminders(() => 'not-json')).toThrow(/malformed/i)
    expect(() => readReminders(() => JSON.stringify({ not: 'an array' }))).toThrow(/list/i)
  })

  offDarwin('is macOS-only off darwin (throws before running the bridge)', async () => {
    const { readReminders } = await import('./apple-reminders')
    let ran = false
    expect(() =>
      readReminders(() => {
        ran = true
        return '[]'
      })
    ).toThrow(/macOS-only/i)
    expect(ran).toBe(false)
  })
})

// ── syncAppleReminders ───────────────────────────────────────────────────────

describe('syncAppleReminders', () => {
  const reader = (rows: ReminderRow[]) => () => rows

  it("imports actionable reminders into today's daily checklist as source='apple-reminders'", async () => {
    const { syncAppleReminders } = await import('./apple-reminders')
    const r = await syncAppleReminders(null, {
      reader: reader([
        row({ id: 'a', title: 'Task A', dueDate: '2026-06-13' }),
        row({ id: 'future', title: 'Later', dueDate: '2026-07-01' })
      ])
    })
    expect(r).toMatchObject({ service: 'apple-reminders', success: true, recordsUpdated: 1 })

    const item = sqlite.prepare('SELECT * FROM checklist_items').get() as Record<string, unknown>
    expect(item).toMatchObject({
      list_type: 'daily',
      list_date: today,
      title: 'Task A',
      source: 'apple-reminders',
      source_id: 'a',
      due_date: today
    })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='apple-reminders'").get()
    ).toMatchObject({ status: 'connected' })
  })

  it('preserves local checked state across a re-sync (updates title only)', async () => {
    const { syncAppleReminders } = await import('./apple-reminders')
    await syncAppleReminders(null, {
      reader: reader([row({ id: 'a', title: 'Original', dueDate: '2026-06-13' })])
    })
    sqlite
      .prepare("UPDATE checklist_items SET checked = 1, status = 'done' WHERE source_id = 'a'")
      .run()

    await syncAppleReminders(null, {
      reader: reader([row({ id: 'a', title: 'Renamed', dueDate: '2026-06-13' })])
    })

    const item = sqlite
      .prepare("SELECT * FROM checklist_items WHERE source_id = 'a'")
      .get() as Record<string, unknown>
    expect(item.title).toBe('Renamed') // display refreshed
    expect(item.checked).toBe(1) // local completion preserved
    expect(item.status).toBe('done')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toMatchObject({ c: 1 })
  })

  it('prunes today reminders no longer returned, leaving manual items alone', async () => {
    const { syncAppleReminders } = await import('./apple-reminders')
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, source, created_at) VALUES ('daily', ?, 'My manual task', 'manual', 0)"
      )
      .run(today)
    await syncAppleReminders(null, {
      reader: reader([
        row({ id: 'a', title: 'A', dueDate: '2026-06-13' }),
        row({ id: 'b', title: 'B', dueDate: '2026-06-13' })
      ])
    })
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM checklist_items WHERE source='apple-reminders'").get()
    ).toMatchObject({ c: 2 })

    const r = await syncAppleReminders(null, {
      reader: reader([row({ id: 'a', title: 'A', dueDate: '2026-06-13' })])
    })
    expect(r.recordsUpdated).toBe(2) // 'a' refreshed (1) + 'b' pruned (1)
    const sources = (
      sqlite.prepare('SELECT source, source_id FROM checklist_items').all() as Array<{
        source: string
        source_id: string | null
      }>
    ).map((x) => `${x.source}:${x.source_id ?? ''}`)
    expect(sources.sort()).toEqual(['apple-reminders:a', 'manual:'])
  })

  it('surfaces a reader error on the integration row', async () => {
    const { syncAppleReminders } = await import('./apple-reminders')
    const r = await syncAppleReminders(null, {
      reader: () => {
        throw new Error('Reminders access denied')
      }
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('denied')
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='apple-reminders'").get()
    ).toMatchObject({ status: 'error' })
  })

  it('self-gates when the integration row is disconnected (no re-import)', async () => {
    const { syncAppleReminders } = await import('./apple-reminders')
    sqlite
      .prepare(
        "INSERT INTO integrations (service, status) VALUES ('apple-reminders', 'disconnected')"
      )
      .run()
    const r = await syncAppleReminders(null, {
      reader: reader([row({ id: 'a', title: 'A', dueDate: '2026-06-13' })])
    })
    expect(r).toEqual({ service: 'apple-reminders', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toMatchObject({ c: 0 })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='apple-reminders'").get()
    ).toMatchObject({ status: 'disconnected' })
  })
})
