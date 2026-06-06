/**
 * Tests for the global-search handlers + per-domain search helpers in
 * `electron/ipc/search.ts` (Phase 0.7 coverage backfill).
 *
 * The existing `search.test.ts` covers the `scoreMatch` scoring math only.
 * This file exercises the parts that actually touch data:
 *
 *   - searchTasks / searchTransactions → real in-memory SQLite: match,
 *     score-filter, MAX_PER_KIND cap, empty result
 *   - searchKnowledge → a real temp knowledge dir: title + body match,
 *     snippet extraction, missing-dir early return
 *   - searchVault → title-only projection (NEVER leaks secret fields),
 *     allowlist-miss skip, no-key early return  [crypto mocked]
 *   - search:global handler → input guards (non-string, over-long, <2 chars)
 *     and cross-domain aggregation + per-kind counts
 *   - knowledge:list-file-index handler → returns the cached file index
 *
 * Strategy: real better-sqlite3 + drizzle for DB; a real temp dir for the
 * knowledge filesystem walk; only the vault crypto (`getOrCreateKey` /
 * `decryptBlob`) is mocked so we can assert the title-only projection without
 * standing up a real keychain-backed vault.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

const TEST_ROOT = '/tmp/compass-search-handlers-test'
const KB_DIR = join(TEST_ROOT, 'kb')
const VAULT_DIR_PATH = join(TEST_ROOT, 'vault')

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../paths', () => ({
  KNOWLEDGE_DIR: '/tmp/compass-search-handlers-test/kb',
  VAULT_DIR: '/tmp/compass-search-handlers-test/vault'
}))

// Vault crypto — indirection so the per-test mocks are read lazily (factory
// runs before the const initializers otherwise).
const getOrCreateKeyMock = vi.fn<() => Buffer>(() => Buffer.alloc(32))
const decryptBlobMock = vi.fn<(blob: Buffer, key: Buffer) => string>(() => '[]')
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => getOrCreateKeyMock(),
  decryptBlob: (blob: Buffer, key: Buffer) => decryptBlobMock(blob, key)
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./search')
  mod.registerSearchHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

async function internal() {
  return (await import('./search'))._internal
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      checked INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal',
      sort_order INTEGER DEFAULT 0,
      due_date TEXT,
      source TEXT DEFAULT 'manual',
      source_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      account_id INTEGER,
      category TEXT DEFAULT 'Uncategorized',
      subcategory TEXT,
      notes TEXT,
      source_file TEXT,
      ingested_at INTEGER,
      geo TEXT NOT NULL DEFAULT 'US',
      purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0,
      auto_updated INTEGER DEFAULT 0
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  // Fresh temp dirs for the knowledge-walk + vault-file tests.
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(KB_DIR, { recursive: true })
  mkdirSync(VAULT_DIR_PATH, { recursive: true })
  getOrCreateKeyMock.mockReturnValue(Buffer.alloc(32))
  decryptBlobMock.mockReturnValue('[]')
})

afterEach(() => {
  sqlite.close()
  rmSync(TEST_ROOT, { recursive: true, force: true })
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedTask(title: string, opts: { checked?: boolean } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO checklist_items (list_type, list_date, title, checked) VALUES ('daily', '2026-05-01', ?, ?)"
    )
    .run(title, opts.checked ? 1 : 0)
}

let txnSeq = 0
function seedTxn(description: string, amount = -10): void {
  txnSeq++
  sqlite
    .prepare(
      "INSERT INTO finance_transactions (hash, date, amount, description) VALUES (?, '2026-05-01', ?, ?)"
    )
    .run(`hash-${txnSeq}`, amount, description)
}

beforeEach(() => {
  txnSeq = 0
})

// ── searchTasks ──────────────────────────────────────────────────────────────

describe('searchTasks', () => {
  it('returns scored hits for matching task titles and skips non-matches', async () => {
    seedTask('Buy coffee beans')
    seedTask('Pay rent')
    const { searchTasks } = await internal()
    const hits = searchTasks('coffee') as Array<{ kind: string; title: string; done: boolean }>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'task', title: 'Buy coffee beans', done: false })
  })

  it('reflects the checked flag as `done`', async () => {
    seedTask('Finish report', { checked: true })
    const { searchTasks } = await internal()
    const hits = searchTasks('report') as Array<{ done: boolean }>
    expect(hits[0].done).toBe(true)
  })

  it('caps results at MAX_PER_KIND (12)', async () => {
    for (let i = 0; i < 20; i++) seedTask(`coffee run ${i}`)
    const { searchTasks } = await internal()
    expect(searchTasks('coffee')).toHaveLength(12)
  })

  it('returns nothing when no title matches', async () => {
    seedTask('Pay rent')
    const { searchTasks } = await internal()
    expect(searchTasks('zzz')).toEqual([])
  })
})

// ── searchTransactions ───────────────────────────────────────────────────────

describe('searchTransactions', () => {
  it('matches on description and returns transaction shape', async () => {
    seedTxn('STARBUCKS COFFEE', -6.5)
    seedTxn('SHELL GAS', -40)
    const { searchTransactions } = await internal()
    const hits = searchTransactions('coffee') as Array<{
      kind: string
      description: string
      amount: number
    }>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      kind: 'transaction',
      description: 'STARBUCKS COFFEE',
      amount: -6.5
    })
  })

  it('returns nothing when no description matches', async () => {
    seedTxn('SHELL GAS')
    const { searchTransactions } = await internal()
    expect(searchTransactions('coffee')).toEqual([])
  })
})

// ── searchKnowledge (real temp dir) ──────────────────────────────────────────

describe('searchKnowledge', () => {
  it('matches by title and body, extracting an H1 title + snippet', async () => {
    writeFileSync(
      join(KB_DIR, 'note.md'),
      '# Coffee Roasting Notes\n\nMy favorite beans come from a small farm.'
    )
    writeFileSync(join(KB_DIR, 'other.md'), '# Taxes\n\nQuarterly filing reminders.')
    const { searchKnowledge } = await internal()
    const hits = searchKnowledge('coffee') as Array<{
      kind: string
      title: string
      path: string
      snippet: string
    }>
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('knowledge')
    expect(hits[0].title).toBe('Coffee Roasting Notes')
    expect(hits[0].path).toBe('note.md')
    expect(hits[0].snippet).toContain('Coffee')
  })

  it('recurses into subdirectories and returns paths relative to the KB root', async () => {
    mkdirSync(join(KB_DIR, 'work'), { recursive: true })
    writeFileSync(join(KB_DIR, 'work', 'standup.md'), '# Standup\n\nDiscuss the widget rollout.')
    const { searchKnowledge } = await internal()
    const hits = searchKnowledge('widget') as Array<{ path: string }>
    expect(hits[0].path).toBe(join('work', 'standup.md'))
  })

  it('returns [] when the knowledge dir does not exist', async () => {
    rmSync(KB_DIR, { recursive: true, force: true })
    const { searchKnowledge } = await internal()
    expect(searchKnowledge('coffee')).toEqual([])
  })
})

// ── searchVault (crypto mocked) ──────────────────────────────────────────────

describe('searchVault', () => {
  function writeVaultFile(category: string): void {
    // Real bytes on disk; decryptBlob is mocked so contents don't matter.
    writeFileSync(join(VAULT_DIR_PATH, `${category}.enc`), Buffer.from('ciphertext'))
  }

  it('projects ONLY the allowlisted title field — never secret-bearing fields', async () => {
    writeVaultFile('financial')
    decryptBlobMock.mockReturnValue(
      JSON.stringify([
        { id: 'v1', institution: 'Chase Sapphire', accountNumber: '4111-1111-1111-1111' }
      ])
    )
    const { searchVault } = await internal()
    const hits = searchVault('chase') as Array<Record<string, unknown>>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      kind: 'vault',
      category: 'financial',
      id: 'v1',
      title: 'Chase Sapphire',
      score: expect.any(Number)
    })
    // The secret must not appear anywhere in the projected hit.
    expect(JSON.stringify(hits[0])).not.toContain('4111')
  })

  it('skips entries with no allowlisted label field', async () => {
    writeVaultFile('credentials')
    // credentials title field is 'service'; provide only a username (excluded).
    decryptBlobMock.mockReturnValue(JSON.stringify([{ id: 'c1', username: 'coffee@example.com' }]))
    const { searchVault } = await internal()
    expect(searchVault('coffee')).toEqual([])
  })

  it('returns [] when the vault key is unavailable', async () => {
    writeVaultFile('financial')
    getOrCreateKeyMock.mockImplementation(() => {
      throw new Error('no keychain')
    })
    const { searchVault } = await internal()
    expect(searchVault('chase')).toEqual([])
    expect(decryptBlobMock).not.toHaveBeenCalled()
  })
})

// ── search:global handler ────────────────────────────────────────────────────

describe('search:global handler', () => {
  it('returns empty for a non-string query', async () => {
    const h = await registerAndGet('search:global')
    expect(await invoke(h, 42)).toEqual({ hits: [] })
  })

  it('returns empty for an over-long query (DoS guard)', async () => {
    const h = await registerAndGet('search:global')
    expect(await invoke(h, 'x'.repeat(201))).toEqual({ hits: [] })
  })

  it('returns empty for a query shorter than 2 chars', async () => {
    const h = await registerAndGet('search:global')
    expect(await invoke(h, 'a')).toEqual({ hits: [] })
  })

  it('aggregates across domains and reports per-kind counts', async () => {
    seedTask('coffee with Sam')
    seedTxn('COFFEE SHOP')
    writeFileSync(join(KB_DIR, 'cafe.md'), '# Coffee places\n\nBest cafes in town.')
    const h = await registerAndGet('search:global')
    const res = (await invoke(h, 'coffee')) as {
      hits: Array<{ kind: string; score: number }>
      counts: { knowledge: number; vault: number; tasks: number; transactions: number }
    }
    const kinds = new Set(res.hits.map((x) => x.kind))
    expect(kinds.has('task')).toBe(true)
    expect(kinds.has('transaction')).toBe(true)
    expect(kinds.has('knowledge')).toBe(true)
    expect(res.counts.tasks).toBe(1)
    expect(res.counts.transactions).toBe(1)
    expect(res.counts.knowledge).toBe(1)
    // Sorted by descending score.
    for (let i = 1; i < res.hits.length; i++) {
      expect(res.hits[i - 1].score).toBeGreaterThanOrEqual(res.hits[i].score)
    }
  })
})

// ── knowledge:list-file-index handler ────────────────────────────────────────

describe('knowledge:list-file-index handler', () => {
  it('returns the cached knowledge_files rows', async () => {
    sqlite
      .prepare("INSERT INTO knowledge_files (path, title) VALUES ('profile/me.md', 'About Me')")
      .run()
    const h = await registerAndGet('knowledge:list-file-index')
    const rows = (await invoke(h)) as Array<{ path: string; title: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: 'profile/me.md', title: 'About Me' })
  })
})
