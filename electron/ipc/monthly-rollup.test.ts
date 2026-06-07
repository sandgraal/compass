/**
 * Tests for the monthly rollup aggregator (Phase 7 Track A).
 *
 * buildMonthlyRollup runs against a real in-memory SQLite: true SQL for the
 * calendar-month window (month totals), the prior-month delta, and the
 * per-week breakdown (which reuses buildWeeklyReview). The handler covers
 * input validation.
 *
 * Reference month: May 2026 (2026-05-01 is a Friday, so the overlapping ISO
 * weeks start 04-27, 05-04, 05-11, 05-18, 05-25 → five weeks).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

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
  const mod = await import('./monthly-rollup')
  mod.registerMonthlyRollupHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}
async function build(month: string) {
  const { buildMonthlyRollup } = await import('./monthly-rollup')
  return buildMonthlyRollup(drizzle(sqlite, { schema }), month)
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

const MONTH = '2026-05'

function seedReferenceMonth() {
  // May 2026 — 5 tasks, 3 done → 60%
  seed('2026-05-05', 'm1', { checked: true }) // week 05-04
  seed('2026-05-06', 'm2', { checked: false }) // week 05-04
  seed('2026-05-12', 'm3', { checked: true }) // week 05-11
  seed('2026-05-20', 'm4', { checked: true }) // week 05-18
  seed('2026-05-31', 'm5', { checked: false }) // week 05-25
  // April 2026 — prior month, 2 tasks, 1 done → 50% (for the delta)
  seed('2026-04-10', 'p1', { checked: true })
  seed('2026-04-11', 'p2', { checked: false })
  // June — must be excluded from May totals and from every May week
  seed('2026-06-01', 'jun', { checked: true })
}

// ── buildMonthlyRollup ───────────────────────────────────────────────────────

describe('buildMonthlyRollup', () => {
  it('computes month totals over the calendar month (excludes other months)', async () => {
    seedReferenceMonth()
    const r = await build(MONTH)
    expect(r.month).toBe('2026-05')
    expect(r.monthStart).toBe('2026-05-01')
    expect(r.monthEnd).toBe('2026-05-31')
    expect(r.totalTasks).toBe(5) // m1..m5 (April + June excluded)
    expect(r.completedTasks).toBe(3) // m1, m3, m4
    expect(r.completionPct).toBe(60)
  })

  it('computes the month-over-month delta vs the previous calendar month', async () => {
    seedReferenceMonth()
    const r = await build(MONTH)
    expect(r.prevCompletionPct).toBe(50) // April: 1/2
    expect(r.deltaPct).toBe(10) // 60 - 50
  })

  it('breaks the month into the overlapping ISO weeks (Mon..Sun)', async () => {
    seedReferenceMonth()
    const r = await build(MONTH)
    expect(r.weeks.map((w) => w.weekStart)).toEqual([
      '2026-04-27',
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
      '2026-05-25'
    ])
    const byStart = Object.fromEntries(r.weeks.map((w) => [w.weekStart, w]))
    expect(byStart['2026-04-27']).toMatchObject({
      totalTasks: 0,
      completedTasks: 0,
      completionPct: 0
    })
    expect(byStart['2026-05-04']).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      completionPct: 50
    })
    expect(byStart['2026-05-11']).toMatchObject({
      totalTasks: 1,
      completedTasks: 1,
      completionPct: 100
    })
    expect(byStart['2026-05-18']).toMatchObject({
      totalTasks: 1,
      completedTasks: 1,
      completionPct: 100
    })
    expect(byStart['2026-05-25']).toMatchObject({
      totalTasks: 1,
      completedTasks: 0,
      completionPct: 0
    })
  })

  it('reports the best week among weeks that had tasks', async () => {
    seedReferenceMonth()
    const r = await build(MONTH)
    // Two weeks tie at 100%; the earlier one wins (reduce keeps the first max).
    expect(r.bestWeek).toEqual({ weekStart: '2026-05-11', completionPct: 100 })
  })

  it('handles an empty month: 0%, null delta, null best week', async () => {
    const r = await build(MONTH)
    expect(r.totalTasks).toBe(0)
    expect(r.completedTasks).toBe(0)
    expect(r.completionPct).toBe(0)
    expect(r.prevCompletionPct).toBeNull()
    expect(r.deltaPct).toBeNull()
    expect(r.bestWeek).toBeNull()
    expect(r.weeks.length).toBeGreaterThan(0) // weeks still enumerated, just empty
  })

  it('crosses the year boundary for January (prev month = prior December)', async () => {
    seed('2026-01-15', 'jan', { checked: true })
    seed('2025-12-20', 'dec', { checked: false })
    const r = await build('2026-01')
    expect(r.monthStart).toBe('2026-01-01')
    expect(r.monthEnd).toBe('2026-01-31')
    expect(r.completionPct).toBe(100) // 1/1 in January
    expect(r.prevCompletionPct).toBe(0) // December: 0/1
    expect(r.deltaPct).toBe(100)
  })

  it('computes the correct month end for years 0–99 (no 1900 mapping)', async () => {
    // `new Date(99, 12, 0)` would yield a 1999 date; ISO-string parsing keeps year 99.
    const r = await build('0099-12')
    expect(r.monthStart).toBe('0099-12-01')
    expect(r.monthEnd).toBe('0099-12-31')
  })

  it('ignores non-daily list items', async () => {
    seed('2026-05-10', 'tmpl', { checked: false, listType: 'template' })
    seed('2026-05-10', 'real', { checked: true })
    const r = await build(MONTH)
    expect(r.totalTasks).toBe(1) // only the daily item
    expect(r.completedTasks).toBe(1)
  })
})

// ── monthly-rollup:get handler ───────────────────────────────────────────────

describe('monthly-rollup:get', () => {
  it('returns the rollup for a valid YYYY-MM month', async () => {
    seedReferenceMonth()
    const h = await registerAndGet('monthly-rollup:get')
    const r = (await invoke(h, '2026-05')) as { completionPct: number }
    expect(r.completionPct).toBe(60)
  })

  it('throws on a missing / non-string month', async () => {
    const h = await registerAndGet('monthly-rollup:get')
    await expect(invoke(h, undefined)).rejects.toThrow(/YYYY-MM/)
    await expect(invoke(h, 12345)).rejects.toThrow(/YYYY-MM/)
  })

  it('throws on a malformed month string', async () => {
    const h = await registerAndGet('monthly-rollup:get')
    await expect(invoke(h, '2026-5')).rejects.toThrow(/YYYY-MM/) // not zero-padded
    await expect(invoke(h, '2026-13')).rejects.toThrow(/YYYY-MM/) // month out of range
    await expect(invoke(h, '2026-05-01')).rejects.toThrow(/YYYY-MM/) // a full date, not a month
  })
})
