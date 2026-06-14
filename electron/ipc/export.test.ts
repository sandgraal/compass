/**
 * Tests for the Universal Export IPC (Phase 9 — "The Storehouse", Wave 1).
 *
 * The headline guarantee under test: `export:export-all` writes every domain as
 * an open-format file PLUS a manifest, and NEVER includes vault data. Real
 * in-memory SQLite + real temp dirs; only `electron`'s `dialog` and the
 * knowledge dir path are mocked.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

const mockDialog = {
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}
vi.mock('electron', () => ({ dialog: mockDialog }))

const { KNOWLEDGE_TMP } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join: pjoin } = require('node:path')
  return { KNOWLEDGE_TMP: mkdtempSync(pjoin(tmpdir(), 'compass-kb-')) }
})
vi.mock('../paths', () => ({ KNOWLEDGE_DIR: KNOWLEDGE_TMP }))

const outRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join: pjoin } = require('node:path')
  return mkdtempSync(pjoin(tmpdir(), 'compass-out-'))
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return Promise.resolve().then(() => h({}, ...args))
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT,
      org TEXT, job_title TEXT, phones TEXT, emails TEXT, addresses TEXT,
      birthday TEXT, url TEXT, relationship TEXT, notes TEXT, photo TEXT,
      source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      start_at INTEGER, end_at INTEGER, all_day INTEGER DEFAULT 0,
      location TEXT, description TEXT, html_link TEXT, synced_at INTEGER
    );
    CREATE TABLE finance_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL, amount REAL NOT NULL,
      description TEXT NOT NULL, account_id INTEGER,
      category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
      geo TEXT NOT NULL DEFAULT 'US', purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none', tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER, source_file TEXT, ingested_at INTEGER
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly',
      category TEXT, status TEXT NOT NULL DEFAULT 'active',
      next_renewal TEXT, payment_account TEXT, cancel_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'other', name TEXT NOT NULL,
      value REAL, provider TEXT, reference TEXT, renewal_date TEXT,
      status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
  // Seed one row per exported domain.
  sqlite
    .prepare('INSERT INTO subscriptions (external_id, name, cost, cadence) VALUES (?, ?, ?, ?)')
    .run('manual:s1', 'Netflix', 20, 'monthly')
  sqlite
    .prepare('INSERT INTO assets (external_id, type, name, value) VALUES (?, ?, ?, ?)')
    .run('manual:a1', 'property', 'Lake House', 350000)
  sqlite
    .prepare('INSERT INTO contacts (external_id, display_name, emails) VALUES (?, ?, ?)')
    .run('uid-1', 'Ada Lovelace', JSON.stringify([{ value: 'ada@example.com' }]))
  sqlite
    .prepare(
      'INSERT INTO calendar_events (source, external_id, title, start_at) VALUES (?, ?, ?, ?)'
    )
    .run('google', 'evt-1', 'Launch', Date.UTC(2026, 5, 15, 14, 0, 0))
  sqlite.prepare('INSERT INTO finance_accounts (id, name) VALUES (?, ?)').run(1, 'Checking')
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, description, account_id) VALUES (?, ?, ?, ?, ?)'
    )
    .run('h1', '2026-06-01', -42.5, 'Coffee', 1)

  mkdirSync(join(KNOWLEDGE_TMP, 'profile'), { recursive: true })
  writeFileSync(join(KNOWLEDGE_TMP, 'profile', 'relationships.md'), '# People\n\nAda Lovelace\n')

  for (const k of Object.keys(handlers)) delete handlers[k]
  mockDialog.showOpenDialog.mockReset()
  mockDialog.showSaveDialog.mockReset()
  const mod = await import('./export')
  mod.registerExportHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('export:export-all', () => {
  it('writes every domain as a standard-format file plus a manifest', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outRoot] })
    const res = (await invoke('export:export-all')) as {
      success: boolean
      path: string
      knowledgeCount: number
    }
    expect(res.success).toBe(true)
    const dir = res.path
    expect(existsSync(join(dir, 'contacts.vcf'))).toBe(true)
    expect(existsSync(join(dir, 'contacts.csv'))).toBe(true)
    expect(existsSync(join(dir, 'calendar.ics'))).toBe(true)
    expect(existsSync(join(dir, 'transactions.csv'))).toBe(true)
    expect(existsSync(join(dir, 'subscriptions.csv'))).toBe(true)
    expect(existsSync(join(dir, 'assets.csv'))).toBe(true)
    expect(existsSync(join(dir, 'manifest.txt'))).toBe(true)
    expect(existsSync(join(dir, 'knowledge', 'profile', 'relationships.md'))).toBe(true)
    expect(res.knowledgeCount).toBe(1)

    expect(readFileSync(join(dir, 'contacts.vcf'), 'utf-8')).toContain('FN:Ada Lovelace')
    expect(readFileSync(join(dir, 'calendar.ics'), 'utf-8')).toContain('SUMMARY:Launch')
    expect(readFileSync(join(dir, 'transactions.csv'), 'utf-8')).toContain('Coffee')
    expect(readFileSync(join(dir, 'subscriptions.csv'), 'utf-8')).toContain('Netflix')
    expect(readFileSync(join(dir, 'assets.csv'), 'utf-8')).toContain('Lake House')
  })

  it('NEVER writes vault data and says so in the manifest', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outRoot] })
    const res = (await invoke('export:export-all')) as { path: string }
    const files = readdirSync(res.path)
    expect(files.some((f) => f.endsWith('.enc') || f.includes('vault'))).toBe(false)
    const manifest = readFileSync(join(res.path, 'manifest.txt'), 'utf-8')
    expect(manifest).toMatch(/NOT included.*vault/s)
    expect(manifest).toContain('UNENCRYPTED')
  })

  it('returns canceled when no folder is chosen', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('export:export-all')).toMatchObject({ canceled: true })
  })
})

describe('per-domain export handlers', () => {
  it('calendar:export-ics writes an ICS the day round-trips', async () => {
    const out = join(outRoot, 'cal.ics')
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: out })
    const res = (await invoke('calendar:export-ics')) as { success: boolean }
    expect(res.success).toBe(true)
    expect(readFileSync(out, 'utf-8')).toContain('BEGIN:VCALENDAR')
  })

  it('finance:export-transactions-csv writes the ledger with account names', async () => {
    const out = join(outRoot, 'txn.csv')
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: out })
    await invoke('finance:export-transactions-csv')
    const csv = readFileSync(out, 'utf-8')
    expect(csv).toContain('Checking')
    expect(csv).toContain('Coffee')
  })

  it('knowledge:export-folder copies the markdown tree', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outRoot] })
    const res = (await invoke('knowledge:export-folder')) as {
      success: boolean
      path: string
      count: number
    }
    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    expect(existsSync(join(res.path, 'profile', 'relationships.md'))).toBe(true)
  })
})
