/**
 * Tests for the weekly review aggregator + carry-over (Phase 7 Track A).
 *
 * buildWeeklyReview runs against a real in-memory SQLite (true SQL for the
 * 7-day window, per-day grouping, and the unchecked+manual carry-over
 * predicate). The handlers cover input validation + the carry-over write
 * (copy forward, skip titles already present, default-to-today).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { localYmd } from '../lib/dates'

let sqlite: Database.Database

vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))

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
  const mod = await import('./weekly-review')
  mod.registerWeeklyReviewHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}
async function build(weekStart: string) {
  const { buildWeeklyReview } = await import('./weekly-review')
  return buildWeeklyReview(drizzle(sqlite, { schema }), weekStart)
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT DEFAULT 'USD', description TEXT NOT NULL DEFAULT '', category TEXT
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER DEFAULT 1,
      icon TEXT, color TEXT, created_at INTEGER, auto_link_source TEXT, auto_link_threshold REAL
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, date TEXT NOT NULL, completed INTEGER DEFAULT 0, source TEXT
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
})

let recN = 0
function seedRecord(
  source: string,
  type: string,
  ymd: string,
  opts: { title?: string; payload?: unknown } = {}
): void {
  recN++
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(
      source,
      type,
      new Date(`${ymd}T12:00:00`).getTime(),
      opts.title ?? `${source} ${type}`,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      `wr-rec-${recN}`
    )
}
let txnN = 0
function seedTxn(date: string, amount: number, category: string): void {
  txnN++
  sqlite
    .prepare('INSERT INTO finance_transactions (hash, date, amount, category) VALUES (?,?,?,?)')
    .run(`wr-${date}-${amount}-${category}-${txnN}`, date, amount, category)
}

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

function seed(
  listDate: string,
  title: string,
  opts: {
    checked?: boolean
    source?: string
    listType?: string
    body?: string | null
    sortOrder?: number
  } = {}
) {
  sqlite
    .prepare(
      'INSERT INTO checklist_items (list_type, list_date, title, checked, source, body, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    )
    .run(
      opts.listType ?? 'daily',
      listDate,
      title,
      opts.checked ? 1 : 0,
      opts.source ?? 'manual',
      opts.body ?? null,
      opts.sortOrder ?? 0
    )
}

// Reference week: 2026-05-11 .. 2026-05-17 (the aggregator is day-of-week
// agnostic — it just takes the given start as day 1 and spans 7 days).
const WEEK = '2026-05-11'

function seedReferenceWeek() {
  seed('2026-05-11', 'A', { checked: false }) // unchecked manual → carry-over
  seed('2026-05-11', 'C', { checked: true }) // done
  seed('2026-05-13', 'B', { checked: false }) // unchecked manual → carry-over
  seed('2026-05-14', 'D', { checked: false, source: 'github' }) // unchecked but synced → not carried
  seed('2026-05-17', 'E', { checked: true }) // done
  seed('2026-05-10', 'prev-out', { checked: false }) // prior week — excluded from this week
  seed('2026-05-18', 'next-out', { checked: false }) // next week — excluded
}

// ── buildWeeklyReview ────────────────────────────────────────────────────────

describe('buildWeeklyReview', () => {
  it('computes completion over the 7-day window (excludes other weeks)', async () => {
    seedReferenceWeek()
    const r = await build(WEEK)
    expect(r.weekStart).toBe('2026-05-11')
    expect(r.weekEnd).toBe('2026-05-17')
    expect(r.totalTasks).toBe(5) // A,C,B,D,E (prev/next excluded)
    expect(r.completedTasks).toBe(2) // C,E
    expect(r.completionPct).toBe(40)
  })

  it('returns a Mon..Sun per-day breakdown', async () => {
    seedReferenceWeek()
    const r = await build(WEEK)
    expect(r.perDay.map((d) => d.date)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16',
      '2026-05-17'
    ])
    expect(r.perDay[0]).toEqual({ date: '2026-05-11', total: 2, done: 1 })
    expect(r.perDay[2]).toEqual({ date: '2026-05-13', total: 1, done: 0 })
    expect(r.perDay[6]).toEqual({ date: '2026-05-17', total: 1, done: 1 })
  })

  it('lists only unchecked + manual carry-over candidates', async () => {
    seedReferenceWeek()
    const r = await build(WEEK)
    expect(r.carryOver.count).toBe(2)
    expect(r.carryOver.items.map((i) => i.title).sort()).toEqual(['A', 'B'])
  })

  it('reports the week-over-week delta against the prior 7 days', async () => {
    seedReferenceWeek()
    // Prior week 2026-05-04..05-10 already has 'prev-out' (05-10, unchecked)
    // from the reference seed; add p1 (done) + p2 (open) → 1 of 3 done = 33%.
    seed('2026-05-04', 'p1', { checked: true })
    seed('2026-05-06', 'p2', { checked: false })
    const r = await build(WEEK)
    expect(r.prevCompletionPct).toBe(33)
    expect(r.deltaPct).toBe(7) // 40 - 33
  })

  it('null prev/delta when there is no prior-week data', async () => {
    seedReferenceWeek()
    sqlite.prepare("DELETE FROM checklist_items WHERE list_date = '2026-05-10'").run()
    const r = await build(WEEK)
    expect(r.prevCompletionPct).toBeNull()
    expect(r.deltaPct).toBeNull()
  })

  it('handles an empty week (0%, no carry-over)', async () => {
    const r = await build(WEEK)
    expect(r.totalTasks).toBe(0)
    expect(r.completionPct).toBe(0)
    expect(r.carryOver.count).toBe(0)
  })

  it('leaves the cross-domain sections empty/null when no data', async () => {
    const r = await build(WEEK)
    expect(r.crossDomain).toEqual({ spend: null, habits: [], health: null, highlights: [] })
  })
})

// ── cross-domain sections (spend / habits / health / highlights) ─────────────

describe('buildWeeklyReview — cross-domain', () => {
  it('summarizes spend (with prior-week delta + top categories) for the week', async () => {
    // This week (2026-05-11..17).
    seedTxn('2026-05-12', -80, 'Dining')
    seedTxn('2026-05-14', -40, 'Dining')
    seedTxn('2026-05-15', -30, 'Groceries')
    seedTxn('2026-05-13', -1000, 'Transfers') // excluded
    seedTxn('2026-05-13', 5000, 'Salary') // income (positive) excluded
    // Prior week (2026-05-04..10).
    seedTxn('2026-05-06', -50, 'Dining')

    const r = await build(WEEK)
    expect(r.crossDomain.spend?.total).toBe(150) // 80+40+30, transfer + income excluded
    expect(r.crossDomain.spend?.prevTotal).toBe(50)
    expect(r.crossDomain.spend?.topCategories[0]).toEqual({ category: 'Dining', amount: 120 })
  })

  it('counts active-habit completions in the week', async () => {
    sqlite.prepare("INSERT INTO habits (id, name, active) VALUES (1, 'Meditate', 1)").run()
    sqlite.prepare("INSERT INTO habits (id, name, active) VALUES (2, 'Retired', 0)").run()
    for (const d of ['2026-05-11', '2026-05-12', '2026-05-13']) {
      sqlite
        .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, ?, 1)')
        .run(d)
    }
    sqlite
      .prepare("INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, '2026-05-04', 1)")
      .run() // prior week
    const r = await build(WEEK)
    expect(r.crossDomain.habits).toEqual([{ name: 'Meditate', done: 3 }])
  })

  it('sums health metrics from apple-health records vs the prior week', async () => {
    seedRecord('apple-health', 'steps', '2026-05-12', { payload: { value: 8000 } })
    seedRecord('apple-health', 'steps', '2026-05-13', { payload: { value: 6000 } })
    seedRecord('apple-health', 'sleep', '2026-05-12', { payload: { ms: 7 * 3_600_000 } })
    seedRecord('apple-health', 'steps', '2026-05-05', { payload: { value: 5000 } }) // prior week
    const r = await build(WEEK)
    expect(r.crossDomain.health?.steps).toBe(14000)
    expect(r.crossDomain.health?.prevSteps).toBe(5000)
    expect(r.crossDomain.health?.sleepHours).toBe(7)
  })

  it('ranks the week’s biggest timeline events as highlights', async () => {
    seedRecord('linkedin', 'job', '2026-05-12', { title: 'Started at Initech' })
    for (let i = 0; i < 8; i++) {
      seedRecord('spotify', 'listen', '2026-05-13', { title: `Track ${i}` })
    }
    const r = await build(WEEK)
    expect(r.crossDomain.highlights.length).toBeGreaterThan(0)
    expect(r.crossDomain.highlights.length).toBeLessThanOrEqual(5)
    // The career event outranks shuffle-play listens.
    expect(r.crossDomain.highlights[0].title).toBe('Started at Initech')
  })
})

// ── weekly-review:get handler ────────────────────────────────────────────────

describe('weekly-review:get handler', () => {
  it('returns the review for a valid weekStart', async () => {
    seedReferenceWeek()
    const h = await registerAndGet('weekly-review:get')
    const r = (await invoke(h, WEEK)) as { completionPct: number; carryOver: { count: number } }
    expect(r.completionPct).toBe(40)
    expect(r.carryOver.count).toBe(2)
  })

  it('throws on a malformed weekStart', async () => {
    const h = await registerAndGet('weekly-review:get')
    await expect(invoke(h, 'not-a-date')).rejects.toThrow(/YYYY-MM-DD/)
    await expect(invoke(h, '2026-13-40')).rejects.toThrow(/YYYY-MM-DD/)
  })
})

// ── weekly-review:carry-over handler ─────────────────────────────────────────

describe('weekly-review:carry-over handler', () => {
  it('copies unfinished manual tasks to the target day (synced/done excluded)', async () => {
    seedReferenceWeek()
    const h = await registerAndGet('weekly-review:carry-over')
    const res = (await invoke(h, WEEK, '2026-05-20')) as { success: boolean; carried: number }
    expect(res).toEqual({ success: true, carried: 2 })
    const moved = sqlite
      .prepare("SELECT title FROM checklist_items WHERE list_date = '2026-05-20' ORDER BY title")
      .all() as Array<{ title: string }>
    expect(moved.map((m) => m.title)).toEqual(['A', 'B'])
  })

  it('preserves body + sortOrder when carrying a task forward', async () => {
    seed('2026-05-12', 'Detailed task', { body: 'sub-steps here', sortOrder: 7 })
    const h = await registerAndGet('weekly-review:carry-over')
    await invoke(h, WEEK, '2026-05-20')
    const row = sqlite
      .prepare(
        "SELECT body, sort_order FROM checklist_items WHERE list_date = '2026-05-20' AND title = 'Detailed task'"
      )
      .get() as { body: string; sort_order: number }
    expect(row).toEqual({ body: 'sub-steps here', sort_order: 7 })
  })

  it('is idempotent — skips titles already present on the target day', async () => {
    seedReferenceWeek()
    const h = await registerAndGet('weekly-review:carry-over')
    expect((await invoke(h, WEEK, '2026-05-20')) as { carried: number }).toMatchObject({
      carried: 2
    })
    expect((await invoke(h, WEEK, '2026-05-20')) as { carried: number }).toMatchObject({
      carried: 0
    })
    const count = sqlite
      .prepare("SELECT COUNT(*) c FROM checklist_items WHERE list_date = '2026-05-20'")
      .get() as { c: number }
    expect(count.c).toBe(2) // no duplicates
  })

  it('defaults the target to today when no toDate is given', async () => {
    seedReferenceWeek()
    const h = await registerAndGet('weekly-review:carry-over')
    const res = (await invoke(h, WEEK)) as { success: boolean; carried: number }
    expect(res.carried).toBe(2)
    const today = localYmd()
    const count = sqlite
      .prepare('SELECT COUNT(*) c FROM checklist_items WHERE list_date = ?')
      .get(today) as { c: number }
    expect(count.c).toBe(2)
  })

  it('rejects a malformed weekStart', async () => {
    const h = await registerAndGet('weekly-review:carry-over')
    expect(await invoke(h, 'garbage', '2026-05-20')).toMatchObject({ success: false })
  })

  it('rejects an explicitly-provided invalid toDate (no silent fallback to today)', async () => {
    seedReferenceWeek()
    const h = await registerAndGet('weekly-review:carry-over')
    const res = (await invoke(h, WEEK, 'not-a-date')) as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/toDate/i)
    // Nothing was carried anywhere.
    const total = sqlite
      .prepare(
        "SELECT COUNT(*) c FROM checklist_items WHERE list_date NOT BETWEEN '2026-05-04' AND '2026-05-18'"
      )
      .get() as { c: number }
    expect(total.c).toBe(0)
  })
})
