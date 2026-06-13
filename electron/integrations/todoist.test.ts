/**
 * Tests for the Todoist integration (Phase 7 Track B): the pure
 * REST-task → row transformer (due-window filtering) and the syncTodoist
 * pipeline (import into today's checklist, dedup + local-completion
 * preservation, prune) against a real in-memory SQLite.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
let storedToken: { access_token: string } | null = null
let today = '2026-06-13'

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../ipc/auth', () => ({
  loadToken: () => storedToken
}))

// syncTodoist reads `today` via localYmd(); pin it.
vi.mock('../lib/dates', () => ({
  localYmd: () => today
}))

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 't1', content: 'Buy milk', due: { date: today }, priority: 1, ...over }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  storedToken = { access_token: 'tok' }
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
  vi.unstubAllGlobals()
  sqlite.close()
})

// ── normalizeTodoistTasks (pure) ─────────────────────────────────────────────

describe('normalizeTodoistTasks', () => {
  it('keeps overdue + due-today tasks, drops future/no-due/completed/malformed', async () => {
    const { normalizeTodoistTasks } = await import('./todoist')
    const rows = normalizeTodoistTasks(
      [
        task({ id: 'today', due: { date: '2026-06-13' } }),
        task({ id: 'overdue', due: { date: '2026-06-01' } }),
        task({ id: 'future', due: { date: '2026-06-20' } }),
        task({ id: 'nodue', due: null }),
        task({ id: 'done', is_completed: true }),
        { id: 'nocontent', due: { date: '2026-06-13' } } // malformed → dropped
      ] as never,
      today
    )
    expect(rows.map((r) => r.sourceId).sort()).toEqual(['overdue', 'today'])
  })

  it('compares on the date portion of a full datetime due value', async () => {
    const { normalizeTodoistTasks } = await import('./todoist')
    const rows = normalizeTodoistTasks(
      [task({ id: 'dt', due: { date: '2026-06-13T09:00:00' } })] as never,
      today
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dueDate).toBe('2026-06-13')
  })
})

// ── syncTodoist ──────────────────────────────────────────────────────────────

describe('syncTodoist', () => {
  it('returns Not connected without touching rows when no token is stored', async () => {
    storedToken = null
    const { syncTodoist } = await import('./todoist')
    const r = await syncTodoist(null)
    expect(r).toEqual({ service: 'todoist', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 0 })
  })

  it("imports actionable tasks into today's daily checklist as source='todoist'", async () => {
    fetchMock.mockResolvedValue(jsonResponse([task({ id: 'a', content: 'Task A' })]))
    const { syncTodoist } = await import('./todoist')
    const r = await syncTodoist(null)
    expect(r).toMatchObject({ service: 'todoist', success: true, recordsUpdated: 1 })

    const row = sqlite.prepare('SELECT * FROM checklist_items').get() as Record<string, unknown>
    expect(row).toMatchObject({
      list_type: 'daily',
      list_date: today,
      title: 'Task A',
      source: 'todoist',
      source_id: 'a',
      due_date: today
    })
  })

  it('preserves local checked state across a re-sync (updates title only)', async () => {
    const { syncTodoist } = await import('./todoist')
    fetchMock.mockResolvedValue(jsonResponse([task({ id: 'a', content: 'Original' })]))
    await syncTodoist(null)
    // User checks the imported task in Compass.
    sqlite
      .prepare("UPDATE checklist_items SET checked = 1, status = 'done' WHERE source_id = 'a'")
      .run()

    // Re-sync with a renamed task.
    fetchMock.mockResolvedValue(jsonResponse([task({ id: 'a', content: 'Renamed' })]))
    await syncTodoist(null)

    const row = sqlite
      .prepare("SELECT * FROM checklist_items WHERE source_id = 'a'")
      .get() as Record<string, unknown>
    expect(row.title).toBe('Renamed') // display refreshed
    expect(row.checked).toBe(1) // local completion preserved
    expect(row.status).toBe('done')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toMatchObject({ c: 1 })
  })

  it('prunes today todoist items no longer returned, leaving manual items alone', async () => {
    // A manual task the user added today — must survive the prune.
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, source, created_at) VALUES ('daily', ?, 'My manual task', 'manual', 0)"
      )
      .run(today)
    const { syncTodoist } = await import('./todoist')
    fetchMock.mockResolvedValue(jsonResponse([task({ id: 'a' }), task({ id: 'b' })]))
    await syncTodoist(null)
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM checklist_items WHERE source='todoist'").get()
    ).toMatchObject({ c: 2 })

    // Next sync: only 'a' remains in Todoist → 'b' is pruned, manual untouched.
    fetchMock.mockResolvedValue(jsonResponse([task({ id: 'a' })]))
    const r = await syncTodoist(null)
    expect(r.recordsUpdated).toBe(2) // 'a' refreshed (1) + 'b' pruned (1)
    const sources = (
      sqlite.prepare('SELECT source, source_id FROM checklist_items').all() as Array<{
        source: string
        source_id: string | null
      }>
    ).map((x) => `${x.source}:${x.source_id ?? ''}`)
    expect(sources.sort()).toEqual(['manual:', 'todoist:a'])
  })

  it('surfaces a 401 as a reconnect error via the integration row', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    const { syncTodoist } = await import('./todoist')
    const r = await syncTodoist(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Reconnect')
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='todoist'").get()
    ).toMatchObject({ status: 'error' })
  })
})
