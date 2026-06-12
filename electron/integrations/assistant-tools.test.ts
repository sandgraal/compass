/**
 * Tests for the embedded-agent tool layer (Phase 8.5).
 *
 * Real in-memory SQLite + drizzle (same pattern as habits/claude tests). We
 * exercise the read tools' shapes and — most importantly — that propose_task
 * ENQUEUES a pending claude_proposals row rather than mutating anything.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { ASSISTANT_TOOLS, executeAssistantTool } from './assistant-tools'

let sqlite: Database.Database
function db() {
  return drizzle(sqlite, { schema })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list_type TEXT NOT NULL, list_date TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, checked INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal', sort_order INTEGER DEFAULT 0, due_date TEXT,
      source TEXT DEFAULT 'manual', source_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, source_id TEXT, title TEXT,
      start_at INTEGER, end_at INTEGER, all_day INTEGER, location TEXT, description TEXT,
      url TEXT, created_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, is_debt INTEGER DEFAULT 0,
      asset_class TEXT, balance REAL, payment_due_date TEXT
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, amount REAL, category TEXT
    );
    CREATE TABLE claude_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      payload TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'claude-mcp', status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL, resolved_at INTEGER, error TEXT,
      result_ref TEXT, cleared_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT, color TEXT,
      active INTEGER DEFAULT 1, created_at INTEGER
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      category TEXT, last_modified INTEGER, word_count INTEGER DEFAULT 0, auto_updated INTEGER DEFAULT 0
    );
  `)
})

afterEach(() => sqlite.close())

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('ASSISTANT_TOOLS', () => {
  it('advertises read + propose tools with input schemas', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name)
    expect(names).toContain('get_upcoming')
    expect(names).toContain('get_finance_summary')
    expect(names).toContain('get_week_tasks')
    expect(names).toContain('get_weekly_goals')
    expect(names).toContain('get_habit_streaks')
    expect(names).toContain('get_insights')
    expect(names).toContain('propose_task')
    for (const t of ASSISTANT_TOOLS) expect(t.input_schema.type).toBe('object')
  })
})

describe('get_week_tasks', () => {
  function addTask(date: string, title: string, checked = 0): void {
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, checked, created_at) VALUES ('daily', ?, ?, ?, 0)"
      )
      .run(date, title, checked)
  }

  it('returns the range (default rolling week) with done state, date-ordered', () => {
    const now = new Date()
    const ymd = (offsetDays: number): string => {
      const d = new Date(now.getTime() + offsetDays * 86_400_000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    addTask(ymd(2), 'later this week')
    addTask(ymd(0), 'today done', 1)
    addTask(ymd(10), 'outside window')

    const res = executeAssistantTool(db(), sqlite, 'get_week_tasks', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tasks: Array<{ title: string; checked: number }> } })
      .data
    expect(data.tasks.map((t) => t.title)).toEqual(['today done', 'later this week'])
  })

  it('rejects bad dates, inverted ranges, and oversized ranges', () => {
    expect(executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: 'nope' }).ok).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: '2026-06-15', to: '2026-06-01' })
        .ok
    ).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: '2026-01-01', to: '2026-12-31' })
        .ok
    ).toBe(false)
  })
})

describe('get_weekly_goals', () => {
  it('reads the Monday-keyed goals for the week containing the date', () => {
    // 2026-06-17 is a Wednesday; its week key is Monday 2026-06-15.
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('weekly_goals_2026-06-15', JSON.stringify(['Ship feature', '', 'Run 3x']))

    const res = executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: '2026-06-17' })
    expect(res).toEqual({
      ok: true,
      data: { weekStart: '2026-06-15', goals: ['Ship feature', 'Run 3x'] }
    })
  })

  it('returns empty goals when none stored, and rejects bad dates', () => {
    const res = executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: '2026-06-17' })
    expect(res).toMatchObject({ ok: true, data: { goals: [] } })
    expect(executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: 'someday' }).ok).toBe(
      false
    )
  })
})

describe('get_habit_streaks', () => {
  it('computes current (today-or-yesterday anchored) and longest streaks for active habits', () => {
    sqlite.prepare("INSERT INTO habits (name, active) VALUES ('Meditate', 1)").run()
    sqlite.prepare("INSERT INTO habits (name, active) VALUES ('Retired', 0)").run()
    const ymd = (offsetDays: number): string => {
      const d = new Date(Date.now() + offsetDays * 86_400_000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // Yesterday + day before checked; today not yet → current streak 2.
    for (const off of [-1, -2]) {
      sqlite
        .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, ?, 1)')
        .run(ymd(off))
    }

    const res = executeAssistantTool(db(), sqlite, 'get_habit_streaks', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: Array<{ name: string; current: number }> }).data
    expect(data).toHaveLength(1) // inactive habit excluded
    expect(data[0]).toMatchObject({ name: 'Meditate', current: 2, longest: 2 })
  })
})

describe('get_insights', () => {
  it('surfaces the same detectors as the Dashboard card', () => {
    const m = today().slice(0, 7)
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-01`, -150, 'Uncategorized')

    const res = executeAssistantTool(db(), sqlite, 'get_insights', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: Array<{ kind: string }> }).data
    expect(data.some((i) => i.kind === 'uncategorized-spend')).toBe(true)
  })
})

describe('get_upcoming', () => {
  it("returns today's tasks + windowed events + payments due", () => {
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, created_at) VALUES ('daily', ?, 'Ship 8.5', 0)"
      )
      .run(today())
    const soon = Date.now() + 2 * 86_400_000
    sqlite
      .prepare('INSERT INTO calendar_events (title, start_at) VALUES (?, ?)')
      .run('Standup', soon)
    sqlite
      .prepare('INSERT INTO calendar_events (title, start_at) VALUES (?, ?)')
      .run('Far away', Date.now() + 60 * 86_400_000)
    const due = new Date(Date.now() + 3 * 86_400_000)
    const dueStr = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, balance, payment_due_date) VALUES ('Visa', -100, ?)"
      )
      .run(dueStr)

    const res = executeAssistantTool(db(), sqlite, 'get_upcoming', { days: 7 })
    expect(res.ok).toBe(true)
    const data = (
      res as {
        ok: true
        data: { tasks: unknown[]; events: Array<{ title: string }>; paymentsDue: unknown[] }
      }
    ).data
    expect(data.tasks).toHaveLength(1)
    expect(data.events.map((e) => e.title)).toEqual(['Standup']) // far-away event excluded
    expect(data.paymentsDue).toHaveLength(1)
  })
})

describe('get_finance_summary', () => {
  it('returns aggregates (net worth + monthly + by-category), never raw rows', () => {
    sqlite
      .prepare("INSERT INTO finance_accounts (name, balance, is_debt) VALUES ('Checking', 5000, 0)")
      .run()
    sqlite
      .prepare("INSERT INTO finance_accounts (name, balance, is_debt) VALUES ('Card', 1200, 1)")
      .run()
    const m = today().slice(0, 7)
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-05`, -80, 'Groceries')
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-06`, 3000, 'Income')

    const res = executeAssistantTool(db(), sqlite, 'get_finance_summary', { months: 6 })
    expect(res.ok).toBe(true)
    const data = (
      res as {
        ok: true
        data: {
          netWorth: { net: number }
          currentMonth: { byCategory: Array<{ category: string; spent: number }> }
        }
      }
    ).data
    expect(data.netWorth.net).toBe(3800) // 5000 assets − 1200 liability
    expect(data.currentMonth.byCategory.find((c) => c.category === 'Groceries')?.spent).toBe(80)
    // No raw-transaction field is exposed.
    expect(JSON.stringify(data)).not.toContain('Income') // income isn't a spend category row
  })
})

describe('propose_task', () => {
  it('enqueues a pending proposal (does NOT add a checklist item)', () => {
    const res = executeAssistantTool(db(), sqlite, 'propose_task', {
      title: 'Call dentist',
      listType: 'daily'
    })
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { proposalId: string } }).data
    expect(data.proposalId).toMatch(/^[0-9a-f-]{36}$/)

    const proposals = db().select().from(schema.claudeProposals).all()
    expect(proposals).toHaveLength(1)
    expect(proposals[0].status).toBe('pending')
    expect(proposals[0].source).toBe('ask-compass')
    expect(JSON.parse(proposals[0].payload).title).toBe('Call dentist')
    // It must NOT have written a real checklist item.
    expect(db().select().from(schema.checklistItems).all()).toHaveLength(0)
  })

  it('rejects an empty title, bad listType, and impossible date', () => {
    expect(executeAssistantTool(db(), sqlite, 'propose_task', {}).ok).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'propose_task', { title: 'x', listType: 'master' }).ok
    ).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'propose_task', { title: 'x', listDate: '2026-02-30' }).ok
    ).toBe(false)
    expect(db().select().from(schema.claudeProposals).all()).toHaveLength(0)
  })
})

describe('executeAssistantTool', () => {
  it('returns an error for an unknown tool', () => {
    const res = executeAssistantTool(db(), sqlite, 'nope', {})
    expect(res).toEqual({ ok: false, error: 'Unknown tool: nope' })
  })
})
