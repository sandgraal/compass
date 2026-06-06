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
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

function seed(
  listDate: string,
  title: string,
  opts: { checked?: boolean; source?: string; listType?: string } = {}
) {
  sqlite
    .prepare(
      'INSERT INTO checklist_items (list_type, list_date, title, checked, source, created_at) VALUES (?, ?, ?, ?, ?, 0)'
    )
    .run(opts.listType ?? 'daily', listDate, title, opts.checked ? 1 : 0, opts.source ?? 'manual')
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
})
