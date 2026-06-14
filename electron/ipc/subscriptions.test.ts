/**
 * Tests for the subscriptions:* IPC handlers (Phase 9.3 — "The Storehouse").
 *
 * Real in-memory SQLite for the owned `subscriptions` table. `auditSubscriptions`
 * is mocked so we exercise OUR logic — the tracked-flagging, the track-detected
 * dedup, annualization, CSV export — without coupling to the detector internals
 * (which the morning-brief price-hike alert owns and we leave untouched).
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

const mockAudit = vi.fn()
vi.mock('../integrations/finance-subscriptions', () => ({
  auditSubscriptions: (...args: unknown[]) => mockAudit(...args)
}))

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

function detected(merchant: string, account: string, medianAmount: number) {
  return {
    merchant,
    account,
    category: 'Subscriptions',
    subcategory: '',
    cadence: 'monthly',
    medianAmount,
    minAmount: medianAmount,
    maxAmount: medianAmount,
    annualCost: medianAmount * 12,
    firstSeen: '2026-01-01',
    lastSeen: '2026-06-01',
    daysSinceLast: 10,
    nCharges: 5,
    status: 'active',
    priceBump: false,
    priceHike: false,
    priceHikeDelta: 0,
    priceHikePct: 0,
    recentMedian: medianAmount,
    historicalMedian: medianAmount
  }
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      cadence TEXT NOT NULL DEFAULT 'monthly',
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      next_renewal TEXT, payment_account TEXT, cancel_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER, updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  mockAudit.mockReset()
  mockAudit.mockReturnValue({
    totalActiveAnnual: 0,
    active: [],
    zombies: [],
    expired: [],
    duplicates: []
  })
  mockDialog.showSaveDialog.mockReset()
  const mod = await import('./subscriptions')
  mod.registerSubscriptionsHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('subscriptions CRUD', () => {
  it('creates a manual subscription and annualizes the cost', async () => {
    await invoke('subscriptions:create', { name: 'Gym', cost: 40, cadence: 'monthly' })
    const list = (await invoke('subscriptions:list')) as SubRec[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'Gym', cost: 40, source: 'manual', annualCost: 480 })
    expect(list[0].externalId).toMatch(/^manual:/)
  })

  it('annualizes by cadence (yearly ×1, weekly ×52)', async () => {
    await invoke('subscriptions:create', { name: 'Domain', cost: 12, cadence: 'yearly' })
    await invoke('subscriptions:create', { name: 'Coffee', cost: 5, cadence: 'weekly' })
    const byName = Object.fromEntries(
      ((await invoke('subscriptions:list')) as SubRec[]).map((s) => [s.name, s.annualCost])
    )
    expect(byName.Domain).toBe(12)
    expect(byName.Coffee).toBe(260)
  })

  it('updates and deletes', async () => {
    const { id } = (await invoke('subscriptions:create', { name: 'X', cost: 10 })) as { id: number }
    await invoke('subscriptions:update', id, { name: 'X', cost: 10, status: 'cancelled' })
    expect(((await invoke('subscriptions:list')) as SubRec[])[0].status).toBe('cancelled')
    await invoke('subscriptions:delete', id)
    expect((await invoke('subscriptions:list')) as SubRec[]).toHaveLength(0)
  })

  it('sorts active before cancelled, then by annual cost', async () => {
    await invoke('subscriptions:create', { name: 'Cheap', cost: 1, cadence: 'monthly' })
    await invoke('subscriptions:create', { name: 'Pricey', cost: 100, cadence: 'monthly' })
    const { id } = (await invoke('subscriptions:create', {
      name: 'Dead',
      cost: 999,
      cadence: 'monthly'
    })) as { id: number }
    await invoke('subscriptions:update', id, { name: 'Dead', cost: 999, status: 'cancelled' })
    const names = ((await invoke('subscriptions:list')) as SubRec[]).map((s) => s.name)
    expect(names).toEqual(['Pricey', 'Cheap', 'Dead'])
  })
})

describe('detected subscriptions bridge', () => {
  it('flags which detected charges are already tracked', async () => {
    mockAudit.mockReturnValue({
      totalActiveAnnual: 240,
      active: [detected('netflix', 'Chase', 20)],
      zombies: [],
      expired: [],
      duplicates: []
    })
    const before = (await invoke('subscriptions:get-detected')) as Detected
    expect(before.active[0]).toMatchObject({ merchant: 'netflix', tracked: false })

    // Track it, then re-query — now flagged tracked.
    const res = (await invoke('subscriptions:track-detected', {
      merchant: 'netflix',
      account: 'Chase',
      cadence: 'monthly',
      medianAmount: 20
    })) as { success: boolean; id: number }
    expect(res.success).toBe(true)

    const tracked = ((await invoke('subscriptions:list')) as SubRec[])[0]
    expect(tracked).toMatchObject({ name: 'netflix', source: 'detected', cost: 20 })
    expect(tracked.externalId).toBe('detected:netflix::Chase')

    const after = (await invoke('subscriptions:get-detected')) as Detected
    expect(after.active[0].tracked).toBe(true)
  })

  it('track-detected is idempotent (re-track reports alreadyTracked)', async () => {
    const d = { merchant: 'spotify', account: 'Amex', cadence: 'monthly', medianAmount: 11 }
    await invoke('subscriptions:track-detected', d)
    const again = (await invoke('subscriptions:track-detected', d)) as { alreadyTracked?: boolean }
    expect(again.alreadyTracked).toBe(true)
    expect((await invoke('subscriptions:list')) as SubRec[]).toHaveLength(1)
  })
})

describe('subscriptions:export-csv', () => {
  it('writes a CSV with an annual_cost column', async () => {
    await invoke('subscriptions:create', { name: 'Netflix', cost: 20, cadence: 'monthly' })
    const out = join(mkdtempSync(join(tmpdir(), 'compass-subs-')), 'subs.csv')
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: out })
    const res = (await invoke('subscriptions:export-csv')) as { success: boolean; count: number }
    expect(res).toMatchObject({ success: true, count: 1 })
    const csv = readFileSync(out, 'utf-8')
    expect(csv).toContain('annual_cost')
    expect(csv).toContain('Netflix')
    expect(csv).toContain('240') // 20 * 12
  })

  it('returns canceled when the save dialog is dismissed', async () => {
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke('subscriptions:export-csv')).toMatchObject({ canceled: true })
  })
})

type SubRec = {
  id: number
  name: string
  cost: number
  status: string
  source: string
  externalId: string
  annualCost: number
}
type Detected = { active: Array<{ merchant: string; tracked: boolean }> }
