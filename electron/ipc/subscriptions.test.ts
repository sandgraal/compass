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
let mod: typeof import('./subscriptions')

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

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
      next_renewal TEXT, trial_ends_at TEXT, payment_account TEXT, cancel_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      meta TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE curation_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE UNIQUE INDEX curation_exclusions_kind_target ON curation_exclusions (kind, target);
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', description TEXT NOT NULL,
      account_id INTEGER, category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
      geo TEXT NOT NULL DEFAULT 'US', purpose TEXT, tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto', tax_year INTEGER,
      normalized_merchant TEXT, source_file TEXT, ingested_at INTEGER
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL UNIQUE, stored_path TEXT NOT NULL,
      extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id),
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER
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
  mod = await import('./subscriptions')
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

describe('subscriptions:dismiss-detected ("Not a subscription")', () => {
  it('durably hides the dismissed charge from every later audit', async () => {
    mockAudit.mockReturnValue({
      totalActiveAnnual: 0,
      active: [detected('scotiabank turrialba', 'Chris Checking (0991)', 454.2)],
      zombies: [],
      expired: [],
      duplicates: []
    })
    let det = (await invoke('subscriptions:get-detected')) as { active: unknown[] }
    expect(det.active).toHaveLength(1)

    await invoke('subscriptions:dismiss-detected', {
      merchant: 'scotiabank turrialba',
      account: 'Chris Checking (0991)'
    })
    det = (await invoke('subscriptions:get-detected')) as { active: unknown[] }
    expect(det.active).toHaveLength(0)

    // Idempotent: dismissing again is a no-op, not an error.
    await invoke('subscriptions:dismiss-detected', {
      merchant: 'scotiabank turrialba',
      account: 'Chris Checking (0991)'
    })
    det = (await invoke('subscriptions:get-detected')) as { active: unknown[] }
    expect(det.active).toHaveLength(0)
  })

  it('a different account for the same merchant is NOT dismissed', async () => {
    mockAudit.mockReturnValue({
      totalActiveAnnual: 0,
      active: [detected('netflix', 'Card A', 15.49), detected('netflix', 'Card B', 15.49)],
      zombies: [],
      expired: [],
      duplicates: []
    })
    await invoke('subscriptions:dismiss-detected', { merchant: 'netflix', account: 'Card A' })
    const det = (await invoke('subscriptions:get-detected')) as {
      active: Array<{ account: string }>
    }
    expect(det.active.map((d) => d.account)).toEqual(['Card B'])
  })

  it('rejects a missing merchant', async () => {
    await expect(invoke('subscriptions:dismiss-detected', {})).rejects.toThrow(/merchant/)
  })
})

// ── Test helpers for the profile/signals/documents surface ──────────────────

function insertTxn(normalizedMerchant: string, amount: number, date = '2026-01-15'): void {
  sqlite
    .prepare(
      `INSERT INTO finance_transactions (hash, date, amount, currency, description, normalized_merchant)
       VALUES (?, ?, ?, 'USD', ?, ?)`
    )
    .run(
      `h-${Math.random().toString(36).slice(2)}`,
      date,
      amount,
      normalizedMerchant,
      normalizedMerchant
    )
}

function insertUsageRecord(source: string, type: string, occurredAtMs: number): void {
  sqlite
    .prepare(
      `INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?, ?, ?, 'x', ?)`
    )
    .run(source, type, occurredAtMs, `dh-${Math.random().toString(36).slice(2)}`)
}

function insertDocument(title: string): number {
  const res = sqlite
    .prepare(
      `INSERT INTO documents (title, file_name, sha256, stored_path) VALUES (?, 'f.pdf', ?, '/tmp/f.pdf')`
    )
    .run(title, `sha-${Math.random().toString(36).slice(2)}`)
  return Number(res.lastInsertRowid)
}

function linkDocumentToSubscription(documentId: number, targetId: string): void {
  sqlite
    .prepare(
      `INSERT INTO document_links (document_id, target_kind, target_id) VALUES (?, 'subscription', ?)`
    )
    .run(documentId, targetId)
}

describe('subscriptions:set-usage', () => {
  it('writes a usage rating and it round-trips through list/profile', async () => {
    const { id } = (await invoke('subscriptions:create', {
      name: 'Adobe Creative Cloud',
      cost: 55
    })) as { id: number }
    await invoke('subscriptions:set-usage', id, 'rarely')
    const list = (await invoke('subscriptions:list')) as Array<{
      id: number
      meta: { usage?: { rating: string; ratedAt: number } } | null
    }>
    expect(list[0].meta?.usage?.rating).toBe('rarely')
    expect(list[0].meta?.usage?.ratedAt).toEqual(expect.any(Number))

    const profile = (await invoke('subscriptions:profile', id)) as {
      subscription: { meta: { usage?: { rating: string } } | null }
    }
    expect(profile.subscription.meta?.usage?.rating).toBe('rarely')
  })

  it('rejects an invalid rating', async () => {
    const { id } = (await invoke('subscriptions:create', { name: 'X', cost: 1 })) as { id: number }
    await expect(invoke('subscriptions:set-usage', id, 'obsessed')).rejects.toThrow(/invalid/)
  })

  it('rejects an unknown id', async () => {
    await expect(invoke('subscriptions:set-usage', 999, 'love')).rejects.toThrow(/not found/)
  })
})

describe('subscriptions:profile — total paid to date', () => {
  it('reports a real ledger total when transactions match the merchant key', async () => {
    const { id } = (await invoke('subscriptions:track-detected', {
      merchant: 'netflix',
      account: 'Chase',
      cadence: 'monthly',
      medianAmount: 15.49
    })) as { id: number }
    insertTxn('netflix', -15.49, '2026-01-01')
    insertTxn('netflix', -15.49, '2026-02-01')
    insertTxn('netflix', -15.49, '2026-03-01')

    const profile = (await invoke('subscriptions:profile', id)) as {
      totalPaid: { totalSpend: number; txnCount: number; estimated: boolean }
    }
    expect(profile.totalPaid).toMatchObject({
      totalSpend: 46.47,
      txnCount: 3,
      estimated: false
    })
  })

  it('falls back to a cadence×elapsed-time estimate with no ledger match', async () => {
    const { id } = (await invoke('subscriptions:create', {
      name: 'Cash Gym Membership',
      cost: 50,
      cadence: 'monthly'
    })) as { id: number }
    // Directly exercise the exported builder with a controlled `now` so the
    // estimate math is deterministic (the IPC handler always uses real time).
    const createdAt = new Date('2026-01-01T00:00:00Z')
    sqlite
      .prepare('UPDATE subscriptions SET created_at = ? WHERE id = ?')
      .run(createdAt.getTime(), id)
    const now = new Date('2026-07-01T00:00:00Z') // ~6 months later → ~6 monthly periods
    const profile = mod.buildSubscriptionProfile(id, now)
    expect(profile.totalPaid.estimated).toBe(true)
    expect(profile.totalPaid.txnCount).toBe(0)
    expect(profile.totalPaid.totalSpend).toBeGreaterThan(200) // ~6 * 50
    expect(profile.totalPaid.totalSpend).toBeLessThan(350) // < 7 * 50
  })

  it('rejects an unknown id', async () => {
    expect(() => mod.buildSubscriptionProfile(999)).toThrow(/not found/)
  })
})

describe('subscriptions:profile — signals cross-referenced from the ledger audit', () => {
  it('surfaces price-hike, zombie status, and duplicates straight from auditSubscriptions', async () => {
    const { id } = (await invoke('subscriptions:track-detected', {
      merchant: 'netflix',
      account: 'Chase',
      cadence: 'monthly',
      medianAmount: 17.99
    })) as { id: number }
    mockAudit.mockReturnValue({
      totalActiveAnnual: 0,
      active: [],
      zombies: [
        {
          ...detected('netflix', 'Chase', 17.99),
          status: 'zombie',
          priceHike: true,
          priceHikeDelta: 3,
          priceHikePct: 20,
          recentMedian: 17.99,
          historicalMedian: 14.99
        }
      ],
      expired: [],
      duplicates: [{ merchant: 'netflix', accounts: ['Chase', 'Amex'], combinedAnnual: 400 }]
    })

    const profile = (await invoke('subscriptions:profile', id)) as {
      signals: {
        hasLedgerMatch: boolean
        auditStatus: string | null
        priceHike: boolean
        priceHikePct: number
        isDuplicate: boolean
        duplicateAccounts: string[]
        duplicateCombinedAnnual: number
      }
    }
    expect(profile.signals).toMatchObject({
      hasLedgerMatch: true,
      auditStatus: 'zombie',
      priceHike: true,
      priceHikePct: 20,
      isDuplicate: true,
      duplicateAccounts: ['Chase', 'Amex'],
      duplicateCombinedAnnual: 400
    })
  })

  it('reports no ledger match for a manual subscription the detector has never seen', async () => {
    const { id } = (await invoke('subscriptions:create', { name: 'Storage Unit', cost: 80 })) as {
      id: number
    }
    const profile = (await invoke('subscriptions:profile', id)) as {
      signals: { hasLedgerMatch: boolean; isDuplicate: boolean }
    }
    expect(profile.signals).toMatchObject({ hasLedgerMatch: false, isDuplicate: false })
  })
})

describe('subscriptions:profile — unused-subscription signal', () => {
  it('flags an active streaming sub as unused when no recent activity record matches', async () => {
    const { id } = (await invoke('subscriptions:create', {
      name: 'Netflix',
      cost: 15.49,
      status: 'active'
    })) as { id: number }
    const profile = (await invoke('subscriptions:profile', id)) as {
      signals: { unusedTrackable: boolean; unused: boolean }
    }
    expect(profile.signals).toMatchObject({ unusedTrackable: true, unused: true })
  })

  it('is not unused once a matching activity record lands within the window', async () => {
    const { id } = (await invoke('subscriptions:create', {
      name: 'Netflix',
      cost: 15.49,
      status: 'active'
    })) as { id: number }
    insertUsageRecord('netflix', 'watch', Date.now() - 24 * 3600 * 1000) // yesterday
    const profile = (await invoke('subscriptions:profile', id)) as {
      signals: { unusedTrackable: boolean; unused: boolean }
    }
    expect(profile.signals).toMatchObject({ unusedTrackable: true, unused: false })
  })

  it('is not trackable for a subscription with no recognized usage source', async () => {
    const { id } = (await invoke('subscriptions:create', {
      name: 'Adobe Creative Cloud',
      cost: 55,
      status: 'active'
    })) as { id: number }
    const profile = (await invoke('subscriptions:profile', id)) as {
      signals: { unusedTrackable: boolean; unused: boolean }
    }
    expect(profile.signals).toMatchObject({ unusedTrackable: false, unused: false })
  })
})

describe('subscriptions:profile — documents', () => {
  it('lists documents attached via targetKind "subscription"', async () => {
    const { id } = (await invoke('subscriptions:create', { name: 'Domain', cost: 12 })) as {
      id: number
    }
    const list = (await invoke('subscriptions:list')) as Array<{ id: number; externalId: string }>
    const externalId = list.find((s) => s.id === id)!.externalId
    const docId = insertDocument('Domain renewal receipt')
    linkDocumentToSubscription(docId, externalId)

    const profile = (await invoke('subscriptions:profile', id)) as {
      documents: Array<{ title: string }>
    }
    expect(profile.documents).toEqual([
      expect.objectContaining({ title: 'Domain renewal receipt' })
    ])
  })
})

describe('subscriptions:list — cheap per-row badges', () => {
  it('flags priceHike/zombie/isDuplicate from one shared audit read, and unused from one shared usage read', async () => {
    await invoke('subscriptions:track-detected', {
      merchant: 'netflix',
      account: 'Chase',
      cadence: 'monthly',
      medianAmount: 17.99
    })
    await invoke('subscriptions:create', { name: 'Storage Unit', cost: 80 })
    mockAudit.mockReturnValue({
      totalActiveAnnual: 0,
      active: [
        {
          ...detected('netflix', 'Chase', 17.99),
          priceHike: true,
          priceHikePct: 20
        }
      ],
      zombies: [],
      expired: [],
      duplicates: [{ merchant: 'netflix', accounts: ['Chase', 'Amex'], combinedAnnual: 400 }]
    })

    const list = (await invoke('subscriptions:list')) as Array<{
      name: string
      priceHike: boolean
      zombie: boolean
      isDuplicate: boolean
      unused: boolean
    }>
    const netflix = list.find((s) => s.name === 'netflix')!
    expect(netflix).toMatchObject({ priceHike: true, zombie: false, isDuplicate: true })
    // Netflix has a usage-recognition entry but no matching `records` row → unused.
    expect(netflix.unused).toBe(true)

    const storage = list.find((s) => s.name === 'Storage Unit')!
    expect(storage).toMatchObject({
      priceHike: false,
      zombie: false,
      isDuplicate: false,
      unused: false
    })
  })
})
