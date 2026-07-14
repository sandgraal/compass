/**
 * Focused test for `syncGitHub`'s commit-capture path (the two supplementary
 * pulls beyond assigned issues): the events-feed PushEvents parse, the
 * deterministic per-repo `/repos/{owner}/{repo}/commits` supplement, that
 * they're idempotent together (externalId=sha is the upsert conflict
 * target), and that a failing repo/events call is best-effort and never
 * aborts the sync. `runExtractors=false` skips the heavy suggestion-extractor
 * path (out of scope here — see sync.test.ts's header comment on why the
 * provider syncs get their own focused mocks).
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: Object.assign(vi.fn(), { isSupported: () => false })
}))

const loadTokenMock = vi.fn()
vi.mock('./auth', () => ({
  loadToken: (service: string) => loadTokenMock(service),
  getValidGoogleToken: vi.fn(),
  hasGoogleScope: vi.fn()
}))

vi.mock('../knowledge/extractor', () => ({
  updateGitHubKnowledge: vi.fn(),
  updateCalendarKnowledge: vi.fn(),
  updateDriveKnowledge: vi.fn(),
  updateGmailKnowledge: vi.fn()
}))

vi.mock('./storehouse-sync', () => ({
  afterConnectorSync: vi.fn(),
  afterFinanceSync: vi.fn()
}))

vi.mock('./contacts', () => ({ upsertContacts: vi.fn() }))

const DDL = `
  CREATE TABLE github_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, repo TEXT NOT NULL,
    external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL,
    state TEXT NOT NULL, body TEXT, labels TEXT NOT NULL DEFAULT '[]',
    due_date TEXT, author TEXT, updated_at TEXT, synced_at INTEGER
  );
  CREATE TABLE integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'disconnected', connected_at INTEGER,
    last_synced_at INTEGER, error_message TEXT
  );
  CREATE TABLE sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id INTEGER, synced_at INTEGER,
    records_updated INTEGER NOT NULL DEFAULT 0
  );
`

/**
 * Route each GitHub endpoint to a canned response; unmatched URLs 404. Longer
 * (more specific) route keys are tried first so e.g. '/user/repos' wins over
 * '/user', and '/users/octocat/events' wins over both.
 */
function mockFetch(routes: Record<string, unknown>): void {
  const sorted = Object.entries(routes).sort(([a], [b]) => b.length - a.length)
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url)
    for (const [match, body] of sorted) {
      if (u.includes(match)) {
        return { ok: true, json: async () => body } as Response
      }
    }
    return { ok: false, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

function commitRows(): Array<{ externalId: string; repo: string; title: string }> {
  return sqlite
    .prepare(
      "SELECT external_id AS externalId, repo, title FROM github_items WHERE type = 'commit'"
    )
    .all() as Array<{ externalId: string; repo: string; title: string }>
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
  loadTokenMock.mockReset()
  loadTokenMock.mockImplementation((service: string) =>
    service === 'github' ? { access_token: 'gh-test-token' } : null
  )
})

afterEach(() => {
  sqlite.close()
  vi.restoreAllMocks()
})

describe('syncGitHub commit capture', () => {
  it('captures commits from the events feed', async () => {
    mockFetch({
      '/issues?': [],
      '/user': { login: 'octocat' },
      '/search/issues': { items: [] },
      '/users/octocat/events': [
        {
          type: 'PushEvent',
          created_at: '2026-07-01T00:00:00Z',
          repo: { name: 'octocat/hello-world' },
          payload: { commits: [{ sha: 'aaa111', message: 'Fix the thing\n\nDetails.' }] }
        },
        { type: 'WatchEvent' } // non-push events are ignored
      ],
      '/user/repos': []
    })
    const { syncGitHub } = await import('./sync')
    const res = await syncGitHub(undefined, false)
    expect(res.success).toBe(true)

    const rows = commitRows()
    expect(rows).toEqual([
      { externalId: 'aaa111', repo: 'octocat/hello-world', title: 'Fix the thing' }
    ])
  })

  it('supplements with a deterministic per-repo pull, deduped against the events feed', async () => {
    mockFetch({
      '/issues?': [],
      '/user': { login: 'octocat' },
      '/search/issues': { items: [] },
      '/users/octocat/events': [
        {
          type: 'PushEvent',
          created_at: '2026-07-01T00:00:00Z',
          repo: { name: 'octocat/hello-world' },
          payload: { commits: [{ sha: 'aaa111', message: 'Fix the thing' }] }
        }
      ],
      '/user/repos': [{ full_name: 'octocat/hello-world' }, { full_name: 'octocat/other-repo' }],
      // Same repo, same commit — must not duplicate — plus a NEW commit the
      // events feed never surfaced (the reliability gap this closes).
      '/repos/octocat/hello-world/commits': [
        {
          sha: 'aaa111',
          commit: { message: 'Fix the thing', author: { date: '2026-07-01T00:00:00Z' } },
          html_url: 'https://github.com/octocat/hello-world/commit/aaa111'
        },
        {
          sha: 'bbb222',
          commit: {
            message: 'Missed by the events feed',
            author: { date: '2026-06-15T00:00:00Z' }
          },
          html_url: 'https://github.com/octocat/hello-world/commit/bbb222'
        }
      ],
      '/repos/octocat/other-repo/commits': [
        {
          sha: 'ccc333',
          commit: { message: 'A commit in another repo', author: { date: '2026-06-01T00:00:00Z' } },
          html_url: 'https://github.com/octocat/other-repo/commit/ccc333'
        }
      ]
    })
    const { syncGitHub } = await import('./sync')
    const res = await syncGitHub(undefined, false)
    expect(res.success).toBe(true)

    const rows = commitRows()
    expect(rows).toHaveLength(3) // aaa111 deduped, bbb222 + ccc333 new
    const shas = rows.map((r) => r.externalId).sort()
    expect(shas).toEqual(['aaa111', 'bbb222', 'ccc333'])
    expect(rows.find((r) => r.externalId === 'bbb222')?.title).toBe('Missed by the events feed')
  })

  it('is best-effort: a failing repos/commits call does not fail the sync or block issues', async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/issues?')) return { ok: true, json: async () => [] } as Response
      if (u.includes('/user/repos')) return { ok: false, json: async () => ({}) } as Response
      if (u.includes('/user'))
        return { ok: true, json: async () => ({ login: 'octocat' }) } as Response
      if (u.includes('/search/issues'))
        return { ok: true, json: async () => ({ items: [] }) } as Response
      if (u.includes('/events')) throw new Error('network down')
      return { ok: false, json: async () => ({}) } as Response
    }) as unknown as typeof fetch

    const { syncGitHub } = await import('./sync')
    const res = await syncGitHub(undefined, false)
    expect(res.success).toBe(true)
    expect(commitRows()).toEqual([])
  })

  it('no login discovered → both commit pulls are skipped, sync still succeeds', async () => {
    mockFetch({ '/issues?': [], '/user': {} }) // no `login` field
    const { syncGitHub } = await import('./sync')
    const res = await syncGitHub(undefined, false)
    expect(res.success).toBe(true)
    expect(commitRows()).toEqual([])
  })
})
