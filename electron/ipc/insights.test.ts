/**
 * Tests for the proactive-insights aggregator (Phase 7 Track E). Real
 * in-memory SQLite; the clock is pinned so month/window math is
 * deterministic. Each detector gets a flagged case, a below-threshold case,
 * and its exclusion rules.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

const db = () => drizzle(sqlite, { schema })

// Pinned mid-month so the current month has meaningful data.
const NOW = new Date('2026-06-15T12:00:00')

function addTxn(date: string, amount: number, category: string): void {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?, ?, ?, ?, ?)'
    )
    .run(`${date}-${amount}-${category}-${Math.random()}`, date, amount, 'test txn', category)
}

function addHabit(name: string, active = 1): number {
  const r = sqlite.prepare('INSERT INTO habits (name, active) VALUES (?, ?)').run(name, active)
  return Number(r.lastInsertRowid)
}

function addEntry(habitId: number, date: string, completed = 1): void {
  sqlite
    .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (?, ?, ?)')
    .run(habitId, date, completed)
}

function addNote(path: string, title: string, lastModified: Date, autoUpdated = 0): void {
  sqlite
    .prepare(
      'INSERT INTO knowledge_files (path, title, last_modified, auto_updated) VALUES (?, ?, ?, ?)'
    )
    .run(path, title, lastModified.getTime(), autoUpdated)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
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
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT DEFAULT '#6272f1',
      active INTEGER DEFAULT 1,
      created_at INTEGER
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
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
})

afterEach(() => {
  sqlite.close()
})

describe('buildInsights — empty DB', () => {
  it('returns no insights', async () => {
    const { buildInsights } = await import('./insights')
    const r = buildInsights(db(), NOW)
    expect(r.insights).toEqual([])
    expect(r.generatedAt).toBe(NOW.toISOString())
  })
})

describe('spending anomalies', () => {
  it('flags a category well above its 3-month average', async () => {
    const { buildInsights } = await import('./insights')
    // Baseline: $100/mo Dining for Mar–May. Current month: $300.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Dining')
    addTxn('2026-06-05', -180, 'Dining')
    addTxn('2026-06-10', -120, 'Dining')

    const r = buildInsights(db(), NOW)
    const anomaly = r.insights.find((i) => i.kind === 'spending-anomaly')
    expect(anomaly).toBeDefined()
    expect(anomaly?.title).toContain('Dining')
    expect(anomaly?.title).toContain('200%') // 300 vs 100 avg
    expect(anomaly?.severity).toBe('warn')
  })

  it('does not flag below the ratio or delta floors, and ignores Transfers + income', async () => {
    const { buildInsights } = await import('./insights')
    // 40% over: below the 1.5x ratio.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Groceries')
    addTxn('2026-06-05', -140, 'Groceries')
    // Tiny category: ratio met but < $50 delta.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -10, 'Coffee')
    addTxn('2026-06-05', -40, 'Coffee')
    // Transfers always excluded; income (positive) never counts as spend.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Transfers')
    addTxn('2026-06-05', -900, 'Transfers')
    addTxn('2026-06-05', 5000, 'Income')

    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'spending-anomaly')).toEqual([])
  })

  it('caps anomalies at 3, ordered by dollar delta', async () => {
    const { buildInsights } = await import('./insights')
    const cats = ['A', 'B', 'C', 'D']
    cats.forEach((cat, i) => {
      for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, cat)
      addTxn('2026-06-05', -(300 + i * 100), cat) // D has the largest delta
    })
    const r = buildInsights(db(), NOW)
    const anomalies = r.insights.filter((i) => i.kind === 'spending-anomaly')
    expect(anomalies).toHaveLength(3)
    expect(anomalies[0].title).toContain('D')
  })
})

describe('uncategorized spend', () => {
  it('flags when count or total crosses the floor, within the window', async () => {
    const { buildInsights } = await import('./insights')
    addTxn('2026-06-01', -150, 'Uncategorized') // total ≥ $100 triggers alone
    addTxn('2026-01-01', -900, 'Uncategorized') // outside the 60-day window
    const r = buildInsights(db(), NOW)
    const insight = r.insights.find((i) => i.kind === 'uncategorized-spend')
    expect(insight?.title).toContain('$150')
    expect(insight?.detail).toContain('1 transaction')
  })

  it('treats legacy NULL categories as uncategorized', async () => {
    const { buildInsights } = await import('./insights')
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?, ?, ?, ?, NULL)'
      )
      .run('null-cat', '2026-06-01', -150, 'legacy row')
    const r = buildInsights(db(), NOW)
    expect(r.insights.find((i) => i.kind === 'uncategorized-spend')?.title).toContain('$150')
  })

  it('stays quiet below both floors', async () => {
    const { buildInsights } = await import('./insights')
    addTxn('2026-06-01', -20, 'Uncategorized')
    addTxn('2026-06-02', -30, 'Uncategorized')
    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'uncategorized-spend')).toEqual([])
  })
})

describe('habit slippage', () => {
  it('flags a previously consistent habit with ≤1 check-in this week', async () => {
    const { buildInsights } = await import('./insights')
    const id = addHabit('Meditation')
    // Prior three weeks (May 19 – Jun 8): 18 completions — well over the 50% floor.
    for (let d = 19; d <= 31; d++) addEntry(id, `2026-05-${d}`)
    for (let d = 1; d <= 5; d++) addEntry(id, `2026-06-0${d}`)
    // This week (Jun 9–15): one lone check-in.
    addEntry(id, '2026-06-12')

    const r = buildInsights(db(), NOW)
    const slip = r.insights.find((i) => i.kind === 'habit-slippage')
    expect(slip?.title).toBe('Meditation is slipping')
    expect(slip?.detail).toContain('1 check-in this week')
  })

  it('ignores habits still on track, inactive habits, and sparse habits', async () => {
    const { buildInsights } = await import('./insights')
    // On track: checked nearly every day including this week.
    const onTrack = addHabit('Reading')
    for (let d = 1; d <= 15; d++) addEntry(onTrack, `2026-06-${String(d).padStart(2, '0')}`)
    // Inactive habit with slippage pattern — excluded.
    const inactive = addHabit('Old habit', 0)
    for (let d = 19; d <= 31; d++) addEntry(inactive, `2026-05-${d}`)
    // Sparse habit (never consistent) — prior rate below floor.
    const sparse = addHabit('Stretching')
    addEntry(sparse, '2026-05-20')
    addEntry(sparse, '2026-05-28')

    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'habit-slippage')).toEqual([])
  })
})

describe('stale notes', () => {
  it('flags old user-authored notes, oldest first, excluding auto-updated + mirrors', async () => {
    const { buildInsights } = await import('./insights')
    addNote('profile/goals.md', 'Goals', new Date('2025-12-01'))
    addNote('work/old-plan.md', 'Old Plan', new Date('2026-01-15'))
    addNote('calendar/upcoming.md', 'Upcoming', new Date('2025-11-01'), 1) // auto-updated
    addNote('notion/imported.md', 'Imported', new Date('2025-11-01')) // mirror namespace
    addNote('obsidian/vault-note.md', 'Vault Note', new Date('2025-11-01')) // mirror namespace
    addNote('profile/fresh.md', 'Fresh', new Date('2026-06-01')) // recent

    const r = buildInsights(db(), NOW)
    const stale = r.insights.find((i) => i.kind === 'stale-notes')
    expect(stale?.title).toContain('2 notes')
    expect(stale?.detail).toContain('Goals')
    expect(stale?.detail).not.toContain('Imported')
    expect(stale?.detail).not.toContain('Upcoming')
  })
})

describe('ordering + IPC registration', () => {
  it('sorts warnings before infos and registers insights:get', async () => {
    const mod = await import('./insights')
    // One info (stale note) + one warn (anomaly).
    addNote('profile/goals.md', 'Goals', new Date('2025-12-01'))
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Dining')
    addTxn('2026-06-05', -300, 'Dining')

    const r = mod.buildInsights(db(), NOW)
    expect(r.insights.map((i) => i.severity)).toEqual(['warn', 'info'])

    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    mod.registerInsightsHandlers({
      handle: (channel: string, h: (...args: unknown[]) => unknown) => {
        handlers[channel] = h
      }
    } as unknown as IpcMain)
    const viaIpc = (await handlers['insights:get']({})) as { insights: unknown[] }
    expect(viaIpc.insights.length).toBeGreaterThan(0)
  })
})
