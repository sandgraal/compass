/**
 * Tests for the `checklist:*` IPC handlers in `electron/ipc/settings.ts`
 * (Phase 0.7 coverage buffer).
 *
 * `settings.test.ts` covers the app-config `settings:*` surface and explicitly
 * defers the checklist task handlers to a focused file — this is it. These are
 * pure DB CRUD, so a real in-memory SQLite gives true SQL semantics (the
 * date-filter + sortOrder ordering in get-items, the roll-over selection
 * predicate, the template upsert):
 *
 *   - checklist:get-items     → listType + date filter, sortOrder ordering
 *   - checklist:add-item      → defaults (category/source/sortOrder), returns row
 *   - checklist:update-item   → partial update
 *   - checklist:delete-item   → row removal
 *   - checklist:roll-over     → carries ONLY unchecked manual daily items forward
 *   - checklist:get-template  → stored content, else the built-in default
 *   - checklist:save-template → insert + onConflict update (one row per listType)
 *   - checklist:quick-add     → empty-title guard, today's date, 500-char clamp
 *
 * Only the off-DB collaborators are mocked (electron, cron, ollama, menu-bar);
 * localYmd + the DB are real.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { localYmd } from '../lib/dates'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// Off-DB collaborators — only needed so importing ./settings resolves; the
// checklist handlers under test never reach them.
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9-test', getPath: () => '/tmp/compass-checklist-test' },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() }
}))
vi.mock('../cron', () => ({ restartCronJobs: vi.fn() }))
vi.mock('../knowledge/ollama', () => ({ detectOllama: vi.fn() }))
vi.mock('../menu-bar', () => ({ restartQuickCaptureShortcut: vi.fn() }))

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
  const mod = await import('./settings')
  mod.registerSettingsHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
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
    CREATE TABLE checklist_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL UNIQUE,
      content_md TEXT NOT NULL DEFAULT '',
      updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedItem(over: {
  listType?: string
  listDate: string
  title: string
  checked?: boolean
  source?: string
  category?: string
  sortOrder?: number
}): number {
  return Number(
    sqlite
      .prepare(
        `INSERT INTO checklist_items (list_type, list_date, title, checked, source, category, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        over.listType ?? 'daily',
        over.listDate,
        over.title,
        over.checked ? 1 : 0,
        over.source ?? 'manual',
        over.category ?? 'personal',
        over.sortOrder ?? 0
      ).lastInsertRowid
  )
}

// ── checklist:get-items ──────────────────────────────────────────────────────

describe('checklist:get-items', () => {
  it('filters by listType + date and orders by sortOrder', async () => {
    seedItem({ listDate: '2026-05-01', title: 'second', sortOrder: 2 })
    seedItem({ listDate: '2026-05-01', title: 'first', sortOrder: 1 })
    seedItem({ listDate: '2026-05-02', title: 'other day', sortOrder: 1 })
    seedItem({ listType: 'weekly', listDate: '2026-05-01', title: 'wrong type', sortOrder: 1 })

    const h = await registerAndGet('checklist:get-items')
    const rows = (await invoke(h, 'daily', '2026-05-01')) as Array<{ title: string }>
    expect(rows.map((r) => r.title)).toEqual(['first', 'second'])
  })

  it('returns [] when nothing matches the date', async () => {
    seedItem({ listDate: '2026-05-01', title: 'x' })
    const h = await registerAndGet('checklist:get-items')
    expect(await invoke(h, 'daily', '2026-12-31')).toEqual([])
  })
})

// ── checklist:add-item ───────────────────────────────────────────────────────

describe('checklist:add-item', () => {
  it('inserts with defaults and returns the created row', async () => {
    const h = await registerAndGet('checklist:add-item')
    const row = (await invoke(h, {
      listType: 'daily',
      listDate: '2026-05-01',
      title: 'Buy milk'
    })) as { id: number; category: string; source: string; sortOrder: number; title: string }
    expect(row.id).toBeGreaterThan(0)
    expect(row.title).toBe('Buy milk')
    expect(row.category).toBe('personal')
    expect(row.source).toBe('manual')
    expect(row.sortOrder).toBe(0)
  })

  it('respects an explicit category + sortOrder', async () => {
    const h = await registerAndGet('checklist:add-item')
    const row = (await invoke(h, {
      listType: 'daily',
      listDate: '2026-05-01',
      title: 'Standup',
      category: 'work',
      sortOrder: 5
    })) as { category: string; sortOrder: number }
    expect(row.category).toBe('work')
    expect(row.sortOrder).toBe(5)
  })
})

// ── checklist:update-item / delete-item ──────────────────────────────────────

describe('checklist:update-item + delete-item', () => {
  it('applies a partial update', async () => {
    const id = seedItem({ listDate: '2026-05-01', title: 'todo' })
    const h = await registerAndGet('checklist:update-item')
    expect(await invoke(h, id, { checked: true, status: 'done' })).toEqual({ success: true })
    const row = sqlite
      .prepare('SELECT checked, status FROM checklist_items WHERE id = ?')
      .get(id) as { checked: number; status: string }
    expect(row).toEqual({ checked: 1, status: 'done' })
  })

  it('deletes a row', async () => {
    const id = seedItem({ listDate: '2026-05-01', title: 'gone' })
    const h = await registerAndGet('checklist:delete-item')
    expect(await invoke(h, id)).toEqual({ success: true })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toEqual({ c: 0 })
  })
})

// ── checklist:roll-over ──────────────────────────────────────────────────────

describe('checklist:roll-over', () => {
  it('carries forward only unchecked, manual, daily items from the source date', async () => {
    seedItem({ listDate: '2026-05-01', title: 'unfinished manual' }) // ✓ rolls
    seedItem({ listDate: '2026-05-01', title: 'done item', checked: true }) // ✗ checked
    seedItem({ listDate: '2026-05-01', title: 'synced', source: 'github' }) // ✗ not manual
    seedItem({ listDate: '2026-04-30', title: 'other day' }) // ✗ wrong date

    const h = await registerAndGet('checklist:roll-over')
    const res = (await invoke(h, '2026-05-01', '2026-05-02')) as { rolledOver: number }
    expect(res.rolledOver).toBe(1)

    const target = sqlite
      .prepare("SELECT title FROM checklist_items WHERE list_date = '2026-05-02'")
      .all() as Array<{ title: string }>
    expect(target).toEqual([{ title: 'unfinished manual' }])
  })

  it('rolls over nothing when the source day is empty', async () => {
    const h = await registerAndGet('checklist:roll-over')
    expect(await invoke(h, '2026-05-01', '2026-05-02')).toEqual({ rolledOver: 0 })
  })
})

// ── checklist:get-template / save-template ───────────────────────────────────

describe('checklist:get-template + save-template', () => {
  it('returns the built-in default when no template is stored', async () => {
    const h = await registerAndGet('checklist:get-template')
    const tpl = (await invoke(h, 'daily')) as string
    expect(typeof tpl).toBe('string')
    expect(tpl.length).toBeGreaterThan(0)
  })

  it('round-trips a saved template and upserts (one row per listType)', async () => {
    const save = await registerAndGet('checklist:save-template')
    expect(await invoke(save, 'daily', '# Morning\n- [ ] Coffee')).toEqual({ success: true })
    expect(await invoke(save, 'daily', '# Updated')).toEqual({ success: true }) // upsert, not dup

    const get = await registerAndGet('checklist:get-template')
    expect(await invoke(get, 'daily')).toBe('# Updated')
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM checklist_templates WHERE list_type='daily'").get()
    ).toEqual({
      c: 1
    })
  })
})

// ── checklist:quick-add ──────────────────────────────────────────────────────

describe('checklist:quick-add', () => {
  it('rejects an empty/whitespace title', async () => {
    const h = await registerAndGet('checklist:quick-add')
    expect(await invoke(h, '   ')).toEqual({ success: false, error: 'Title cannot be empty' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM checklist_items').get()).toEqual({ c: 0 })
  })

  it('adds a daily item dated today, capped at 500 chars', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T08:00:00'))
    try {
      const h = await registerAndGet('checklist:quick-add')
      const longTitle = 'x'.repeat(600)
      expect(await invoke(h, longTitle)).toEqual({ success: true })
      const row = sqlite
        .prepare('SELECT list_type, list_date, title, sort_order FROM checklist_items')
        .get() as { list_type: string; list_date: string; title: string; sort_order: number }
      expect(row.list_type).toBe('daily')
      expect(row.list_date).toBe('2026-05-10')
      expect(row.title).toHaveLength(500)
      expect(row.sort_order).toBe(999)
    } finally {
      vi.useRealTimers()
    }
  })
  })
})
