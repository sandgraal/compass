/**
 * Tests for the `quick-capture:submit` IPC handler (Phase 7 Track A —
 * global capture bar) plus the exported `parseExpense` helper.
 *
 * Same harness pattern as checklist-handlers.test.ts: real in-memory SQLite
 * for true SQL semantics (unique hash, defaults), a temp dir standing in for
 * KNOWLEDGE_DIR so the note path writes real files, and a fake ipcMain that
 * just collects handlers.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
let knowledgeDir: string

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../paths', () => ({
  get KNOWLEDGE_DIR() {
    return knowledgeDir
  }
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

async function submit(kind: unknown, text: unknown): Promise<{ success: boolean; error?: string }> {
  const mod = await import('./quick-capture')
  mod.registerQuickCaptureHandlers(fakeIpcMain as IpcMain)
  const h = handlers['quick-capture:submit']
  if (!h) throw new Error('Handler not registered')
  return h({}, kind, text) as Promise<{ success: boolean; error?: string }>
}

beforeEach(() => {
  knowledgeDir = mkdtempSync(join(tmpdir(), 'compass-qc-test-'))
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
      geo TEXT NOT NULL DEFAULT 'US',
      purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER,
      source_file TEXT,
      ingested_at INTEGER
    );
    CREATE TABLE categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority INTEGER DEFAULT 0
    );
  `)
})

afterEach(() => {
  sqlite.close()
  rmSync(knowledgeDir, { recursive: true, force: true })
  vi.useRealTimers()
})

// ── parseExpense ─────────────────────────────────────────────────────────────

describe('parseExpense', () => {
  it('parses a leading amount with optional $ and commas', async () => {
    const { parseExpense } = await import('./quick-capture')
    expect(parseExpense('12.50 coffee')).toEqual({ amount: 12.5, description: 'coffee' })
    expect(parseExpense('$12.50 coffee at cafe')).toEqual({
      amount: 12.5,
      description: 'coffee at cafe'
    })
    expect(parseExpense('1,234.56 rent')).toEqual({ amount: 1234.56, description: 'rent' })
  })

  it('parses a trailing amount', async () => {
    const { parseExpense } = await import('./quick-capture')
    expect(parseExpense('coffee 12.50')).toEqual({ amount: 12.5, description: 'coffee' })
    expect(parseExpense('groceries $87')).toEqual({ amount: 87, description: 'groceries' })
  })

  it('returns null when there is no amount or no description', async () => {
    const { parseExpense } = await import('./quick-capture')
    expect(parseExpense('just a note about coffee')).toBeNull()
    expect(parseExpense('12.50')).toBeNull()
    expect(parseExpense('')).toBeNull()
  })

  it('rejects a zero amount', async () => {
    const { parseExpense } = await import('./quick-capture')
    expect(parseExpense('0 free sample')).toBeNull()
  })
})

// ── input validation ─────────────────────────────────────────────────────────

describe('quick-capture:submit validation', () => {
  it('rejects an unknown kind', async () => {
    const res = await submit('vault-entry', 'sneaky')
    expect(res).toEqual({ success: false, error: 'Unknown capture type' })
  })

  it('rejects empty / whitespace text', async () => {
    expect(await submit('task', '   ')).toEqual({ success: false, error: 'Nothing to capture' })
    expect(await submit('note', undefined)).toEqual({
      success: false,
      error: 'Nothing to capture'
    })
  })
})

// ── task ─────────────────────────────────────────────────────────────────────

describe('quick-capture task', () => {
  it('inserts a manual daily item for today, clamped to 500 chars', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T15:00:00'))

    const res = await submit('task', `  ${'x'.repeat(600)}  `)
    expect(res).toEqual({ success: true })

    const row = sqlite.prepare('SELECT * FROM checklist_items').get() as Record<string, unknown>
    expect(row.list_type).toBe('daily')
    expect(row.list_date).toBe('2026-06-11')
    expect((row.title as string).length).toBe(500)
    expect(row.source).toBe('manual')
    expect(row.category).toBe('personal')
  })
})

// ── note ─────────────────────────────────────────────────────────────────────

describe('quick-capture note', () => {
  it('creates inbox/quick-capture.md with a header on first capture', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T09:05:00'))

    const res = await submit('note', 'remember the milk')
    expect(res).toEqual({ success: true })

    const file = join(knowledgeDir, 'inbox', 'quick-capture.md')
    expect(existsSync(file)).toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content).toBe('# Quick Capture Inbox\n\n- 2026-06-11 09:05 — remember the milk\n')
  })

  it('appends to an existing inbox note and collapses newlines', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T09:05:00'))
    await submit('note', 'first')
    vi.setSystemTime(new Date('2026-06-11T17:30:00'))
    await submit('note', 'second\nline')

    const content = readFileSync(join(knowledgeDir, 'inbox', 'quick-capture.md'), 'utf8')
    expect(content).toContain('- 2026-06-11 09:05 — first\n')
    expect(content).toContain('- 2026-06-11 17:30 — second line\n')
  })
})

// ── expense ──────────────────────────────────────────────────────────────────

describe('quick-capture expense', () => {
  it('inserts a negative-amount transaction for today', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T12:00:00'))

    const res = await submit('expense', '$12.50 coffee')
    expect(res).toEqual({ success: true })

    const row = sqlite.prepare('SELECT * FROM finance_transactions').get() as Record<
      string,
      unknown
    >
    expect(row.amount).toBe(-12.5)
    expect(row.description).toBe('coffee')
    expect(row.date).toBe('2026-06-11')
    expect(row.source_file).toBe('quick-capture')
    expect(row.tax_year).toBe(2026)
  })

  it('applies categorization rules to the description', async () => {
    sqlite
      .prepare('INSERT INTO categorization_rules (pattern, category, subcategory) VALUES (?, ?, ?)')
      .run('coffee', 'Food & Dining', 'Coffee')

    await submit('expense', '4.75 coffee downtown')

    const row = sqlite.prepare('SELECT * FROM finance_transactions').get() as Record<
      string,
      unknown
    >
    expect(row.category).toBe('Food & Dining')
    expect(row.subcategory).toBe('Coffee')
  })

  it('does not dedupe two identical captures on the same day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T08:00:00'))
    expect(await submit('expense', '4.50 coffee')).toEqual({ success: true })
    vi.setSystemTime(new Date('2026-06-11T14:00:00'))
    expect(await submit('expense', '4.50 coffee')).toEqual({ success: true })

    const rows = sqlite.prepare('SELECT * FROM finance_transactions').all()
    expect(rows).toHaveLength(2)
  })

  it('returns a helpful error when no amount is present', async () => {
    const res = await submit('expense', 'lunch with sam')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Could not find an amount')
  })
})
