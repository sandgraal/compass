/**
 * Tests for the habits:* IPC handlers (Phase 6.1 — P3).
 *
 * Habits handlers are pure DB CRUD with no external side effects, so the
 * cleanest approach is a REAL in-memory SQLite via better-sqlite3 +
 * drizzle. That gets us real SQL semantics (date comparisons, default
 * values, the soft-delete behavior of `active`) without paying for
 * Drizzle mocking gymnastics.
 *
 * Coverage:
 *   - habits:list (default + includeInactive)
 *   - habits:create (id assignment, defaults, returned shape)
 *   - habits:update (partial update)
 *   - habits:delete (soft delete — sets active=false, does NOT remove row)
 *   - habits:get-entries (month-window filter, grouped-by-habitId shape)
 *   - habits:get-all-entries (returns ALL entries grouped the same way)
 *   - habits:toggle (insert when absent, flip when present, returns the
 *     resulting completed state)
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

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./habits')
  mod.registerHabitsHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  // Schema slice — just the two tables habits.ts touches. Mirrors the
  // real schema so date columns are TEXT and booleans are INTEGER, the
  // way drizzle expects them.
  sqlite.exec(`
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
      habit_id INTEGER REFERENCES habits(id),
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedHabit(name: string, active = true): number {
  const info = sqlite
    .prepare('INSERT INTO habits (name, active, color) VALUES (?, ?, ?)')
    .run(name, active ? 1 : 0, '#6272f1')
  return Number(info.lastInsertRowid)
}

function seedEntry(habitId: number, date: string, completed: boolean): void {
  sqlite
    .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (?, ?, ?)')
    .run(habitId, date, completed ? 1 : 0)
}

function entryRow(habitId: number, date: string): { completed: number } | undefined {
  return sqlite
    .prepare('SELECT completed FROM habit_entries WHERE habit_id = ? AND date = ?')
    .get(habitId, date) as { completed: number } | undefined
}

// ── habits:list ──────────────────────────────────────────────────────────────

describe('habits:list', () => {
  it('returns only active habits by default', async () => {
    seedHabit('drink water', true)
    seedHabit('archived habit', false)
    const h = await registerAndGet('habits:list')
    const out = (await invoke(h)) as Array<{ name: string; active: boolean }>
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('drink water')
  })

  it('includes inactive habits when explicitly asked', async () => {
    seedHabit('drink water', true)
    seedHabit('archived habit', false)
    const h = await registerAndGet('habits:list')
    const out = (await invoke(h, true)) as unknown[]
    expect(out).toHaveLength(2)
  })

  it('returns an empty array when no habits exist', async () => {
    const h = await registerAndGet('habits:list')
    expect(await invoke(h)).toEqual([])
  })
})

// ── habits:create ────────────────────────────────────────────────────────────

describe('habits:create', () => {
  it('inserts a habit and returns the new id', async () => {
    const h = await registerAndGet('habits:create')
    const out = (await invoke(h, { name: 'meditate' })) as { success: boolean; id: number }
    expect(out.success).toBe(true)
    expect(out.id).toBeGreaterThan(0)

    const row = sqlite
      .prepare('SELECT name, active, color FROM habits WHERE id = ?')
      .get(out.id) as {
      name: string
      active: number
      color: string
    }
    expect(row.name).toBe('meditate')
    expect(row.active).toBe(1) // active=true by default
    expect(row.color).toBe('#6272f1') // default color
  })

  it('uses caller-supplied color + icon when provided', async () => {
    const h = await registerAndGet('habits:create')
    const out = (await invoke(h, { name: 'read', icon: 'book', color: '#abcdef' })) as {
      id: number
    }
    const row = sqlite.prepare('SELECT icon, color FROM habits WHERE id = ?').get(out.id) as {
      icon: string
      color: string
    }
    expect(row.icon).toBe('book')
    expect(row.color).toBe('#abcdef')
  })
})

// ── habits:update ────────────────────────────────────────────────────────────

describe('habits:update', () => {
  it('partial-updates a habit', async () => {
    const id = seedHabit('old name')
    const h = await registerAndGet('habits:update')
    await invoke(h, id, { name: 'new name', color: '#ff0000' })
    const row = sqlite.prepare('SELECT name, color FROM habits WHERE id = ?').get(id) as {
      name: string
      color: string
    }
    expect(row.name).toBe('new name')
    expect(row.color).toBe('#ff0000')
  })

  it('can flip active=true (reactivation path for a soft-deleted habit)', async () => {
    const id = seedHabit('archived', false)
    const h = await registerAndGet('habits:update')
    await invoke(h, id, { active: true })
    const row = sqlite.prepare('SELECT active FROM habits WHERE id = ?').get(id) as {
      active: number
    }
    expect(row.active).toBe(1)
  })
})

// ── habits:delete ────────────────────────────────────────────────────────────

describe('habits:delete', () => {
  it('soft-deletes by flipping active=false (does NOT remove the row)', async () => {
    // Soft delete preserves history — the habit_entries rows stay
    // intact for streak calculations and reactivation later. A real
    // DELETE would cascade or orphan those entries, which the user
    // would not expect from clicking "Delete" on a habit they
    // intended to just archive.
    const id = seedHabit('temporary habit')
    seedEntry(id, '2026-05-01', true)

    const h = await registerAndGet('habits:delete')
    await invoke(h, id)

    const habit = sqlite.prepare('SELECT active FROM habits WHERE id = ?').get(id) as {
      active: number
    }
    expect(habit.active).toBe(0)
    // Entry is preserved
    const entry = entryRow(id, '2026-05-01')
    expect(entry).toBeDefined()
  })
})

// ── habits:get-entries ───────────────────────────────────────────────────────

describe('habits:get-entries', () => {
  it('returns entries within the requested month, grouped by habitId', async () => {
    const a = seedHabit('a')
    const b = seedHabit('b')
    seedEntry(a, '2026-05-01', true)
    seedEntry(a, '2026-05-15', false)
    seedEntry(b, '2026-05-20', true)
    // Out-of-window entries (should NOT appear)
    seedEntry(a, '2026-04-30', true)
    seedEntry(a, '2026-06-01', true)

    const h = await registerAndGet('habits:get-entries')
    const out = (await invoke(h, '2026-05')) as Record<number, Record<string, boolean>>
    expect(out[a]).toEqual({ '2026-05-01': true, '2026-05-15': false })
    expect(out[b]).toEqual({ '2026-05-20': true })
  })

  it('handles December → January wrap correctly (end date is next year)', async () => {
    // Edge case: month '2026-12' → next month is 2027-01. The handler
    // builds the end date by incrementing JS Date's month, which has
    // to roll over the year. Lock the behavior.
    const id = seedHabit('eve')
    seedEntry(id, '2026-12-31', true)
    seedEntry(id, '2027-01-01', true) // out of window

    const h = await registerAndGet('habits:get-entries')
    const out = (await invoke(h, '2026-12')) as Record<number, Record<string, boolean>>
    expect(out[id]).toEqual({ '2026-12-31': true })
  })

  it('returns an empty object when no entries match the window', async () => {
    const h = await registerAndGet('habits:get-entries')
    expect(await invoke(h, '2026-05')).toEqual({})
  })
})

// ── habits:get-all-entries ───────────────────────────────────────────────────

describe('habits:get-all-entries', () => {
  it('returns every entry across all habits, grouped by habitId', async () => {
    const a = seedHabit('a')
    const b = seedHabit('b')
    seedEntry(a, '2024-01-15', true)
    seedEntry(a, '2026-05-15', true)
    seedEntry(b, '2025-08-20', false)

    const h = await registerAndGet('habits:get-all-entries')
    const out = (await invoke(h)) as Record<number, Record<string, boolean>>
    expect(out[a]).toEqual({ '2024-01-15': true, '2026-05-15': true })
    expect(out[b]).toEqual({ '2025-08-20': false })
  })

  it('returns {} when there are no entries', async () => {
    const h = await registerAndGet('habits:get-all-entries')
    expect(await invoke(h)).toEqual({})
  })
})

// ── habits:toggle ────────────────────────────────────────────────────────────

describe('habits:toggle', () => {
  it('inserts an entry with completed=true on first toggle', async () => {
    const id = seedHabit('floss')
    const h = await registerAndGet('habits:toggle')
    const out = (await invoke(h, id, '2026-05-20')) as { success: boolean; completed: boolean }
    expect(out.completed).toBe(true)
    expect(entryRow(id, '2026-05-20')?.completed).toBe(1)
  })

  it('flips an existing entry to false on second toggle', async () => {
    const id = seedHabit('floss')
    seedEntry(id, '2026-05-20', true)
    const h = await registerAndGet('habits:toggle')
    const out = (await invoke(h, id, '2026-05-20')) as { completed: boolean }
    expect(out.completed).toBe(false)
    expect(entryRow(id, '2026-05-20')?.completed).toBe(0)
  })

  it('flips false → true on the next toggle (does NOT create a duplicate row)', async () => {
    const id = seedHabit('floss')
    seedEntry(id, '2026-05-20', false)
    const h = await registerAndGet('habits:toggle')
    await invoke(h, id, '2026-05-20')
    expect(entryRow(id, '2026-05-20')?.completed).toBe(1)
    // Exactly one row for this (habit, date) — toggle must NOT insert
    // a duplicate.
    const count = sqlite
      .prepare('SELECT COUNT(*) AS n FROM habit_entries WHERE habit_id = ? AND date = ?')
      .get(id, '2026-05-20') as { n: number }
    expect(count.n).toBe(1)
  })

  it('returns the new completed state in the response', async () => {
    const id = seedHabit('floss')
    const h = await registerAndGet('habits:toggle')
    const first = (await invoke(h, id, '2026-05-20')) as { completed: boolean }
    expect(first.completed).toBe(true)
    const second = (await invoke(h, id, '2026-05-20')) as { completed: boolean }
    expect(second.completed).toBe(false)
  })
})
