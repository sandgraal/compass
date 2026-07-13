/**
 * Tests for the insight lifecycle (insight_log memory: first-seen / dismissed /
 * pinned / new-since-last-visit) and the series-anomaly detector it folds in.
 * Real in-memory SQLite, pinned clock.
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

const NOW = new Date('2026-06-15T12:00:00')
const LATER = new Date('2026-06-15T13:00:00')

beforeEach(() => {
  sqlite = new Database(':memory:')
  // The base tables buildInsights reads unguarded, plus the lifecycle tables.
  sqlite.exec(`
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'Uncategorized'
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT,
      color TEXT DEFAULT '#6272f1', active INTEGER DEFAULT 1, created_at INTEGER,
      auto_link_source TEXT, auto_link_threshold REAL
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, date TEXT NOT NULL,
      completed INTEGER DEFAULT 0, source TEXT
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      category TEXT, last_modified INTEGER, word_count INTEGER DEFAULT 0, auto_updated INTEGER DEFAULT 0
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE insight_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      route TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      dismissed_at INTEGER,
      pinned INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER
    );
  `)
})

afterEach(() => {
  sqlite.close()
})

/** Seed enough uncategorized txns to fire the 'uncategorized-spend' nudge. */
function seedUncategorized(): void {
  for (let i = 0; i < 6; i++) {
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?,?,?,?,?)'
      )
      .run(`u-${i}`, '2026-06-10', -50, 'txn', 'Uncategorized')
  }
}

/** Seed a Dining anomaly (second distinct insight) — baseline + current spike. */
function seedDiningAnomaly(): void {
  let i = 0
  for (const m of ['2026-03', '2026-04', '2026-05']) {
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?,?,?,?,?)'
      )
      .run(`d-${i++}`, `${m}-10`, -100, 'txn', 'Dining')
  }
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?,?,?,?,?)'
    )
    .run('d-spike', '2026-06-05', -300, 'txn', 'Dining')
}

describe('insightKey', () => {
  it('is stable across runs whose numbers differ, distinct across subjects', async () => {
    const { insightKey } = await import('./insights-lifecycle')
    const a1 = insightKey({
      kind: 'spending-anomaly',
      title: 'Dining spending is up 34% this month'
    })
    const a2 = insightKey({
      kind: 'spending-anomaly',
      title: 'Dining spending is up 62% this month'
    })
    const b = insightKey({
      kind: 'spending-anomaly',
      title: 'Travel spending is up 34% this month'
    })
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })
})

describe('listInsights lifecycle', () => {
  it('logs first-seen, and flags only later arrivals as new', async () => {
    const { listInsights } = await import('./insights-lifecycle')
    seedUncategorized()
    const first = listInsights(db(), NOW)
    expect(first.insights).toHaveLength(1)
    // First-ever visit: nothing can be "new since last visit".
    expect(first.insights[0].isNew).toBe(false)

    // A second insight appears between visits → flagged new; the old one isn't.
    seedDiningAnomaly()
    const second = listInsights(db(), LATER)
    const uncategorized = second.insights.find((i) => i.kind === 'uncategorized-spend')
    const anomaly = second.insights.find((i) => i.kind === 'spending-anomaly')
    expect(uncategorized?.isNew).toBe(false)
    expect(anomaly?.isNew).toBe(true)
    expect((uncategorized?.firstSeen ?? 0) < (anomaly?.firstSeen ?? 0)).toBe(true)
  })

  it('dismiss hides an insight from the active list until restored', async () => {
    const { listInsights, setDismissed } = await import('./insights-lifecycle')
    seedUncategorized()
    const first = listInsights(db(), NOW)
    const key = first.insights[0].key

    setDismissed(db(), key, true, NOW)
    const afterDismiss = listInsights(db(), LATER)
    expect(afterDismiss.insights).toHaveLength(0)
    expect(afterDismiss.dismissed).toHaveLength(1)
    expect(afterDismiss.dismissed[0].key).toBe(key)

    setDismissed(db(), key, false, LATER)
    const afterRestore = listInsights(db(), LATER)
    expect(afterRestore.insights).toHaveLength(1)
    expect(afterRestore.dismissed).toHaveLength(0)
  })

  it('pinned insights sort first, ahead of warnings', async () => {
    const { listInsights, setPinned } = await import('./insights-lifecycle')
    seedUncategorized() // info
    seedDiningAnomaly() // warn — normally sorts first
    const first = listInsights(db(), NOW)
    expect(first.insights[0].kind).toBe('spending-anomaly')

    const infoKey = first.insights.find((i) => i.kind === 'uncategorized-spend')?.key as string
    setPinned(db(), infoKey, true)
    const second = listInsights(db(), LATER)
    expect(second.insights[0].kind).toBe('uncategorized-spend')
    expect(second.insights[0].pinned).toBe(true)
  })

  it('degrades to a plain list when insight_log predates the migration', async () => {
    const { listInsights } = await import('./insights-lifecycle')
    sqlite.exec('DROP TABLE insight_log;')
    seedUncategorized()
    const r = listInsights(db(), NOW)
    expect(r.insights).toHaveLength(1)
    expect(r.insights[0].pinned).toBe(false)
    expect(r.insights[0].isNew).toBe(false)
  })

  it('registers insights:list / :dismiss / :pin and validates keys', async () => {
    const { registerInsightLifecycleHandlers } = await import('./insights-lifecycle')
    seedUncategorized()
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    registerInsightLifecycleHandlers({
      handle: (channel: string, h: (...args: unknown[]) => unknown) => {
        handlers[channel] = h
      }
    } as unknown as IpcMain)
    const listed = (await handlers['insights:list']({})) as { insights: Array<{ key: string }> }
    expect(listed.insights.length).toBeGreaterThan(0)
    expect(await handlers['insights:dismiss']({}, '', true)).toEqual({ success: false })
    expect(await handlers['insights:dismiss']({}, 42, true)).toEqual({ success: false })
    expect(await handlers['insights:dismiss']({}, listed.insights[0].key, true)).toEqual({
      success: true
    })
    expect(await handlers['insights:pin']({}, listed.insights[0].key, true)).toEqual({
      success: true
    })
  })
})

describe('series anomalies (via the discovery registry)', () => {
  /** Monday 'YYYY-MM-DD' `w` complete weeks before NOW's week. */
  function weekYmd(w: number): string {
    const monday = new Date('2026-06-15T00:00:00')
    monday.setDate(monday.getDate() - w * 7)
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  }
  let seq = 0
  function seedWeek(source: string, type: string, w: number, count: number): void {
    for (let i = 0; i < count; i++) {
      seq++
      sqlite
        .prepare(
          'INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?,?,?,?,?)'
        )
        .run(source, type, new Date(`${weekYmd(w)}T00:00:00`).getTime(), 't', `a-${seq}`)
    }
  }

  it('fires when the last complete week breaks from the trailing norm', async () => {
    const { detectSeriesAnomalies } = await import('./insights-discovery')
    for (let w = 2; w <= 13; w++) seedWeek('browser', 'visit', w, 10)
    seedWeek('browser', 'visit', 1, 30) // latest complete week: 3× the norm
    const hits = detectSeriesAnomalies(db(), NOW)
    expect(hits).toHaveLength(1)
    expect(hits[0].key).toBe('series-anomaly:browsing')
    expect(hits[0].title).toMatch(/jumped 200% above/)
  })

  it('stays quiet on a steady series', async () => {
    const { detectSeriesAnomalies } = await import('./insights-discovery')
    for (let w = 1; w <= 13; w++) seedWeek('browser', 'visit', w, 10)
    expect(detectSeriesAnomalies(db(), NOW)).toHaveLength(0)
  })

  it('never reads a stopped archive as "dropped to zero"', async () => {
    const { detectSeriesAnomalies } = await import('./insights-discovery')
    // Netflix data ends 5 weeks ago — no latest bucket, so no anomaly.
    for (let w = 5; w <= 13; w++) seedWeek('netflix', 'watch', w, 10)
    expect(detectSeriesAnomalies(db(), NOW)).toHaveLength(0)
  })

  it('flows into the lifecycle list with its explicit key', async () => {
    const { listInsights } = await import('./insights-lifecycle')
    for (let w = 2; w <= 13; w++) seedWeek('browser', 'visit', w, 10)
    seedWeek('browser', 'visit', 1, 30)
    const r = listInsights(db(), NOW)
    const anomaly = r.insights.find((i) => i.kind === 'series-anomaly')
    expect(anomaly).toBeDefined()
    expect(anomaly?.key).toBe('series-anomaly:browsing')
  })
})
