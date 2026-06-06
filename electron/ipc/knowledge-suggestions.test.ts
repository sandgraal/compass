/**
 * Tests for the knowledge:* suggestion + embedding-status handlers in
 * `electron/ipc/knowledge.ts` (Phase 0.7 function-coverage buffer).
 *
 * `knowledge.test.ts` covers the file CRUD + path-traversal guards but throws
 * on getDb (it's a file-handler-only suite). This file uses a REAL in-memory
 * SQLite to cover the DB-backed handlers that were uncovered functions:
 *
 *   - list-suggestions   → pending-only, optional targetPath filter
 *   - accept-suggestion  → not-found / already-reviewed / allowlist guards,
 *                          append-to-file (new + existing + dedup-skip),
 *                          marks accepted
 *   - dismiss-suggestion → not-found throw, already-reviewed no-op, marks dismissed
 *   - get-embedding-status → index-missing zeros vs populated counts
 *   - semantic-search    → input guards (non-string / too-long), index-missing,
 *                          ollama-error, and the success pass-through
 *
 * DB is real; the knowledge file I/O is an in-memory fs; embeddings + chokidar
 * are mocked (per-test settable for loadIndex / semanticSearch).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

const KB = '/tmp/compass-knowledge-suggestions-test'
let sqlite: Database.Database

// In-memory fs keyed by absolute path (accept-suggestion appends to a file).
const files = new Map<string, string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const v = files.get(p)
    if (v === undefined) throw new Error(`ENOENT ${p}`)
    return v
  },
  writeFileSync: (p: string, content: string) => {
    files.set(p, String(content))
  },
  mkdirSync: () => undefined,
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 }),
  unlinkSync: (p: string) => {
    files.delete(p)
  }
}))

vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: () => undefined, close: () => undefined }) }
}))

const loadIndexMock = vi.fn<() => unknown>(() => null)
const semanticSearchMock = vi.fn<(q: string, opts: unknown) => Promise<unknown>>()
vi.mock('../knowledge/embeddings', () => ({
  DEFAULT_EMBED_MODEL: 'stub-embed',
  buildEmbeddingsIndex: vi.fn(),
  loadIndex: () => loadIndexMock(),
  saveIndex: vi.fn(),
  semanticSearch: (q: string, opts: unknown) => semanticSearchMock(q, opts)
}))

vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))
vi.mock('../paths', () => ({ KNOWLEDGE_DIR: '/tmp/compass-knowledge-suggestions-test' }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}
async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./knowledge')
  mod.registerKnowledgeHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
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
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  files.clear()
  loadIndexMock.mockReturnValue(null)
  semanticSearchMock.mockReset()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedSuggestion(over: {
  targetPath?: string
  proposedContent?: string
  status?: string
  kind?: string
}): number {
  return Number(
    sqlite
      .prepare(
        `INSERT INTO knowledge_suggestions (proposed_at, source, target_path, kind, proposed_content, status)
         VALUES (?, 'gmail', ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        over.targetPath ?? 'profile/relationships.md',
        over.kind ?? 'contact',
        over.proposedContent ?? '| Sam | friend |',
        over.status ?? 'pending'
      ).lastInsertRowid
  )
}

function statusOf(id: number): string {
  return (
    sqlite.prepare('SELECT status FROM knowledge_suggestions WHERE id = ?').get(id) as {
      status: string
    }
  ).status
}

// ── list-suggestions ─────────────────────────────────────────────────────────

describe('knowledge:list-suggestions', () => {
  it('returns only pending suggestions', async () => {
    seedSuggestion({ status: 'pending', proposedContent: 'P' })
    seedSuggestion({ status: 'accepted', proposedContent: 'A' })
    seedSuggestion({ status: 'dismissed', proposedContent: 'D' })
    const h = await registerAndGet('knowledge:list-suggestions')
    const rows = (await invoke(h)) as Array<{ proposedContent: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].proposedContent).toBe('P')
  })

  it('filters by targetPath when provided', async () => {
    seedSuggestion({ targetPath: 'profile/relationships.md' })
    seedSuggestion({ targetPath: 'work/employers.md' })
    const h = await registerAndGet('knowledge:list-suggestions')
    const rows = (await invoke(h, 'work/employers.md')) as Array<{ targetPath: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].targetPath).toBe('work/employers.md')
  })
})

// ── accept-suggestion ────────────────────────────────────────────────────────

describe('knowledge:accept-suggestion', () => {
  it('throws when the suggestion does not exist', async () => {
    const h = await registerAndGet('knowledge:accept-suggestion')
    await expect(invoke(h, 999)).rejects.toThrow(/not found/i)
  })

  it('throws when the suggestion was already reviewed', async () => {
    const id = seedSuggestion({ status: 'accepted' })
    const h = await registerAndGet('knowledge:accept-suggestion')
    await expect(invoke(h, id)).rejects.toThrow(/already reviewed/i)
  })

  it('rejects a target path not in the allowlist', async () => {
    const id = seedSuggestion({ targetPath: 'work/secret-plans.md' })
    const h = await registerAndGet('knowledge:accept-suggestion')
    await expect(invoke(h, id)).rejects.toThrow(/allowlist/i)
    expect(statusOf(id)).toBe('pending') // unchanged
  })

  it('creates the file when absent and marks the suggestion accepted', async () => {
    const id = seedSuggestion({
      targetPath: 'profile/relationships.md',
      proposedContent: '| Sam Carter | friend |'
    })
    const h = await registerAndGet('knowledge:accept-suggestion')
    expect(await invoke(h, id)).toEqual({ success: true })
    expect(files.get(`${KB}/profile/relationships.md`)).toBe('| Sam Carter | friend |\n')
    expect(statusOf(id)).toBe('accepted')
  })

  it('appends to an existing file', async () => {
    files.set(`${KB}/profile/relationships.md`, '# Relationships\n')
    const id = seedSuggestion({
      targetPath: 'profile/relationships.md',
      proposedContent: '| Sam | friend |'
    })
    const h = await registerAndGet('knowledge:accept-suggestion')
    await invoke(h, id)
    expect(files.get(`${KB}/profile/relationships.md`)).toBe('# Relationships\n| Sam | friend |\n')
  })

  it('does not duplicate content already present in the file', async () => {
    files.set(`${KB}/profile/relationships.md`, '# Relationships\n| Sam | friend |\n')
    const id = seedSuggestion({
      targetPath: 'profile/relationships.md',
      proposedContent: '| Sam | friend |'
    })
    const h = await registerAndGet('knowledge:accept-suggestion')
    await invoke(h, id)
    // Unchanged — the row is still marked accepted, but no duplicate line.
    expect(files.get(`${KB}/profile/relationships.md`)).toBe('# Relationships\n| Sam | friend |\n')
    expect(statusOf(id)).toBe('accepted')
  })
})

// ── dismiss-suggestion ───────────────────────────────────────────────────────

describe('knowledge:dismiss-suggestion', () => {
  it('throws when the suggestion does not exist', async () => {
    const h = await registerAndGet('knowledge:dismiss-suggestion')
    await expect(invoke(h, 999)).rejects.toThrow(/not found/i)
  })

  it('marks a pending suggestion dismissed', async () => {
    const id = seedSuggestion({ status: 'pending' })
    const h = await registerAndGet('knowledge:dismiss-suggestion')
    expect(await invoke(h, id)).toEqual({ success: true })
    expect(statusOf(id)).toBe('dismissed')
  })

  it('is a no-op (success) when already reviewed', async () => {
    const id = seedSuggestion({ status: 'accepted' })
    const h = await registerAndGet('knowledge:dismiss-suggestion')
    expect(await invoke(h, id)).toEqual({ success: true })
    expect(statusOf(id)).toBe('accepted') // not flipped to dismissed
  })
})

// ── get-embedding-status ─────────────────────────────────────────────────────

describe('knowledge:get-embedding-status', () => {
  it('reports zeros when no index exists', async () => {
    loadIndexMock.mockReturnValue(null)
    const h = await registerAndGet('knowledge:get-embedding-status')
    expect(await invoke(h)).toEqual({
      builtAt: null,
      model: null,
      fileCount: 0,
      chunkCount: 0,
      building: false
    })
  })

  it('reports counts from a populated index', async () => {
    loadIndexMock.mockReturnValue({
      builtAt: '2026-05-01T00:00:00Z',
      model: 'nomic',
      fileMtimes: { 'a.md': 1, 'b.md': 2 },
      chunks: [{}, {}, {}]
    })
    const h = await registerAndGet('knowledge:get-embedding-status')
    expect(await invoke(h)).toEqual({
      builtAt: '2026-05-01T00:00:00Z',
      model: 'nomic',
      fileCount: 2,
      chunkCount: 3,
      building: false
    })
  })
})

// ── semantic-search ──────────────────────────────────────────────────────────

describe('knowledge:semantic-search', () => {
  it('rejects a non-string query', async () => {
    const h = await registerAndGet('knowledge:semantic-search')
    expect(await invoke(h, 42)).toEqual({ hits: [], reason: 'invalid-query' })
  })

  it('rejects an over-long query', async () => {
    const h = await registerAndGet('knowledge:semantic-search')
    expect(await invoke(h, 'x'.repeat(501))).toEqual({ hits: [], reason: 'query-too-long' })
  })

  it('reports index-missing when semanticSearch returns null', async () => {
    semanticSearchMock.mockResolvedValue(null)
    const h = await registerAndGet('knowledge:semantic-search')
    expect(await invoke(h, 'coffee')).toEqual({ hits: [], reason: 'index-missing' })
  })

  it('reports ollama-error when semanticSearch throws', async () => {
    semanticSearchMock.mockRejectedValue(new Error('connection refused'))
    const h = await registerAndGet('knowledge:semantic-search')
    expect(await invoke(h, 'coffee')).toEqual({
      hits: [],
      reason: 'ollama-error',
      error: 'connection refused'
    })
  })

  it('returns hits on success', async () => {
    const hits = [{ path: 'a.md', score: 0.9 }]
    semanticSearchMock.mockResolvedValue(hits)
    const h = await registerAndGet('knowledge:semantic-search')
    expect(await invoke(h, 'coffee')).toEqual({ hits })
  })
})
