/**
 * Tests for the Linear integration (Phase 7 Track B): the pure
 * GraphQL-response → row transformer and the syncLinear pipeline (mocked
 * fetch, real in-memory SQLite for the integration-row + upsert/prune
 * bookkeeping).
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

const fetchMock = vi.fn<typeof fetch>()

function gqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function issuesPayload(nodes: unknown[]): unknown {
  return { data: { viewer: { assignedIssues: { nodes } } } }
}

const ACTIVE = {
  id: 'uuid-1',
  identifier: 'ENG-1',
  title: 'Fix the widget',
  url: 'https://linear.app/x/issue/ENG-1',
  priority: 2,
  dueDate: '2026-07-01',
  state: { name: 'In Progress', type: 'started' },
  team: { key: 'ENG' }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  storedToken = { access_token: 'lin_api_test' }
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
    CREATE TABLE linear_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      identifier TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      state TEXT NOT NULL, state_type TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      team TEXT, due_date TEXT, synced_at INTEGER
    );
  `)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

// ── normalizeLinearIssues (pure) ─────────────────────────────────────────────

describe('normalizeLinearIssues', () => {
  it('maps active issues and drops completed/canceled + malformed nodes', async () => {
    const { normalizeLinearIssues } = await import('./linear')
    const rows = normalizeLinearIssues(
      issuesPayload([
        ACTIVE,
        {
          ...ACTIVE,
          id: 'uuid-2',
          identifier: 'ENG-2',
          state: { name: 'Done', type: 'completed' }
        },
        {
          ...ACTIVE,
          id: 'uuid-3',
          identifier: 'ENG-3',
          state: { name: 'Cancelled', type: 'canceled' }
        },
        { id: 'uuid-4', title: 'no url' }, // malformed → dropped
        { ...ACTIVE, id: 'uuid-5', identifier: 'ENG-5', state: { name: 'Todo', type: 'unstarted' } }
      ]) as never
    )
    expect(rows.map((r) => r.identifier)).toEqual(['ENG-1', 'ENG-5'])
    expect(rows[0]).toMatchObject({
      externalId: 'uuid-1',
      title: 'Fix the widget',
      state: 'In Progress',
      stateType: 'started',
      priority: 2,
      team: 'ENG',
      dueDate: '2026-07-01'
    })
  })

  it('tolerates an empty/partial response and missing optional fields', async () => {
    const { normalizeLinearIssues } = await import('./linear')
    expect(normalizeLinearIssues({})).toEqual([])
    expect(normalizeLinearIssues(issuesPayload([]) as never)).toEqual([])
    const [row] = normalizeLinearIssues(
      issuesPayload([{ id: 'u', identifier: '', title: 'T', url: 'http://x' }]) as never
    )
    expect(row).toMatchObject({
      identifier: '—',
      state: 'Unknown',
      stateType: 'unstarted',
      priority: 0,
      team: null
    })
  })
})

// ── syncLinear ───────────────────────────────────────────────────────────────

describe('syncLinear', () => {
  it('returns Not connected without touching rows when no token is stored', async () => {
    storedToken = null
    const { syncLinear } = await import('./linear')
    const r = await syncLinear(null)
    expect(r).toEqual({ service: 'linear', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 0 })
  })

  it('upserts active issues, logs the sync, and connects the integration row', async () => {
    fetchMock.mockResolvedValue(gqlResponse(issuesPayload([ACTIVE])))
    const { syncLinear } = await import('./linear')
    const r = await syncLinear(null)
    expect(r).toMatchObject({ service: 'linear', success: true, recordsUpdated: 1 })

    const row = sqlite.prepare('SELECT * FROM linear_issues').get() as Record<string, unknown>
    expect(row).toMatchObject({ external_id: 'uuid-1', identifier: 'ENG-1', state_type: 'started' })
    expect(
      sqlite.prepare("SELECT status FROM integrations WHERE service='linear'").get()
    ).toMatchObject({
      status: 'connected'
    })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
  })

  it('prunes issues that are no longer assigned/active on the next sync', async () => {
    const { syncLinear } = await import('./linear')
    fetchMock.mockResolvedValue(gqlResponse(issuesPayload([ACTIVE])))
    await syncLinear(null)
    expect(sqlite.prepare('SELECT COUNT(*) c FROM linear_issues').get()).toMatchObject({ c: 1 })

    // Second sync returns no issues → the previously-synced one is pruned.
    fetchMock.mockResolvedValue(gqlResponse(issuesPayload([])))
    const r = await syncLinear(null)
    expect(r.recordsUpdated).toBe(1) // 0 upserts + 1 prune
    expect(sqlite.prepare('SELECT COUNT(*) c FROM linear_issues').get()).toMatchObject({ c: 0 })
  })

  it('surfaces a GraphQL error via the integration row and sync event', async () => {
    fetchMock.mockResolvedValue(gqlResponse({ errors: [{ message: 'boom' }] }))
    const { syncLinear } = await import('./linear')
    const r = await syncLinear(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('boom')
    expect(
      sqlite.prepare("SELECT status, error_message FROM integrations WHERE service='linear'").get()
    ).toMatchObject({ status: 'error' })
  })

  it('maps a 401 to a reconnect message', async () => {
    fetchMock.mockResolvedValue(gqlResponse({}, 401))
    const { syncLinear } = await import('./linear')
    const r = await syncLinear(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Reconnect')
  })
})
