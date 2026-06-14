/**
 * Tests for the provider sync functions in `electron/ipc/sync.ts`
 * (Phase 6.1 — P1, chunk 2 of 2).
 *
 * Chunk 1 (`electron/ipc/sync.test.ts`) covered `registerSyncHandlers`' pure
 * DB/validation handlers. This file covers the heavy provider sync functions
 * that touch network / tokens / knowledge extractors / notifications:
 *
 *   - `syncAppleCalendar`     → reads ~/Library/Calendars (mocked), upserts
 *                                into calendar_events, logs sync event,
 *                                fires notification, updates integration row
 *   - `syncGoogle`            → fetches calendar/gmail/drive (mocked fetch),
 *                                upserts to 3 tables, runs knowledge updates,
 *                                triggers suggestion extractors when asked,
 *                                writes integration + sync_event rows,
 *                                rolls back to error on partial failure
 *   - `syncGitHub`            → fetches assigned issues (mocked fetch),
 *                                upserts to github_items, returns suggestion
 *                                inputs alongside the public result
 *   - `runSuggestionExtractors` → reads recent sync data, dedupes against
 *                                existing rows + Ollama stable keys, persists
 *                                new candidates
 *   - `maybeSendNotification` → respects notificationsEnabled (default true),
 *                                suppresses 0-records + no-error calls,
 *                                formats title/body
 *   - `sync:trigger` per-service branches (google/github/apple-calendar)
 *   - `sync:trigger-all`      → fan-out + extractor dispatch when any provider
 *                                succeeded
 *
 * Strategy mirrors chunk 1: real in-memory SQLite via better-sqlite3 + drizzle
 * for true SQL semantics; everything off-DB (electron, fetch, tokens, apple
 * calendar reader, knowledge extractor chain, ollama) is mocked.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { KnowledgeSuggestionCandidate } from '../knowledge/suggestions'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// Electron: BrowserWindow.getAllWindows + Notification (with isSupported + show).
// The handler does `new Notification(...).show()`. Under vitest 4 a `new` on an
// arrow-returning vi.fn doesn't apply the returned object, so `.show` is
// undefined and the construct silently no-ops. Use a real class for the ctor
// (also immune to biome's useArrowFunction rewrite) and a plain spy to record
// the construction args for assertions.
const notificationShowMock = vi.fn()
const notificationCtorMock = vi.fn()
const notificationIsSupportedMock = vi.fn(() => true)
class MockNotification {
  show = notificationShowMock
  constructor(options: unknown) {
    notificationCtorMock(options)
  }
}
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: Object.assign(MockNotification, { isSupported: notificationIsSupportedMock })
}))

// Plaid sync — unused here but imported by sync.ts.
vi.mock('../integrations/plaid/sync', () => ({ syncAllPlaid: vi.fn() }))
vi.mock('../integrations/simplefin/sync', () => ({ syncAllSimplefin: vi.fn() }))

// Things sync — local importer; mocked so the dispatch/gate is exercised without
// touching the real Things database on the host.
const syncThingsMock = vi.fn()
vi.mock('../integrations/things', () => ({
  syncThings: (...args: unknown[]) => syncThingsMock(...args)
}))

// cron — lazy-imported by `sync:set-interval`; harmless stub.
vi.mock('../cron', () => ({ restartCronJobs: vi.fn() }))

// Apple calendar reader — per-test settable.
const readAppleCalendarsMock = vi.fn()
vi.mock('../integrations/apple-calendar', () => ({
  readAppleCalendars: () => readAppleCalendarsMock()
}))

// Knowledge extractor chain — fire-and-forget update fns; assert they're called.
const updateCalendarKnowledgeMock = vi.fn().mockResolvedValue(undefined)
const updateGmailKnowledgeMock = vi.fn().mockResolvedValue(undefined)
const updateDriveKnowledgeMock = vi.fn().mockResolvedValue(undefined)
const updateGitHubKnowledgeMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../knowledge/extractor', () => ({
  updateCalendarKnowledge: () => updateCalendarKnowledgeMock(),
  updateGmailKnowledge: () => updateGmailKnowledgeMock(),
  updateDriveKnowledge: () => updateDriveKnowledgeMock(),
  updateGitHubKnowledge: () => updateGitHubKnowledgeMock()
}))

// Ollama — opt-in path; default off via app_settings, so detect/runPrompt
// should never be called unless a test explicitly opts in.
const detectOllamaMock = vi.fn()
const runOllamaPromptMock = vi.fn()
vi.mock('../knowledge/ollama', () => ({
  DEFAULT_OLLAMA_MODEL: 'test-model',
  detectOllama: () => detectOllamaMock(),
  runOllamaPrompt: () => runOllamaPromptMock()
}))

// Suggestion extractors — return empty by default; per-test settable.
const extractContactsFromGmailMock = vi.fn<(...args: unknown[]) => KnowledgeSuggestionCandidate[]>(
  () => []
)
const extractOrgsFromGmailMock = vi.fn<(...args: unknown[]) => KnowledgeSuggestionCandidate[]>(
  () => []
)
const extractContactsFromGithubMock = vi.fn<(...args: unknown[]) => KnowledgeSuggestionCandidate[]>(
  () => []
)
const extractContactsFromCalendarMock = vi.fn<
  (...args: unknown[]) => KnowledgeSuggestionCandidate[]
>(() => [])
const extractFactsViaOllamaMock =
  vi.fn<(...args: unknown[]) => Promise<KnowledgeSuggestionCandidate[]>>()
vi.mock('../knowledge/suggestions', () => ({
  extractContactsFromGmail: (...args: unknown[]) => extractContactsFromGmailMock(...args),
  extractOrgsFromGmail: (...args: unknown[]) => extractOrgsFromGmailMock(...args),
  extractContactsFromGithub: (...args: unknown[]) => extractContactsFromGithubMock(...args),
  extractContactsFromCalendar: (...args: unknown[]) => extractContactsFromCalendarMock(...args),
  extractFactsViaOllama: (...args: unknown[]) => extractFactsViaOllamaMock(...args)
}))

const readKnowledgeFileMock = vi.fn(() => '')
vi.mock('../knowledge/writer', () => ({ readKnowledgeFile: () => readKnowledgeFileMock() }))

// Auth: tokens — per-test settable.
const loadTokenMock = vi.fn()
const getValidGoogleTokenMock = vi.fn()
vi.mock('./auth', () => ({
  loadToken: (service: string) => loadTokenMock(service),
  getValidGoogleToken: () => getValidGoogleTokenMock()
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

async function loadSync(): Promise<typeof import('./sync')> {
  return import('./sync')
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await loadSync()
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
  // Schema slice — every table any provider sync fn or extractor reads/writes.
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
    CREATE TABLE drive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mime_type TEXT,
      url TEXT,
      summary TEXT,
      last_modified INTEGER,
      synced_at INTEGER
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE knowledge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  // `resetAllMocks` (vs `clearAllMocks`) also wipes mockImplementation / mockReturnValue
  // — important here because some tests intentionally make extractors throw, and we
  // don't want that leaking into the next test.
  vi.resetAllMocks()
  // Re-establish the per-mock defaults that the factories wire into the module.
  notificationIsSupportedMock.mockReturnValue(true)
  extractContactsFromGmailMock.mockReturnValue([])
  extractOrgsFromGmailMock.mockReturnValue([])
  extractContactsFromGithubMock.mockReturnValue([])
  extractContactsFromCalendarMock.mockReturnValue([])
  extractFactsViaOllamaMock.mockResolvedValue([])
  readKnowledgeFileMock.mockReturnValue('')
  updateCalendarKnowledgeMock.mockResolvedValue(undefined)
  updateGmailKnowledgeMock.mockResolvedValue(undefined)
  updateDriveKnowledgeMock.mockResolvedValue(undefined)
  updateGitHubKnowledgeMock.mockResolvedValue(undefined)
  // default-on per the production DEFAULT (and matches the docstring contract)
  sqlite
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run('notificationsEnabled', 'true')
})

afterEach(() => {
  sqlite.close()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedIntegration(service: string): number {
  return Number(
    sqlite
      .prepare(
        "INSERT INTO integrations (service, status, sync_interval_minutes) VALUES (?, 'connected', 15)"
      )
      .run(service).lastInsertRowid
  )
}

function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

function rowCount(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n
}

function integrationStatus(service: string): { status: string; error_message: string | null } {
  return sqlite
    .prepare('SELECT status, error_message FROM integrations WHERE service = ?')
    .get(service) as { status: string; error_message: string | null }
}

/** Build a fetch response stub that the sync fns can read with `.ok` + `.json()`. */
function okJson(payload: unknown): Response {
  return { ok: true, json: () => Promise.resolve(payload) } as unknown as Response
}

// ── maybeSendNotification ───────────────────────────────────────────────────

describe('maybeSendNotification', () => {
  it('is a no-op when 0 records and no error (nothing actually happened)', async () => {
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('google', 0)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('respects notificationsEnabled=false in app_settings', async () => {
    setSetting('notificationsEnabled', 'false')
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('google', 3)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('defaults to enabled when the setting row is missing entirely', async () => {
    sqlite.prepare('DELETE FROM app_settings WHERE key = ?').run('notificationsEnabled')
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('github', 2)
    expect(notificationCtorMock).toHaveBeenCalledOnce()
  })

  it('skips silently when Notification.isSupported() returns false', async () => {
    notificationIsSupportedMock.mockReturnValue(false)
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('google', 5)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('formats success body with human-readable service label and record count', async () => {
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('apple-calendar', 7)
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Compass — Apple Calendar synced',
      body: '7 records updated'
    })
    expect(notificationShowMock).toHaveBeenCalledOnce()
  })

  it('formats error body and truncates long error messages to 80 chars', async () => {
    const longErr = 'x'.repeat(200)
    const { maybeSendNotification } = await loadSync()
    maybeSendNotification('plaid', 0, longErr)
    const callArgs = notificationCtorMock.mock.calls[0] as unknown as Array<{
      title: string
      body: string
    }>
    expect(callArgs[0].title).toBe('Compass — Plaid synced')
    expect(callArgs[0].body).toBe(`Sync failed: ${'x'.repeat(80)}`)
  })
})

// ── syncAppleCalendar ───────────────────────────────────────────────────────

describe('syncAppleCalendar', () => {
  const sampleEvent = {
    uid: 'evt-1',
    title: 'Coffee with Sam',
    startAt: new Date('2026-06-06T15:00:00Z'),
    endAt: new Date('2026-06-06T16:00:00Z'),
    allDay: false,
    location: 'Kaffeine',
    description: null
  }

  it('upserts events, marks integration connected, logs a sync_event, returns success', async () => {
    readAppleCalendarsMock.mockReturnValue([sampleEvent])
    const { syncAppleCalendar } = await loadSync()
    const result = await syncAppleCalendar()
    expect(result).toEqual({ service: 'apple-calendar', success: true, recordsUpdated: 1 })
    expect(rowCount('calendar_events')).toBe(1)
    const stored = sqlite
      .prepare('SELECT source, external_id, title FROM calendar_events')
      .get() as { source: string; external_id: string; title: string }
    expect(stored.source).toBe('apple')
    expect(stored.external_id).toBe('apple:evt-1')
    expect(stored.title).toBe('Coffee with Sam')
    expect(integrationStatus('apple-calendar')).toEqual({
      status: 'connected',
      error_message: null
    })
    expect(rowCount('sync_events')).toBe(1)
    expect(notificationCtorMock).toHaveBeenCalledOnce()
  })

  it('falls back to "(No title)" when the source event has an empty title', async () => {
    readAppleCalendarsMock.mockReturnValue([{ ...sampleEvent, title: '' }])
    const { syncAppleCalendar } = await loadSync()
    await syncAppleCalendar()
    const stored = sqlite.prepare('SELECT title FROM calendar_events').get() as { title: string }
    expect(stored.title).toBe('(No title)')
  })

  it('records error + flips an existing integration row to status=error when the reader throws', async () => {
    seedIntegration('apple-calendar')
    readAppleCalendarsMock.mockImplementation(() => {
      throw new Error('calendar locked')
    })
    const { syncAppleCalendar } = await loadSync()
    const result = await syncAppleCalendar()
    expect(result.success).toBe(false)
    expect(result.error).toBe('calendar locked')
    expect(integrationStatus('apple-calendar')).toEqual({
      status: 'error',
      error_message: 'calendar locked'
    })
    expect(rowCount('sync_events')).toBe(1)
    const ev = sqlite.prepare('SELECT errors FROM sync_events').get() as { errors: string }
    expect(ev.errors).toBe('calendar locked')
  })

  it('creates the integration row on a first-ever sync failure (no connect flow exists)', async () => {
    // Regression guard: Apple Calendar has no auth/connect step, so the very
    // first sync attempt may fail before any row exists. The error path must
    // upsert (not plain-UPDATE) so the failure surfaces as a status=error row
    // plus a logged sync_event — rather than vanishing silently.
    expect(rowCount('integrations')).toBe(0)
    readAppleCalendarsMock.mockImplementation(() => {
      throw new Error('first run, no permission yet')
    })
    const { syncAppleCalendar } = await loadSync()
    const result = await syncAppleCalendar()
    expect(result).toEqual({
      service: 'apple-calendar',
      success: false,
      error: 'first run, no permission yet'
    })
    expect(integrationStatus('apple-calendar')).toEqual({
      status: 'error',
      error_message: 'first run, no permission yet'
    })
    expect(rowCount('sync_events')).toBe(1)
  })

  it('does not fire a notification when no events were read (0 records, no error)', async () => {
    readAppleCalendarsMock.mockReturnValue([])
    const { syncAppleCalendar } = await loadSync()
    const result = await syncAppleCalendar()
    expect(result).toEqual({ service: 'apple-calendar', success: true, recordsUpdated: 0 })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })
})

// ── syncGoogle ──────────────────────────────────────────────────────────────

describe('syncGoogle', () => {
  function mockFetchResponses(responses: Response[]): void {
    const queue = [...responses]
    global.fetch = vi.fn(() => {
      const next = queue.shift()
      if (!next) throw new Error('fetch called more times than mocked')
      return Promise.resolve(next)
    }) as unknown as typeof fetch
  }

  it('returns early with "Not connected" when no token is on disk', async () => {
    loadTokenMock.mockReturnValue(null)
    const { syncGoogle } = await loadSync()
    const result = await syncGoogle()
    expect(result).toEqual({ service: 'google', success: false, error: 'Not connected' })
    expect(getValidGoogleTokenMock).not.toHaveBeenCalled()
  })

  it('fetches calendar+gmail+drive, upserts each, updates integration, returns total count', async () => {
    seedIntegration('google')
    loadTokenMock.mockReturnValue({ access_token: 'old' })
    getValidGoogleTokenMock.mockResolvedValue('fresh-access-token')
    mockFetchResponses([
      okJson({
        items: [
          {
            id: 'cal-1',
            summary: 'Team standup',
            start: { dateTime: '2026-06-06T09:00:00Z' },
            end: { dateTime: '2026-06-06T09:30:00Z' }
          }
        ]
      }),
      okJson({ messages: [{ id: 'msg-1' }] }),
      okJson({
        threadId: 'thr-1',
        snippet: 'hi',
        payload: {
          headers: [
            { name: 'Subject', value: 'Hello' },
            { name: 'From', value: 'sam@example.com' },
            { name: 'Date', value: '2026-06-05T12:00:00Z' }
          ]
        }
      }),
      okJson({
        files: [{ id: 'drv-1', name: 'Notes.md', mimeType: 'text/markdown' }]
      })
    ])

    const { syncGoogle } = await loadSync()
    const result = await syncGoogle(null, false)

    expect(result.success).toBe(true)
    expect(result.recordsUpdated).toBe(3) // 1 cal + 1 gmail + 1 drive
    expect(rowCount('calendar_events')).toBe(1)
    expect(rowCount('gmail_actions')).toBe(1)
    expect(rowCount('drive_files')).toBe(1)
    expect(integrationStatus('google')).toEqual({ status: 'connected', error_message: null })
    expect(rowCount('sync_events')).toBe(1)
    expect(updateCalendarKnowledgeMock).toHaveBeenCalledOnce()
    expect(updateGmailKnowledgeMock).toHaveBeenCalledOnce()
    expect(updateDriveKnowledgeMock).toHaveBeenCalledOnce()
  })

  it('flips integration to error and surfaces the message when the token refresh throws', async () => {
    seedIntegration('google')
    loadTokenMock.mockReturnValue({ access_token: 'old' })
    getValidGoogleTokenMock.mockRejectedValue(new Error('refresh failed'))
    global.fetch = vi.fn() as unknown as typeof fetch

    const { syncGoogle } = await loadSync()
    const result = await syncGoogle(null, false)

    expect(result).toEqual({ service: 'google', success: false, error: 'refresh failed' })
    expect(integrationStatus('google')).toEqual({
      status: 'error',
      error_message: 'refresh failed'
    })
    // failed run still logs a sync_event with the error captured
    const ev = sqlite.prepare('SELECT errors FROM sync_events').get() as { errors: string }
    expect(ev.errors).toBe('refresh failed')
  })

  it('does NOT run suggestion extractors when called with runExtractors=false', async () => {
    seedIntegration('google')
    loadTokenMock.mockReturnValue({ access_token: 'old' })
    getValidGoogleTokenMock.mockResolvedValue('tok')
    mockFetchResponses([okJson({ items: [] }), okJson({ messages: [] }), okJson({ files: [] })])

    const { syncGoogle } = await loadSync()
    await syncGoogle(null, false)
    // The extractors live inside runSuggestionExtractors — easiest signal is
    // the regex mocks. None of them should have been touched.
    expect(extractContactsFromGmailMock).not.toHaveBeenCalled()
    expect(extractContactsFromGithubMock).not.toHaveBeenCalled()
  })

  it('DOES run suggestion extractors when called with runExtractors=true (the default)', async () => {
    seedIntegration('google')
    loadTokenMock.mockReturnValue({ access_token: 'old' })
    getValidGoogleTokenMock.mockResolvedValue('tok')
    mockFetchResponses([okJson({ items: [] }), okJson({ messages: [] }), okJson({ files: [] })])

    const { syncGoogle } = await loadSync()
    await syncGoogle()
    expect(extractContactsFromGmailMock).toHaveBeenCalledOnce()
    expect(extractContactsFromGithubMock).toHaveBeenCalledOnce()
  })
})

// ── syncGitHub ──────────────────────────────────────────────────────────────

describe('syncGitHub', () => {
  it('returns "Not connected" when no token exists', async () => {
    loadTokenMock.mockReturnValue(null)
    const { syncGitHub } = await loadSync()
    const result = await syncGitHub()
    expect(result).toEqual({ service: 'github', success: false, error: 'Not connected' })
  })

  it('fetches assigned issues, upserts, returns suggestion inputs alongside public result', async () => {
    seedIntegration('github')
    loadTokenMock.mockReturnValue({ access_token: 'gh-tok' })
    global.fetch = vi.fn(() =>
      Promise.resolve(
        okJson([
          {
            id: 42,
            title: 'Fix the thing',
            html_url: 'https://github.com/acme/widget/issues/3',
            state: 'open',
            body: 'long body...',
            labels: [{ name: 'bug' }],
            repository: { full_name: 'acme/widget' },
            assignee: { login: 'me' },
            user: { login: 'alice' }
            // pull_request: undefined → it's an issue, not a PR
          }
        ])
      )
    ) as unknown as typeof fetch

    const { syncGitHub } = await loadSync()
    const result = await syncGitHub(null, false)

    expect(result.success).toBe(true)
    expect(result.recordsUpdated).toBe(1)
    expect(result.githubSuggestionInputs).toEqual([
      {
        id: 42,
        html_url: 'https://github.com/acme/widget/issues/3',
        type: 'issue',
        repo: 'acme/widget',
        title: 'Fix the thing',
        assignee: { login: 'me' },
        user: { login: 'alice' },
        labels: [{ name: 'bug' }]
      }
    ])
    expect(rowCount('github_items')).toBe(1)
    const row = sqlite.prepare('SELECT type, repo, state FROM github_items').get() as {
      type: string
      repo: string
      state: string
    }
    expect(row).toEqual({ type: 'issue', repo: 'acme/widget', state: 'open' })
    expect(updateGitHubKnowledgeMock).toHaveBeenCalledOnce()
  })

  it('marks rows as PR when issue.pull_request is present', async () => {
    seedIntegration('github')
    loadTokenMock.mockReturnValue({ access_token: 'gh-tok' })
    global.fetch = vi.fn(() =>
      Promise.resolve(
        okJson([
          {
            id: 99,
            title: 'A PR',
            html_url: 'https://github.com/acme/widget/pull/9',
            state: 'open',
            pull_request: { url: 'x' },
            labels: [],
            repository: { full_name: 'acme/widget' }
          }
        ])
      )
    ) as unknown as typeof fetch
    const { syncGitHub } = await loadSync()
    const result = await syncGitHub(null, false)
    expect(result.githubSuggestionInputs?.[0].type).toBe('pr')
    const row = sqlite.prepare('SELECT type FROM github_items').get() as { type: string }
    expect(row.type).toBe('pr')
  })

  it('flips integration to error when fetch itself throws (and still logs sync_event)', async () => {
    seedIntegration('github')
    loadTokenMock.mockReturnValue({ access_token: 'gh-tok' })
    global.fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch

    const { syncGitHub } = await loadSync()
    const result = await syncGitHub(null, false)
    expect(result).toEqual({ service: 'github', success: false, error: 'network down' })
    expect(integrationStatus('github')).toEqual({
      status: 'error',
      error_message: 'network down'
    })
    expect(rowCount('sync_events')).toBe(1)
  })
})

// ── runSuggestionExtractors ─────────────────────────────────────────────────

describe('runSuggestionExtractors', () => {
  it('persists each regex-extractor candidate as a knowledge_suggestions row', async () => {
    extractContactsFromGmailMock.mockReturnValue([
      {
        source: 'gmail',
        targetPath: 'profile/relationships.md',
        kind: 'contact',
        proposedContent: '| Sam Carter | friend |',
        context: 'appeared 3x'
      }
    ])
    const { runSuggestionExtractors } = await loadSync()
    await runSuggestionExtractors()
    expect(rowCount('knowledge_suggestions')).toBe(1)
    const row = sqlite
      .prepare('SELECT source, kind, target_path, status FROM knowledge_suggestions')
      .get() as { source: string; kind: string; target_path: string; status: string }
    expect(row).toEqual({
      source: 'gmail',
      kind: 'contact',
      target_path: 'profile/relationships.md',
      status: 'pending'
    })
  })

  it('skips duplicates against existing (targetPath + proposedContent) rows', async () => {
    sqlite
      .prepare(
        "INSERT INTO knowledge_suggestions (proposed_at, source, target_path, kind, proposed_content, status) VALUES (?, 'gmail', 'profile/relationships.md', 'contact', '| Sam | x |', 'pending')"
      )
      .run(Date.now())
    extractContactsFromGmailMock.mockReturnValue([
      {
        source: 'gmail',
        targetPath: 'profile/relationships.md',
        kind: 'contact',
        proposedContent: '| Sam | x |',
        context: ''
      }
    ])
    const { runSuggestionExtractors } = await loadSync()
    await runSuggestionExtractors()
    expect(rowCount('knowledge_suggestions')).toBe(1)
  })

  it('skips Ollama duplicates by their stable (source + sourceId) key', async () => {
    sqlite
      .prepare(
        "INSERT INTO knowledge_suggestions (proposed_at, source, source_id, target_path, kind, proposed_content, status) VALUES (?, 'ollama:gmail', 'msg-7', 'profile/relationships.md', 'contact', '| OLD | x |', 'pending')"
      )
      .run(Date.now())
    setSetting('ollamaSuggestionsEnabled', 'true')
    extractFactsViaOllamaMock.mockResolvedValue([
      {
        source: 'ollama:gmail',
        sourceId: 'msg-7',
        targetPath: 'profile/relationships.md',
        kind: 'contact',
        proposedContent: '| NEW | x |', // different content, same stable key → skip
        context: ''
      }
    ])
    const { runSuggestionExtractors } = await loadSync()
    await runSuggestionExtractors()
    expect(rowCount('knowledge_suggestions')).toBe(1)
  })

  it('swallows extractor errors so a broken extractor cannot break a sync', async () => {
    extractContactsFromGmailMock.mockImplementation(() => {
      throw new Error('extractor broke')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runSuggestionExtractors } = await loadSync()
    await expect(runSuggestionExtractors()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('uses githubInputsOverride instead of re-reading github_items when provided', async () => {
    const override = [
      {
        id: 7,
        html_url: 'https://github.com/x/y/issues/1',
        type: 'issue' as const,
        repo: 'x/y',
        title: 'override',
        assignee: null,
        user: null,
        labels: []
      }
    ]
    const { runSuggestionExtractors } = await loadSync()
    await runSuggestionExtractors(override)
    // The github-from-DB path would have been empty (no rows); the override
    // must be what the github contact extractor saw.
    expect(extractContactsFromGithubMock).toHaveBeenCalledWith(override, expect.any(String))
  })
})

// ── sync:trigger per-service dispatch ───────────────────────────────────────

describe('sync:trigger — provider branches', () => {
  it('dispatches "google" to syncGoogle and returns its result shape', async () => {
    loadTokenMock.mockReturnValue(null) // shortcut: early-return path
    const h = await registerAndGet('sync:trigger')
    expect(await invoke(h, 'google')).toEqual({
      service: 'google',
      success: false,
      error: 'Not connected'
    })
  })

  it('dispatches "github" through syncGitHub, but strips the internal field from the public result', async () => {
    loadTokenMock.mockReturnValue({ access_token: 'gh-tok' })
    global.fetch = vi.fn(() => Promise.resolve(okJson([]))) as unknown as typeof fetch
    seedIntegration('github')
    const h = await registerAndGet('sync:trigger')
    const result = (await invoke(h, 'github')) as Record<string, unknown>
    expect(result.service).toBe('github')
    expect(result.success).toBe(true)
    // `githubSuggestionInputs` is an internal field — must not leak to the renderer.
    expect(result).not.toHaveProperty('githubSuggestionInputs')
  })

  it('dispatches "apple-calendar" to syncAppleCalendar', async () => {
    readAppleCalendarsMock.mockReturnValue([])
    const h = await registerAndGet('sync:trigger')
    const result = await invoke(h, 'apple-calendar')
    expect(result).toEqual({ service: 'apple-calendar', success: true, recordsUpdated: 0 })
  })

  it('dispatches "things" to syncThings and flips the opt-in flag to connected', async () => {
    syncThingsMock.mockResolvedValue({ service: 'things', success: true, recordsUpdated: 2 })
    const h = await registerAndGet('sync:trigger')
    const result = await invoke(h, 'things')
    expect(result).toEqual({ service: 'things', success: true, recordsUpdated: 2 })
    expect(syncThingsMock).toHaveBeenCalledOnce()
    // Connect / manual refresh flips the row to connected before syncing — this
    // is what re-enables a reconnect after disconnect (syncThings self-gates on
    // a 'disconnected' row).
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='things'").get()
    ).toMatchObject({ status: 'connected' })
  })
})

// ── sync:trigger-all ────────────────────────────────────────────────────────

describe('sync:trigger-all', () => {
  it('fans out to all three providers and returns three sanitized results', async () => {
    loadTokenMock.mockReturnValue(null) // google + github both early-return Not connected
    readAppleCalendarsMock.mockReturnValue([])
    const h = await registerAndGet('sync:trigger-all')
    const out = (await invoke(h)) as Array<Record<string, unknown>>
    expect(out).toHaveLength(3)
    const services = out.map((r) => r.service).sort()
    expect(services).toEqual(['apple-calendar', 'github', 'google'])
    // No internal fields leak out
    for (const r of out) {
      expect(r).not.toHaveProperty('githubSuggestionInputs')
    }
  })

  it('includes things in the fan-out only once it is connected (a row exists)', async () => {
    loadTokenMock.mockReturnValue(null) // google + github early-return
    readAppleCalendarsMock.mockReturnValue([])
    seedIntegration('things')
    syncThingsMock.mockResolvedValue({ service: 'things', success: true, recordsUpdated: 1 })
    const h = await registerAndGet('sync:trigger-all')
    const out = (await invoke(h)) as Array<Record<string, unknown>>
    expect(out.map((r) => r.service).sort()).toEqual([
      'apple-calendar',
      'github',
      'google',
      'things'
    ])
    expect(syncThingsMock).toHaveBeenCalledOnce()
  })

  it('excludes things from the fan-out when its row is disconnected (no noisy failure)', async () => {
    loadTokenMock.mockReturnValue(null)
    readAppleCalendarsMock.mockReturnValue([])
    sqlite
      .prepare("INSERT INTO integrations (service, status) VALUES ('things', 'disconnected')")
      .run()
    const h = await registerAndGet('sync:trigger-all')
    const out = (await invoke(h)) as Array<Record<string, unknown>>
    expect(out.map((r) => r.service).sort()).toEqual(['apple-calendar', 'github', 'google'])
    expect(syncThingsMock).not.toHaveBeenCalled()
  })

  it('does NOT call extractors when every provider fails (nothing to extract from)', async () => {
    loadTokenMock.mockReturnValue(null)
    readAppleCalendarsMock.mockImplementation(() => {
      throw new Error('apple failed')
    })
    const h = await registerAndGet('sync:trigger-all')
    await invoke(h)
    // No success → none of the regex extractors fire
    expect(extractContactsFromGmailMock).not.toHaveBeenCalled()
    expect(extractContactsFromGithubMock).not.toHaveBeenCalled()
  })

  it('DOES call extractors when at least one provider succeeded', async () => {
    seedIntegration('google')
    loadTokenMock.mockImplementation((service: string) => {
      if (service === 'google') return { access_token: 'tok' }
      return null
    })
    getValidGoogleTokenMock.mockResolvedValue('fresh')
    global.fetch = vi.fn(() => Promise.resolve(okJson({ items: [] }))) as unknown as typeof fetch
    readAppleCalendarsMock.mockReturnValue([])
    const h = await registerAndGet('sync:trigger-all')
    await invoke(h)
    // Google succeeded → extractors fired (once, by the fan-out, not per-provider)
    expect(extractContactsFromGmailMock).toHaveBeenCalledOnce()
    expect(extractContactsFromGithubMock).toHaveBeenCalledOnce()
  })
})
