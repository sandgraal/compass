/**
 * Tests for the Morning Brief aggregator + handler (Phase 7 Track A).
 *
 * buildMorningBrief is exercised directly with a fixed `now` against a real
 * in-memory SQLite (so the local-day window, the 7-day payment cutoff, the
 * unchecked-task filter, and the done-inbox filter all run under true SQL +
 * real Date math). The `morning-brief:get` handler gets a registration +
 * empty-state smoke test.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { MorningBrief } from './morning-brief'

let sqlite: Database.Database

vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
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
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      updated_at INTEGER,
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      plaid_item_id INTEGER,
      plaid_account_id TEXT,
      mask TEXT
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
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers (local-time frame matches the fixed `now` passed to the builder) ──

let evtSeq = 0
function seedEvent(
  title: string,
  startLocal: Date,
  opts: { source?: string; allDay?: boolean } = {}
) {
  evtSeq++
  sqlite
    .prepare(
      'INSERT INTO calendar_events (source, external_id, title, start_at, all_day) VALUES (?, ?, ?, ?, ?)'
    )
    .run(opts.source ?? 'google', `evt-${evtSeq}`, title, startLocal.getTime(), opts.allDay ? 1 : 0)
}
function seedTask(
  title: string,
  listDate: string,
  opts: { checked?: boolean; sortOrder?: number } = {}
) {
  sqlite
    .prepare(
      "INSERT INTO checklist_items (list_type, list_date, title, checked, sort_order, created_at) VALUES ('daily', ?, ?, ?, ?, 0)"
    )
    .run(listDate, title, opts.checked ? 1 : 0, opts.sortOrder ?? 0)
}
function seedDebt(
  name: string,
  paymentDueDate: string | null,
  opts: { isDebt?: boolean; minPayment?: number } = {}
) {
  sqlite
    .prepare(
      "INSERT INTO finance_accounts (name, type, is_debt, min_payment, payment_due_date) VALUES (?, 'credit', ?, ?, ?)"
    )
    .run(name, opts.isDebt === false ? 0 : 1, opts.minPayment ?? 0, paymentDueDate)
}
let gmailSeq = 0
function seedGmail(subject: string, opts: { done?: boolean } = {}) {
  gmailSeq++
  sqlite
    .prepare(
      "INSERT INTO gmail_actions (thread_id, subject, from_address, done) VALUES (?, ?, 'sam@example.com', ?)"
    )
    .run(`thr-${gmailSeq}`, subject, opts.done ? 1 : 0)
}

async function buildAt(now: Date) {
  const { buildMorningBrief } = await import('./morning-brief')
  return buildMorningBrief(drizzle(sqlite, { schema }), now)
}

// Fixed reference: 2026-05-15 09:00 LOCAL → today '2026-05-15', "Good morning".
const NOW = new Date(2026, 4, 15, 9, 0, 0)

// ── aggregation ──────────────────────────────────────────────────────────────

describe('buildMorningBrief', () => {
  it('greets by time of day and stamps the local date', async () => {
    expect((await buildAt(new Date(2026, 4, 15, 9, 0, 0))).greeting).toBe('Good morning')
    expect((await buildAt(new Date(2026, 4, 15, 13, 0, 0))).greeting).toBe('Good afternoon')
    expect((await buildAt(new Date(2026, 4, 15, 20, 0, 0))).greeting).toBe('Good evening')
    expect((await buildAt(NOW)).date).toBe('2026-05-15')
  })

  it("includes only today's calendar events, time-sorted", async () => {
    seedEvent('Standup', new Date(2026, 4, 15, 10, 0, 0))
    seedEvent('Coffee', new Date(2026, 4, 15, 8, 0, 0))
    seedEvent('Yesterday', new Date(2026, 4, 14, 10, 0, 0)) // excluded
    seedEvent('Tomorrow', new Date(2026, 4, 16, 10, 0, 0)) // excluded
    const brief = await buildAt(NOW)
    expect(brief.calendar.count).toBe(2)
    expect(brief.calendar.events.map((e) => e.title)).toEqual(['Coffee', 'Standup'])
  })

  it("counts only today's unchecked daily tasks", async () => {
    seedTask('Write report', '2026-05-15', { sortOrder: 2 })
    seedTask('Reply to Sam', '2026-05-15', { sortOrder: 1 })
    seedTask('Done thing', '2026-05-15', { checked: true }) // excluded
    seedTask('Yesterday task', '2026-05-14') // excluded
    const brief = await buildAt(NOW)
    expect(brief.tasks.dueCount).toBe(2)
    expect(brief.tasks.items.map((t) => t.title)).toEqual(['Reply to Sam', 'Write report'])
  })

  it('lists debt payments due within 7 days, with daysRemaining + minPayment', async () => {
    seedDebt('Visa', '2026-05-18', { minPayment: 35 }) // 3 days out — in window
    seedDebt('Amex', '2026-05-15', { minPayment: 50 }) // due today — in window
    seedDebt('Mortgage', '2026-05-30') // out of window — excluded
    seedDebt('Checking', '2026-05-16', { isDebt: false }) // not a debt — excluded
    const brief = await buildAt(NOW)
    expect(brief.payments.count).toBe(2)
    expect(brief.payments.items.map((p) => p.name)).toEqual(['Amex', 'Visa']) // sorted by date
    expect(brief.payments.items[0]).toMatchObject({ daysRemaining: 0, minPayment: 50 })
    expect(brief.payments.items[1]).toMatchObject({ daysRemaining: 3, minPayment: 35 })
  })

  it('counts unresolved inbox items only', async () => {
    seedGmail('Invoice due')
    seedGmail('Project ping')
    seedGmail('Already handled', { done: true }) // excluded
    const brief = await buildAt(NOW)
    expect(brief.inbox.count).toBe(2)
    expect(brief.inbox.items.map((m) => m.subject)).toEqual(['Invoice due', 'Project ping'])
  })

  it('builds a human summary that omits zero finance/inbox sections', async () => {
    seedEvent('Standup', new Date(2026, 4, 15, 10, 0, 0))
    seedTask('One task', '2026-05-15')
    // no payments, no inbox
    const brief = await buildAt(NOW)
    expect(brief.summary).toBe('1 event today · 1 task due')
  })

  it('caps each section at 5 items but keeps the true counts', async () => {
    for (let i = 0; i < 8; i++) seedTask(`task ${i}`, '2026-05-15', { sortOrder: i })
    const brief = await buildAt(NOW)
    expect(brief.tasks.dueCount).toBe(8)
    expect(brief.tasks.items).toHaveLength(5)
  })
})

// ── handler ──────────────────────────────────────────────────────────────────

describe('morning-brief:get handler', () => {
  it('registers and returns the digest shape on an empty DB', async () => {
    const mod = await import('./morning-brief')
    mod.registerMorningBriefHandlers(fakeIpcMain as IpcMain)
    const h = handlers['morning-brief:get']
    expect(h).toBeDefined()
    const brief = (await Promise.resolve().then(() => h({}))) as MorningBrief
    expect(brief).toMatchObject({
      calendar: { count: 0, events: [] },
      tasks: { dueCount: 0, items: [] },
      payments: { count: 0, items: [] },
      inbox: { count: 0, items: [] }
    })
    expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(brief.greeting)
    expect(brief.summary).toBe('0 events today · 0 tasks due')
  })
})
