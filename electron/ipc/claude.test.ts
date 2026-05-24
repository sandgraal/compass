/**
 * Tests for the claude:* IPC handlers + apply layer (Phase 8.2 — Claude Inbox).
 *
 * Real in-memory SQLite via better-sqlite3 + drizzle (same pattern as the
 * habits/finance tests). We mock:
 *   - '../db/client'  → getDb over the in-memory DB
 *   - 'electron'      → finance.ts pulls in dialog/BrowserWindow at import
 *   - '../paths'      → redirect KNOWLEDGE_DIR/DATA_DIR to a temp dir so note
 *                       proposals write to a throwaway tree (real fs, no mock)
 *
 * Coverage: inbox ingest (dedup + malformed-line tolerance), apply routing for
 * every proposal type (incl. the LLM-trust-boundary re-validation: path
 * traversal, tax-tag whitelist, list-type domain, strict boolean, explicit
 * habit state), and the approve/reject/clear lifecycle.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

const { TMP_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return { TMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ipc-home-')) }
})

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../paths', () => ({
  APP_DATA_DIR: TMP_HOME,
  DATA_DIR: join(TMP_HOME, '.data'),
  VAULT_DIR: join(TMP_HOME, '.vault'),
  KNOWLEDGE_DIR: join(TMP_HOME, 'knowledge-base')
}))

import { applyProposal, ingestProposals, listProposals, registerClaudeHandlers } from './claude'

const KB = join(TMP_HOME, 'knowledge-base')

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function db() {
  return drizzle(sqlite, { schema })
}

function makeLine(
  over: Partial<{ id: string; createdAt: string; type: string; payload: unknown }>
) {
  return JSON.stringify({
    id: over.id ?? crypto.randomUUID(),
    createdAt: over.createdAt ?? new Date().toISOString(),
    status: 'pending',
    source: 'claude-mcp',
    type: over.type ?? 'task',
    payload: over.payload ?? { title: 'x', listType: 'daily', listDate: '2026-05-23' }
  })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE claude_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'claude-mcp',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      error TEXT,
      result_ref TEXT,
      cleared_at INTEGER
    );
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
      created_at INTEGER NOT NULL
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      tax_tag TEXT,
      tax_tag_source TEXT
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    );
  `)
  mkdirSync(KB, { recursive: true })
})

afterEach(() => {
  sqlite.close()
  rmSync(KB, { recursive: true, force: true })
})

afterAll(() => {
  // Remove the whole temp home so repeated runs don't leak dirs.
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('ingestProposals', () => {
  it('inserts new proposals and dedups by proposalId across runs', () => {
    const file = join(tmpdir(), `inbox-${crypto.randomUUID()}.jsonl`)
    const a = makeLine({ id: 'p1' })
    const b = makeLine({
      id: 'p2',
      type: 'habit_check',
      payload: { habitId: 1, date: '2026-05-23', completed: true }
    })
    writeFileSync(file, `${a}\n${b}\n`)

    expect(ingestProposals(db(), file)).toBe(2)
    // Re-running with the same file (plus a dup) inserts only the new one.
    writeFileSync(file, `${a}\n${b}\n${makeLine({ id: 'p3' })}\n`)
    expect(ingestProposals(db(), file)).toBe(1)
    expect(listProposals(db())).toHaveLength(3)
    rmSync(file, { force: true })
  })

  it('tolerates malformed / partial lines and bad types', () => {
    const file = join(tmpdir(), `inbox-${crypto.randomUUID()}.jsonl`)
    writeFileSync(
      file,
      [
        makeLine({ id: 'ok' }),
        '{ not json',
        JSON.stringify({ id: 'no-type', createdAt: new Date().toISOString(), payload: {} }),
        JSON.stringify({
          id: 'bad-type',
          createdAt: new Date().toISOString(),
          type: 'evil',
          payload: {}
        }),
        '',
        makeLine({ id: 'ok2' })
      ].join('\n')
    )
    expect(ingestProposals(db(), file)).toBe(2)
    rmSync(file, { force: true })
  })

  it('returns 0 when the inbox file is absent', () => {
    expect(ingestProposals(db(), join(tmpdir(), 'does-not-exist.jsonl'))).toBe(0)
  })
})

describe('applyProposal', () => {
  it('task → inserts a checklist item and returns its ref', () => {
    const ref = applyProposal(db(), 'task', {
      title: 'Call dentist',
      listType: 'daily',
      listDate: '2026-05-23',
      category: 'personal'
    })
    expect(ref).toMatch(/^checklist:\d+$/)
    const row = db().select().from(schema.checklistItems).all()[0]
    expect(row.title).toBe('Call dentist')
    expect(row.source).toBe('claude')
  })

  it('task → rejects an invalid listType', () => {
    expect(() =>
      applyProposal(db(), 'task', { title: 'x', listType: 'master', listDate: '2026-05-23' })
    ).toThrow(/invalid listType/)
  })

  it('task → rejects an impossible listDate (re-validates the LLM payload)', () => {
    for (const listDate of ['2026-13-40', '2026-02-30', '05/23/2026']) {
      expect(() =>
        applyProposal(db(), 'task', { title: 'x', listType: 'daily', listDate })
      ).toThrow(/invalid listDate/)
    }
  })

  it('note (create) → writes a file under the knowledge base', () => {
    const ref = applyProposal(db(), 'note', {
      path: 'notes/idea.md',
      content: '# Idea\n',
      mode: 'create'
    })
    expect(ref).toBe('knowledge:notes/idea.md')
    expect(readFileSync(join(KB, 'notes/idea.md'), 'utf8')).toBe('# Idea\n')
  })

  it('note (create) → refuses to overwrite an existing file', () => {
    applyProposal(db(), 'note', { path: 'a.md', content: 'one', mode: 'create' })
    expect(() =>
      applyProposal(db(), 'note', { path: 'a.md', content: 'two', mode: 'create' })
    ).toThrow(/already exists/)
  })

  it('note (append) → appends with a newline separator', () => {
    writeFileSync(join(KB, 'log.md'), 'first')
    applyProposal(db(), 'note', { path: 'log.md', content: 'second', mode: 'append' })
    expect(readFileSync(join(KB, 'log.md'), 'utf8')).toBe('first\nsecond')
  })

  it('note → blocks path traversal (safeJoin)', () => {
    expect(() => applyProposal(db(), 'note', { path: '../escape.md', content: 'x' })).toThrow()
    expect(existsSync(join(TMP_HOME, 'escape.md'))).toBe(false)
  })

  it('note → rejects Windows/UNC/absolute/backslash paths', () => {
    for (const path of ['C:\\notes\\x.md', '\\\\server\\share\\x.md', 'notes\\x.md', '/abs.md']) {
      expect(() => applyProposal(db(), 'note', { path, content: 'x' })).toThrow(/relative .md path/)
    }
  })

  it('txn_tag → sets a whitelisted tax tag + category on an existing txn', () => {
    sqlite.exec("INSERT INTO finance_transactions (id, category) VALUES (7, 'Uncategorized')")
    const ref = applyProposal(db(), 'txn_tag', {
      transactionId: 7,
      taxTag: 'tax:charitable',
      category: 'Donations'
    })
    expect(ref).toBe('txn:7')
    const row = db()
      .select({
        taxTag: schema.financeTransactions.taxTag,
        taxTagSource: schema.financeTransactions.taxTagSource,
        category: schema.financeTransactions.category
      })
      .from(schema.financeTransactions)
      .all()[0]
    expect(row.taxTag).toBe('tax:charitable')
    expect(row.taxTagSource).toBe('user')
    expect(row.category).toBe('Donations')
  })

  it('txn_tag → rejects an unknown tax tag', () => {
    sqlite.exec('INSERT INTO finance_transactions (id) VALUES (7)')
    expect(() =>
      applyProposal(db(), 'txn_tag', { transactionId: 7, taxTag: 'tax:made-up' })
    ).toThrow(/unknown tax tag/)
  })

  it('txn_tag → errors when the transaction does not exist', () => {
    expect(() => applyProposal(db(), 'txn_tag', { transactionId: 999, category: 'X' })).toThrow(
      /not found/
    )
  })

  it('habit_check → sets the explicit completed state (not a toggle)', () => {
    sqlite.exec("INSERT INTO habits (id, name) VALUES (1, 'Run')")
    // Pre-existing completed=true; a completed:false proposal must SET false.
    sqlite.exec("INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, '2026-05-23', 1)")
    applyProposal(db(), 'habit_check', { habitId: 1, date: '2026-05-23', completed: false })
    const row = db().select().from(schema.habitEntries).all()[0]
    expect(row.completed).toBe(false)
  })

  it('habit_check → inserts when no entry exists', () => {
    sqlite.exec("INSERT INTO habits (id, name) VALUES (1, 'Run')")
    const ref = applyProposal(db(), 'habit_check', {
      habitId: 1,
      date: '2026-05-23',
      completed: true
    })
    expect(ref).toBe('habit:1:2026-05-23')
    expect(db().select().from(schema.habitEntries).all()[0].completed).toBe(true)
  })

  it('habit_check → rejects a non-boolean completed and a missing habit', () => {
    sqlite.exec("INSERT INTO habits (id, name) VALUES (1, 'Run')")
    expect(() =>
      applyProposal(db(), 'habit_check', { habitId: 1, date: '2026-05-23', completed: 'false' })
    ).toThrow(/must be boolean/)
    expect(() =>
      applyProposal(db(), 'habit_check', { habitId: 42, date: '2026-05-23', completed: true })
    ).toThrow(/habit not found/)
  })

  it('habit_check → rejects an impossible date', () => {
    sqlite.exec("INSERT INTO habits (id, name) VALUES (1, 'Run')")
    expect(() =>
      applyProposal(db(), 'habit_check', { habitId: 1, date: '2026-02-30', completed: true })
    ).toThrow(/invalid date/)
  })
})

describe('claude:* handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerClaudeHandlers(fakeIpcMain as IpcMain)
  })

  function seed(type: string, payload: unknown): number {
    return db()
      .insert(schema.claudeProposals)
      .values({
        proposalId: crypto.randomUUID(),
        type,
        payload: JSON.stringify(payload),
        source: 'claude-mcp',
        status: 'pending',
        createdAt: new Date()
      })
      .returning()
      .get().id
  }

  it('approve applies the change and marks the row approved', async () => {
    const id = seed('task', { title: 'Ship 8.2', listType: 'daily', listDate: '2026-05-23' })
    const res = (await handlers['claude:approve-proposal']({}, id)) as {
      success: boolean
      resultRef?: string
    }
    expect(res.success).toBe(true)
    expect(res.resultRef).toMatch(/^checklist:\d+$/)
    const row = db().select().from(schema.claudeProposals).all()[0]
    expect(row.status).toBe('approved')
    expect(row.resultRef).toBe(res.resultRef)
    expect(db().select().from(schema.checklistItems).all()).toHaveLength(1)
  })

  it('approve records failure (status=failed) when apply throws, writing nothing', async () => {
    const id = seed('txn_tag', { transactionId: 123, taxTag: 'tax:none' }) // no such txn
    const res = (await handlers['claude:approve-proposal']({}, id)) as {
      success: boolean
      error?: string
    }
    expect(res.success).toBe(false)
    const row = db().select().from(schema.claudeProposals).all()[0]
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/not found/)
  })

  it('approve refuses a non-pending proposal', async () => {
    const id = seed('task', { title: 'x', listType: 'daily', listDate: '2026-05-23' })
    await handlers['claude:approve-proposal']({}, id)
    const res = (await handlers['claude:approve-proposal']({}, id)) as { success: boolean }
    expect(res.success).toBe(false)
  })

  it('reject marks pending → rejected and applies nothing', async () => {
    const id = seed('task', { title: 'x', listType: 'daily', listDate: '2026-05-23' })
    const res = (await handlers['claude:reject-proposal']({}, id)) as { success: boolean }
    expect(res.success).toBe(true)
    expect(db().select().from(schema.claudeProposals).all()[0].status).toBe('rejected')
    expect(db().select().from(schema.checklistItems).all()).toHaveLength(0)
  })

  it('clear soft-hides resolved rows from the inbox but keeps them in the table', async () => {
    const pending = seed('task', { title: 'keep', listType: 'daily', listDate: '2026-05-23' })
    const toReject = seed('task', { title: 'gone', listType: 'daily', listDate: '2026-05-23' })
    await handlers['claude:reject-proposal']({}, toReject)
    const res = (await handlers['claude:clear-resolved']({})) as { cleared: number }
    expect(res.cleared).toBe(1)
    // The inbox view shows only the pending one…
    const visible = listProposals(db())
    expect(visible).toHaveLength(1)
    expect(visible[0].id).toBe(pending)
    // …but the cleared row is RETAINED (with clearedAt set) for dedup.
    const all = db().select().from(schema.claudeProposals).all()
    expect(all).toHaveLength(2)
    const clearedRow = all.find((r) => r.id === toReject)
    expect(clearedRow?.clearedAt).not.toBeNull()
  })

  it('a resolved+cleared proposal is NOT resurrected by re-ingesting the JSONL (P1)', async () => {
    // Simulate the MCP having appended a proposal to the never-truncated inbox.
    const file = join(tmpdir(), `inbox-p1-${crypto.randomUUID()}.jsonl`)
    const line = makeLine({
      id: 'persist-1',
      payload: { title: 'once', listType: 'daily', listDate: '2026-05-23' }
    })
    writeFileSync(file, `${line}\n`)
    expect(ingestProposals(db(), file)).toBe(1)
    const row = db().select().from(schema.claudeProposals).all()[0]

    // Approve it, then clear resolved.
    await handlers['claude:approve-proposal']({}, row.id)
    await handlers['claude:clear-resolved']({})
    expect(db().select().from(schema.checklistItems).all()).toHaveLength(1)

    // Re-ingest the SAME (still-present) line — must NOT create a new pending row.
    expect(ingestProposals(db(), file)).toBe(0)
    expect(listProposals(db(), 'pending')).toHaveLength(0)
    expect(db().select().from(schema.claudeProposals).all()).toHaveLength(1)
    rmSync(file, { force: true })
  })
})
