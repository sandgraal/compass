/**
 * Tests for the assets:* IPC handlers (Phase 9.5 — "The Storehouse").
 * Real in-memory SQLite for the owned `assets` table; only `dialog` is mocked.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))

const mockDialog = { showSaveDialog: vi.fn() }
vi.mock('electron', () => ({ dialog: mockDialog }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return Promise.resolve().then(() => h({}, ...args))
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'other', name TEXT NOT NULL,
      value REAL, provider TEXT, reference TEXT, renewal_date TEXT,
      status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  mockDialog.showSaveDialog.mockReset()
  const mod = await import('./assets')
  mod.registerAssetsHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

type AssetRec = { id: number; type: string; name: string; value: number | null; externalId: string }

describe('assets CRUD', () => {
  it('creates an asset and reads it back', async () => {
    const { id } = (await invoke('assets:create', {
      type: 'property',
      name: 'Lake House',
      value: 350000,
      provider: 'Self',
      renewalDate: '2027-01-01'
    })) as { id: number }
    expect(id).toBeGreaterThan(0)
    const list = (await invoke('assets:list')) as AssetRec[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'property', name: 'Lake House', value: 350000 })
    expect(list[0].externalId).toMatch(/^manual:/)
  })

  it('normalizes an unknown type to "other" and a bad value to null', async () => {
    await invoke('assets:create', { type: 'spaceship', name: 'X', value: Number.NaN })
    const a = ((await invoke('assets:list')) as AssetRec[])[0]
    expect(a.type).toBe('other')
    expect(a.value).toBeNull()
  })

  it('groups by type order then by descending value', async () => {
    await invoke('assets:create', { type: 'vehicle', name: 'Car', value: 20000 })
    await invoke('assets:create', { type: 'insurance', name: 'Home policy', value: 0 })
    await invoke('assets:create', { type: 'property', name: 'Condo', value: 500000 })
    await invoke('assets:create', { type: 'property', name: 'Cabin', value: 900000 })
    const names = ((await invoke('assets:list')) as AssetRec[]).map((a) => a.name)
    // ASSET_TYPES order: insurance (0) → vehicle (1) → property (2); biggest value first within a type.
    expect(names).toEqual(['Home policy', 'Car', 'Cabin', 'Condo'])
  })

  it('filters by type', async () => {
    await invoke('assets:create', { type: 'vehicle', name: 'Car' })
    await invoke('assets:create', { type: 'pet', name: 'Dog' })
    const pets = (await invoke('assets:list', { type: 'pet' })) as AssetRec[]
    expect(pets.map((a) => a.name)).toEqual(['Dog'])
  })

  it('updates and deletes', async () => {
    const { id } = (await invoke('assets:create', { name: 'Boat', type: 'vehicle' })) as {
      id: number
    }
    await invoke('assets:update', id, { name: 'Boat', type: 'vehicle', status: 'sold' })
    expect(((await invoke('assets:list')) as Array<{ status: string }>)[0].status).toBe('sold')
    await invoke('assets:delete', id)
    expect((await invoke('assets:list')) as AssetRec[]).toHaveLength(0)
  })

  it('requires a name on create', async () => {
    await expect(invoke('assets:create', { type: 'pet' })).rejects.toThrow(/name/)
  })
})

describe('assets:export-csv', () => {
  it('writes a CSV of all assets', async () => {
    await invoke('assets:create', { type: 'property', name: 'Lake House', value: 350000 })
    const out = join(mkdtempSync(join(tmpdir(), 'compass-assets-')), 'assets.csv')
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: out })
    const res = (await invoke('assets:export-csv')) as { success: boolean; count: number }
    expect(res).toMatchObject({ success: true, count: 1 })
    const csv = readFileSync(out, 'utf-8')
    expect(csv).toContain('Lake House')
    expect(csv).toContain('350000')
  })

  it('returns canceled when dismissed', async () => {
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke('assets:export-csv')).toMatchObject({ canceled: true })
  })
})
