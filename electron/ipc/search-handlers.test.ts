/**
 * Tests for the global-search handlers + per-domain search helpers in
 * `electron/ipc/search.ts` (Phase 0.7 coverage backfill).
 *
 * `search.test.ts` covers the scoring math + the vault body-search policy.
 * This file exercises the parts that actually touch data:
 *
 *   - searchTasks / searchRecordsSpine → real in-memory SQLite (+FTS): match,
 *     score-filter, MAX_PER_KIND cap, empty result
 *   - searchKnowledge → a real temp knowledge dir: title + body match,
 *     snippet extraction, missing-dir early return
 *   - searchVault → title hits carry no snippet; credentials allowlist-miss
 *     skip; no-key early return  [crypto mocked]
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

// Unique temp root per worker — portable (uses os.tmpdir(), not a literal
// /tmp) and collision-free under parallel Vitest processes. Computed in
// vi.hoisted so the `../paths` mock factory (hoisted above imports) can
// reference the same constants.
const { TEST_ROOT, KB_DIR, VAULT_DIR_PATH } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-search-test-'))
  return {
    TEST_ROOT: root,
    KB_DIR: path.join(root, 'kb'),
    VAULT_DIR_PATH: path.join(root, 'vault')
  }
})

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

vi.mock('../paths', () => ({
  KNOWLEDGE_DIR: KB_DIR,
  VAULT_DIR: VAULT_DIR_PATH
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
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      org TEXT, relationship TEXT, search_blob TEXT
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

let recSeq = 0
function seedRecord(source: string, type: string, title: string, body: string | null = null): void {
  recSeq++
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, body, dedup_hash) VALUES (?,?,1750000000000,?,?,?)'
    )
    .run(source, type, title, body, `rec-${recSeq}`)
}

beforeEach(() => {
  recSeq = 0
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

// ── searchRecordsSpine ───────────────────────────────────────────────────────

describe('searchRecordsSpine', () => {
  it('matches spine records via FTS (finance txns arrive here now, not a LIKE-scan)', async () => {
    seedRecord('finance', 'txn', 'STARBUCKS COFFEE', '-6.50 USD · Dining')
    seedRecord('finance', 'txn', 'SHELL GAS', '-40.00 USD · Auto')
    const { searchRecordsSpine } = await internal()
    const hits = searchRecordsSpine('coffee') as Array<{
      kind: string
      source: string
      title: string
      snippet: string
    }>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      kind: 'record',
      source: 'finance',
      title: 'STARBUCKS COFFEE'
    })
    expect(hits[0].snippet).toContain('-6.50 USD')
  })

  it('caps results at MAX_PER_KIND (12)', async () => {
    for (let i = 0; i < 20; i++) seedRecord('gmail', 'email', `coffee newsletter ${i}`)
    const { searchRecordsSpine } = await internal()
    expect(searchRecordsSpine('coffee')).toHaveLength(12)
  })

  it('keeps firehose-tier sources (habit checks, browser history) out of global search', async () => {
    seedRecord('habit', 'habit-check', 'coffee habit')
    seedRecord('browser', 'visit', 'coffee — Wikipedia')
    seedRecord('finance', 'txn', 'coffee shop')
    const { searchRecordsSpine } = await internal()
    expect(
      (searchRecordsSpine('coffee') as Array<{ source: string }>).map((h) => h.source)
    ).toEqual(['finance'])
  })

  it('returns nothing when no record matches', async () => {
    seedRecord('finance', 'txn', 'SHELL GAS')
    const { searchRecordsSpine } = await internal()
    expect(searchRecordsSpine('coffee')).toEqual([])
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

  it('a title match projects the label only — other fields stay out of that hit', async () => {
    // Post vault-split, `credentials` is the only searchable vault category.
    writeVaultFile('credentials')
    decryptBlobMock.mockReturnValue(
      JSON.stringify([{ id: 'v1', service: 'Chase Sapphire', password: '4111-1111-1111-1111' }])
    )
    const { searchVault } = await internal()
    const hits = searchVault('chase') as Array<Record<string, unknown>>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      kind: 'vault',
      category: 'credentials',
      id: 'v1',
      title: 'Chase Sapphire',
      score: expect.any(Number)
    })
    // A label match must not drag other field values along with it.
    expect(JSON.stringify(hits[0])).not.toContain('4111')
  })

  it('never reads a MIGRATED category blob (financial lives in life_records now)', async () => {
    writeVaultFile('financial')
    decryptBlobMock.mockReturnValue(JSON.stringify([{ id: 'v1', institution: 'Chase Sapphire' }]))
    const { searchVault } = await internal()
    expect(searchVault('chase')).toEqual([])
    expect(decryptBlobMock).not.toHaveBeenCalled()
  })

  it('skips entries with no allowlisted label field', async () => {
    writeVaultFile('credentials')
    // credentials title field is 'service'; provide only a username (excluded).
    decryptBlobMock.mockReturnValue(JSON.stringify([{ id: 'c1', username: 'coffee@example.com' }]))
    const { searchVault } = await internal()
    expect(searchVault('coffee')).toEqual([])
  })

  it('returns [] when the vault key is unavailable', async () => {
    writeVaultFile('credentials')
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
    seedRecord('finance', 'txn', 'COFFEE SHOP', '-6.50 USD · Dining')
    sqlite
      .prepare(
        "INSERT INTO contacts (external_id, display_name, org, search_blob) VALUES ('c1', 'Coffee Roasters Co', NULL, 'coffee roasters co')"
      )
      .run()
    writeFileSync(join(KB_DIR, 'cafe.md'), '# Coffee places\n\nBest cafes in town.')
    const h = await registerAndGet('search:global')
    const res = (await invoke(h, 'coffee')) as {
      hits: Array<{ kind: string; score: number }>
      counts: {
        knowledge: number
        vault: number
        tasks: number
        records: number
        contacts: number
      }
    }
    const kinds = new Set(res.hits.map((x) => x.kind))
    expect(kinds.has('task')).toBe(true)
    expect(kinds.has('record')).toBe(true)
    expect(kinds.has('contact')).toBe(true)
    expect(kinds.has('knowledge')).toBe(true)
    expect(res.counts.tasks).toBe(1)
    expect(res.counts.records).toBe(1)
    expect(res.counts.contacts).toBe(1)
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
