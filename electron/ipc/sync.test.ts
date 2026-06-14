/**
 * Tests for the `sync:*` (+ calendar/github/gmail query) IPC handlers
 * (Phase 6.1 — P1).
 *
 * Scope is the `registerSyncHandlers` seam, not the heavy provider sync
 * functions (`syncGoogle` / `syncGitHub` / `syncAppleCalendar`). Those hit
 * OAuth tokens + network and deserve their own focused mocks; here we cover
 * the handler logic that's pure-ish or DB-backed:
 *
 *   - sync:trigger        → plaid aggregation (success only when every Item
 *                           is clean; records summed; errors concatenated) +
 *                           the unknown-service branch
 *   - sync:set-interval   → validation (bad service, out-of-range, non-numeric)
 *                           + insert-vs-update + restartCronJobs() side effect
 *   - sync:get-status     → returns the integrations rows
 *   - sync:get-log        → newest-first, integration-id → service mapping,
 *                           field shape, NULL integration → 'unknown'
 *   - calendar:get-events → source allowlist (google + apple) + time window
 *   - github:get-items    → optional state filter
 *   - gmail:get-actions   → optional done filter
 *   - gmail:mark-done     → flips done + returns { success: true }
 *
 * Real in-memory SQLite via better-sqlite3 + drizzle gives us true SQL
 * semantics without Drizzle-mock gymnastics; only the non-DB collaborators
 * (electron, plaid sync, cron, knowledge/* , auth, apple-calendar) are mocked.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// Electron: only BrowserWindow.getAllWindows + Notification are touched by the
// handlers under test. Return an empty window list so the provider branches
// pass `undefined` as the window (they're not exercised here anyway).
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: vi.fn()
}))

// Plaid sync — the one provider we DO exercise (its aggregation lives in the
// handler). Per-test settable.
const syncAllPlaidMock = vi.fn()
vi.mock('../integrations/plaid/sync', () => ({
  syncAllPlaid: () => syncAllPlaidMock()
}))

// SimpleFIN sync — also aggregated in the handler, like Plaid.
const syncAllSimplefinMock = vi.fn()
vi.mock('../integrations/simplefin/sync', () => ({
  syncAllSimplefin: () => syncAllSimplefinMock()
}))

// cron is lazy-imported by sync:set-interval to break an import cycle.
const restartCronJobsMock = vi.fn()
vi.mock('../cron', () => ({ restartCronJobs: restartCronJobsMock }))

// Heavy peripheral modules imported at the top of sync.ts but irrelevant to
// the handler seam — stub them so importing './sync' is cheap and side-effect
// free.
vi.mock('../integrations/apple-calendar', () => ({ readAppleCalendars: vi.fn() }))
vi.mock('../knowledge/extractor', () => ({
  extractFromText: vi.fn(),
  runExtractorsOnRecentSyncs: vi.fn()
}))
vi.mock('../knowledge/ollama', () => ({
  DEFAULT_OLLAMA_MODEL: 'test-model',
  detectOllama: vi.fn(),
  runOllamaPrompt: vi.fn()
}))
vi.mock('../knowledge/suggestions', () => ({
  generateSuggestions: vi.fn(),
  persistSuggestions: vi.fn()
}))
vi.mock('../knowledge/writer', () => ({ readKnowledgeFile: vi.fn() }))
vi.mock('./auth', () => ({ getValidGoogleToken: vi.fn(), loadToken: vi.fn() }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./sync')
  mod.registerSyncHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  // Schema slice — just the tables the handlers under test read/write.
  sqlite.exec(`
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER REFERENCES integrations(id),
      synced_at INTEGER NOT NULL,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      description TEXT,
      html_link TEXT,
      synced_at INTEGER
    );
    CREATE TABLE github_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      repo TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      body TEXT,
      labels TEXT,
      due_date TEXT,
      synced_at INTEGER
    );
    CREATE TABLE gmail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      action_summary TEXT,
      snippet TEXT,
      received_at INTEGER,
      snoozed_until TEXT,
      done INTEGER DEFAULT 0,
      synced_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.clearAllMocks()
})

afterEach(() => {
  sqlite.close()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedIntegration(service: string, intervalMinutes = 15): number {
  return Number(
    sqlite
      .prepare(
        "INSERT INTO integrations (service, status, sync_interval_minutes) VALUES (?, 'connected', ?)"
      )
      .run(service, intervalMinutes).lastInsertRowid
  )
}

// ── sync:trigger ───────────────────────────────────────────────────────────

describe('sync:trigger', () => {
  it('returns an error for an unknown service', async () => {
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'nope')).toEqual({ error: 'Unknown service' })
    expect(syncAllPlaidMock).not.toHaveBeenCalled()
  })

  it('aggregates plaid results — success only when every Item is clean', async () => {
    syncAllPlaidMock.mockResolvedValue([
      { itemId: 'item-1', added: 3, modified: 1, removed: 0, errorMessage: undefined },
      { itemId: 'item-2', added: 2, modified: 0, removed: 1, errorMessage: undefined }
    ])
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'plaid')).toEqual({
      service: 'plaid',
      success: true,
      recordsUpdated: 7,
      error: undefined
    })
  })

  it('marks plaid sync failed and concatenates Item errors when any Item errors', async () => {
    syncAllPlaidMock.mockResolvedValue([
      { itemId: 'item-1', added: 5, modified: 0, removed: 0, errorMessage: undefined },
      { itemId: 'item-2', added: 0, modified: 0, removed: 0, errorMessage: 'ITEM_LOGIN_REQUIRED' }
    ])
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'plaid')).toEqual({
      service: 'plaid',
      success: false,
      recordsUpdated: 5,
      error: 'item-2: ITEM_LOGIN_REQUIRED'
    })
  })

  it('aggregates simplefin results — success only when every connection is clean', async () => {
    syncAllSimplefinMock.mockResolvedValue([
      {
        connectionId: 'conn-1',
        added: 4,
        duplicates: 0,
        accountsUpserted: 1,
        errorMessage: undefined
      },
      {
        connectionId: 'conn-2',
        added: 2,
        duplicates: 3,
        accountsUpserted: 0,
        errorMessage: undefined
      }
    ])
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'simplefin')).toEqual({
      service: 'simplefin',
      success: true,
      recordsUpdated: 6,
      error: undefined
    })
  })

  it('marks simplefin sync failed and concatenates connection errors', async () => {
    syncAllSimplefinMock.mockResolvedValue([
      {
        connectionId: 'conn-1',
        added: 5,
        duplicates: 0,
        accountsUpserted: 0,
        errorMessage: undefined
      },
      {
        connectionId: 'conn-2',
        added: 0,
        duplicates: 0,
        accountsUpserted: 0,
        errorMessage: 'HTTP 403'
      }
    ])
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'simplefin')).toEqual({
      service: 'simplefin',
      success: false,
      recordsUpdated: 5,
      error: 'conn-2: HTTP 403'
    })
  })
})

// ── sync:set-interval ────────────────────────────────────────────────────────

describe('sync:set-interval', () => {
  it('rejects an unsupported service without touching the DB or cron', async () => {
    const h = await registerAndGet('sync:set-interval')
    expect(await invoke(h, 'dropbox', 30)).toEqual({ success: false, error: 'Invalid service' })
    expect(restartCronJobsMock).not.toHaveBeenCalled()
  })

  it('rejects out-of-range and non-numeric intervals', async () => {
    const h = await registerAndGet('sync:set-interval')
    expect(await invoke(h, 'google', -1)).toEqual({ success: false, error: 'Invalid interval' })
    expect(await invoke(h, 'google', 1441)).toEqual({ success: false, error: 'Invalid interval' })
    expect(await invoke(h, 'google', 'abc')).toEqual({ success: false, error: 'Invalid interval' })
    expect(restartCronJobsMock).not.toHaveBeenCalled()
  })

  it('inserts a new integration row when none exists, and restarts cron', async () => {
    const h = await registerAndGet('sync:set-interval')
    const res = await invoke(h, 'github', 45)
    expect(res).toEqual({ success: true, service: 'github', minutes: 45 })
    const row = sqlite
      .prepare(
        'SELECT service, status, sync_interval_minutes AS m FROM integrations WHERE service = ?'
      )
      .get('github') as { service: string; status: string; m: number }
    expect(row).toEqual({ service: 'github', status: 'disconnected', m: 45 })
    expect(restartCronJobsMock).toHaveBeenCalledTimes(1)
  })

  it('updates an existing integration row in place and floors fractional minutes', async () => {
    seedIntegration('google', 15)
    const h = await registerAndGet('sync:set-interval')
    const res = await invoke(h, 'google', 30.9)
    expect(res).toEqual({ success: true, service: 'google', minutes: 30 })
    const rows = sqlite
      .prepare('SELECT sync_interval_minutes AS m FROM integrations WHERE service = ?')
      .all('google') as Array<{ m: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].m).toBe(30)
  })
})

// ── sync:get-status ──────────────────────────────────────────────────────────

describe('sync:get-status', () => {
  it('returns all integration rows', async () => {
    seedIntegration('google')
    seedIntegration('github')
    const h = await registerAndGet('sync:get-status')
    const rows = (await invoke(h)) as Array<{ service: string }>
    expect(rows.map((r) => r.service).sort()).toEqual(['github', 'google'])
  })
})

// ── sync:get-log ─────────────────────────────────────────────────────────────

describe('sync:get-log', () => {
  it('returns newest-first events with service names resolved and shape mapped', async () => {
    const gId = seedIntegration('google')
    sqlite
      .prepare(
        'INSERT INTO sync_events (integration_id, synced_at, records_updated, errors) VALUES (?, ?, ?, ?)'
      )
      .run(gId, 1000, 4, null)
    sqlite
      .prepare(
        'INSERT INTO sync_events (integration_id, synced_at, records_updated, errors) VALUES (?, ?, ?, ?)'
      )
      .run(gId, 2000, 1, 'boom')
    // Orphan event (NULL integration) → 'unknown' service.
    sqlite
      .prepare(
        'INSERT INTO sync_events (integration_id, synced_at, records_updated, errors) VALUES (?, ?, ?, ?)'
      )
      .run(null, 3000, 0, null)

    const h = await registerAndGet('sync:get-log')
    const log = (await invoke(h)) as Array<{
      service: string
      syncedAt: Date
      recordsUpdated: number
      error: string | null
    }>
    // syncedAt is a Date (drizzle timestamp_ms mode); assert newest-first by epoch.
    expect(log.map((e) => e.syncedAt.getTime())).toEqual([3000, 2000, 1000]) // desc
    expect(log[0].service).toBe('unknown')
    expect(log[1]).toMatchObject({ service: 'google', recordsUpdated: 1, error: 'boom' })
    expect(log[2]).toMatchObject({ service: 'google', recordsUpdated: 4, error: null })
  })
})

// ── calendar:get-events ──────────────────────────────────────────────────────

describe('calendar:get-events', () => {
  it('returns only google/apple events inside the time window', async () => {
    const ins = sqlite.prepare(
      'INSERT INTO calendar_events (source, external_id, title, start_at) VALUES (?, ?, ?, ?)'
    )
    ins.run('google', 'g1', 'In window', 1500)
    ins.run('apple', 'a1', 'In window apple', 1800)
    ins.run('google', 'g2', 'Before window', 500)
    ins.run('google', 'g3', 'After window', 5000)
    ins.run('other', 'o1', 'Wrong source', 1600) // excluded by source allowlist

    const h = await registerAndGet('calendar:get-events')
    const events = (await invoke(
      h,
      new Date(1000).toISOString(),
      new Date(2000).toISOString()
    )) as Array<{ externalId: string }>
    expect(events.map((e) => e.externalId).sort()).toEqual(['a1', 'g1'])
  })
})

// ── github:get-items ─────────────────────────────────────────────────────────

describe('github:get-items', () => {
  beforeEach(() => {
    const ins = sqlite.prepare(
      'INSERT INTO github_items (type, repo, external_id, title, url, state) VALUES (?, ?, ?, ?, ?, ?)'
    )
    ins.run('issue', 'o/r', 'i1', 'Open issue', 'http://x', 'open')
    ins.run('pr', 'o/r', 'p1', 'Merged PR', 'http://y', 'merged')
  })

  it('returns all items when no state filter is given', async () => {
    const h = await registerAndGet('github:get-items')
    expect((await invoke(h)) as unknown[]).toHaveLength(2)
  })

  it('filters by state when provided', async () => {
    const h = await registerAndGet('github:get-items')
    const open = (await invoke(h, 'open')) as Array<{ externalId: string }>
    expect(open.map((r) => r.externalId)).toEqual(['i1'])
  })
})

// ── gmail:get-actions + gmail:mark-done ──────────────────────────────────────

describe('gmail handlers', () => {
  beforeEach(() => {
    const ins = sqlite.prepare(
      'INSERT INTO gmail_actions (thread_id, subject, from_address, done) VALUES (?, ?, ?, ?)'
    )
    ins.run('t1', 'Pending', 'a@b.com', 0)
    ins.run('t2', 'Finished', 'c@d.com', 1)
  })

  it('gmail:get-actions returns all rows without a filter', async () => {
    const h = await registerAndGet('gmail:get-actions')
    expect((await invoke(h)) as unknown[]).toHaveLength(2)
  })

  it('gmail:get-actions filters by done flag', async () => {
    const h = await registerAndGet('gmail:get-actions')
    const pending = (await invoke(h, false)) as Array<{ threadId: string }>
    expect(pending.map((r) => r.threadId)).toEqual(['t1'])
    const done = (await invoke(h, true)) as Array<{ threadId: string }>
    expect(done.map((r) => r.threadId)).toEqual(['t2'])
  })

  it('gmail:mark-done flips done and returns success', async () => {
    const h = await registerAndGet('gmail:mark-done')
    const id = Number(
      (
        sqlite.prepare('SELECT id FROM gmail_actions WHERE thread_id = ?').get('t1') as {
          id: number
        }
      ).id
    )
    expect(await invoke(h, id)).toEqual({ success: true })
    const row = sqlite.prepare('SELECT done FROM gmail_actions WHERE id = ?').get(id) as {
      done: number
    }
    expect(row.done).toBe(1)
  })
})
