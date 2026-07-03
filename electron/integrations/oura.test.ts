/**
 * Tests for the Oura integration (health-fitness — first LIVE source in that
 * category): the pure per-endpoint normalizers, the merge-by-date step, and the
 * syncOura pipeline (mocked fetch, real in-memory SQLite for the
 * integration-row + upsert bookkeeping). Mirrors linear.test.ts's style.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
let storedToken: { access_token: string } | null = null

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../ipc/auth', () => ({
  loadToken: () => storedToken
}))

// Avoid real filesystem writes to KNOWLEDGE_DIR — knowledge-file rendering has
// its own coverage; this file focuses on the fetch/merge/upsert pipeline.
const updateOuraKnowledgeMock = vi.fn()
vi.mock('../knowledge/extractor', () => ({
  updateOuraKnowledge: (...args: unknown[]) => updateOuraKnowledgeMock(...args)
}))

// syncOura reads `today` via localYmd(); pin it so the fetched window is stable.
vi.mock('../lib/dates', () => ({
  localYmd: (date?: Date) => {
    if (!date) return '2026-06-13'
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}))

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function collectionFor(url: string): unknown[] {
  if (url.includes('daily_sleep')) {
    return [{ day: '2026-06-12', score: 82, contributors: { total_sleep: 27000 } }]
  }
  if (url.includes('daily_readiness')) {
    return [{ day: '2026-06-12', score: 78 }]
  }
  if (url.includes('daily_activity')) {
    return [{ day: '2026-06-12', score: 91, steps: 8412 }]
  }
  return []
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  updateOuraKnowledgeMock.mockReset()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    return jsonResponse({ data: collectionFor(url) })
  })
  storedToken = { access_token: 'oura_test_token' }
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
    CREATE TABLE oura_daily_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
      sleep_score INTEGER, readiness_score INTEGER, activity_score INTEGER,
      steps INTEGER, total_sleep_minutes INTEGER, synced_at INTEGER
    );
  `)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

// ── normalizeOuraSleep / normalizeOuraReadiness / normalizeOuraActivity (pure) ──

describe('normalizeOuraSleep', () => {
  it('maps day/score and converts contributors.total_sleep seconds → minutes', async () => {
    const { normalizeOuraSleep } = await import('./oura')
    const rows = normalizeOuraSleep([
      { day: '2026-06-12', score: 82, contributors: { total_sleep: 27000 } }
    ])
    expect(rows).toEqual([{ date: '2026-06-12', sleepScore: 82, totalSleepMinutes: 450 }])
  })

  it('tolerates missing score/contributors and drops items without a day', async () => {
    const { normalizeOuraSleep } = await import('./oura')
    const rows = normalizeOuraSleep([
      { day: '2026-06-12' },
      { day: null as unknown as string, score: 99 }
    ])
    expect(rows).toEqual([{ date: '2026-06-12', sleepScore: null, totalSleepMinutes: null }])
  })
})

describe('normalizeOuraReadiness', () => {
  it('maps day/score and drops items without a day', async () => {
    const { normalizeOuraReadiness } = await import('./oura')
    const rows = normalizeOuraReadiness([{ day: '2026-06-12', score: 78 }, { score: 50 }])
    expect(rows).toEqual([{ date: '2026-06-12', readinessScore: 78 }])
  })
})

describe('normalizeOuraActivity', () => {
  it('maps day/score/steps and drops items without a day', async () => {
    const { normalizeOuraActivity } = await import('./oura')
    const rows = normalizeOuraActivity([
      { day: '2026-06-12', score: 91, steps: 8412 },
      { steps: 100 }
    ])
    expect(rows).toEqual([{ date: '2026-06-12', activityScore: 91, steps: 8412 }])
  })
})

// ── mergeOuraDailyRows (pure) ────────────────────────────────────────────────

describe('mergeOuraDailyRows', () => {
  it('merges rows from all three endpoints keyed by date, sorted ascending', async () => {
    const { mergeOuraDailyRows } = await import('./oura')
    const merged = mergeOuraDailyRows(
      [{ date: '2026-06-12', sleepScore: 82, totalSleepMinutes: 450 }],
      [{ date: '2026-06-12', readinessScore: 78 }],
      [{ date: '2026-06-12', activityScore: 91, steps: 8412 }]
    )
    expect(merged).toEqual([
      {
        date: '2026-06-12',
        sleepScore: 82,
        readinessScore: 78,
        activityScore: 91,
        steps: 8412,
        totalSleepMinutes: 450
      }
    ])
  })

  it('produces a row for a date present in only ONE endpoint, leaving the rest null', async () => {
    const { mergeOuraDailyRows } = await import('./oura')
    const merged = mergeOuraDailyRows([], [{ date: '2026-06-11', readinessScore: 65 }], [])
    expect(merged).toEqual([
      {
        date: '2026-06-11',
        sleepScore: null,
        readinessScore: 65,
        activityScore: null,
        steps: null,
        totalSleepMinutes: null
      }
    ])
  })

  it('sorts merged rows by date ascending', async () => {
    const { mergeOuraDailyRows } = await import('./oura')
    const merged = mergeOuraDailyRows(
      [
        { date: '2026-06-13', sleepScore: 1, totalSleepMinutes: null },
        { date: '2026-06-11', sleepScore: 2, totalSleepMinutes: null }
      ],
      [],
      []
    )
    expect(merged.map((r) => r.date)).toEqual(['2026-06-11', '2026-06-13'])
  })
})

// ── syncOura ─────────────────────────────────────────────────────────────────

describe('syncOura', () => {
  it('returns Not connected without touching rows when no token is stored', async () => {
    storedToken = null
    const { syncOura } = await import('./oura')
    const r = await syncOura(null)
    expect(r).toEqual({ service: 'oura', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 0 })
  })

  it('fetches all three endpoints and upserts one merged row per date', async () => {
    const { syncOura } = await import('./oura')
    const r = await syncOura(null)
    expect(r).toMatchObject({ service: 'oura', success: true, recordsUpdated: 1 })

    const row = sqlite.prepare('SELECT * FROM oura_daily_metrics').get() as Record<string, unknown>
    expect(row).toMatchObject({
      date: '2026-06-12',
      sleep_score: 82,
      readiness_score: 78,
      activity_score: 91,
      steps: 8412,
      total_sleep_minutes: 450
    })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='oura'").get()
    ).toMatchObject({ status: 'connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
    expect(updateOuraKnowledgeMock).toHaveBeenCalledOnce()
  })

  it('re-sync upserts the same row in place (idempotent, no duplicate dates)', async () => {
    const { syncOura } = await import('./oura')
    await syncOura(null)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('daily_sleep')) {
        return jsonResponse({ data: [{ day: '2026-06-12', score: 55, contributors: {} }] })
      }
      return jsonResponse({ data: collectionFor(url).filter((_, i) => i >= 0) })
    })
    const r = await syncOura(null)
    expect(r.recordsUpdated).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) c FROM oura_daily_metrics').get()).toMatchObject({
      c: 1
    })
    const row = sqlite.prepare('SELECT sleep_score FROM oura_daily_metrics').get() as {
      sleep_score: number
    }
    expect(row.sleep_score).toBe(55)
  })

  it('surfaces a 401 as a reconnect error via the integration row', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    const { syncOura } = await import('./oura')
    const r = await syncOura(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Reconnect')
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='oura'").get()
    ).toMatchObject({ status: 'error' })
  })

  it('surfaces a non-auth HTTP error with the status code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    const { syncOura } = await import('./oura')
    const r = await syncOura(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('500')
  })
})
