/**
 * Subscriptions IPC (Phase 9.3 — "The Storehouse").
 *
 * A first-class, user-OWNED subscriptions store. It sits ALONGSIDE the derived
 * `auditSubscriptions()` detector (electron/integrations/finance-subscriptions.ts),
 * which infers recurring charges from the ledger and is left untouched — the
 * morning-brief price-hike alert still depends on it. Here the user curates:
 * - subscriptions Compass can't see from transactions (cash / annual / other card),
 * - edits to detected ones (true cost, renewal date, cancel URL, notes),
 * - a place to mark things paused / cancelled,
 * and can export the lot to CSV.
 *
 * `subscriptions:get-detected` reads the live audit read-only and flags which
 * detected charges are already tracked; `subscriptions:track-detected`
 * materializes one into the table (dedup by `external_id`).
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { subscriptions } from '../db/schema'
import { auditSubscriptions } from '../integrations/finance-subscriptions'
import { serializeCsv } from '../lib/csv'

const MAX_TEXT = 4000
const MAX_NOTES = 20_000

const PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  'semi-annual': 2,
  yearly: 1
}

/** Annualize a per-cadence cost. Unknown cadence falls back to monthly (×12). */
export function annualizeCost(cost: number, cadence: string): number {
  return Math.round(cost * (PER_YEAR[cadence] ?? 12) * 100) / 100
}

/** The natural key a detected charge materializes under, so re-tracking dedupes. */
function detectedKey(merchant: string, account: string): string {
  return `detected:${merchant}::${account}`
}

const CSV_HEADERS = [
  'name',
  'cost',
  'cadence',
  'annual_cost',
  'category',
  'status',
  'next_renewal',
  'payment_account',
  'cancel_url',
  'source',
  'notes'
]

/** All tracked subscriptions as a CSV string. Shared with the Export Center. */
export function buildSubscriptionsCsv(): string {
  const db = getDb()
  const rows = db.select().from(subscriptions).all()
  return serializeCsv(
    rows.map((r) => ({
      name: r.name,
      cost: r.cost,
      cadence: r.cadence,
      annual_cost: annualizeCost(r.cost, r.cadence),
      category: r.category ?? '',
      status: r.status,
      next_renewal: r.nextRenewal ?? '',
      payment_account: r.paymentAccount ?? '',
      cancel_url: r.cancelUrl ?? '',
      source: r.source,
      notes: r.notes ?? ''
    })),
    CSV_HEADERS
  )
}

export interface SubscriptionInput {
  name: string
  cost?: number
  cadence?: string
  category?: string | null
  status?: string
  nextRenewal?: string | null
  paymentAccount?: string | null
  cancelUrl?: string | null
  notes?: string | null
}

type SubRow = typeof subscriptions.$inferSelect

function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  const t = String(s)
  return t.length > max ? t.slice(0, max) : t
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rowToRecord(row: SubRow) {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    cost: row.cost,
    cadence: row.cadence,
    category: row.category,
    status: row.status,
    nextRenewal: row.nextRenewal,
    paymentAccount: row.paymentAccount,
    cancelUrl: row.cancelUrl,
    notes: row.notes,
    source: row.source,
    annualCost: annualizeCost(row.cost, row.cadence),
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null
  }
}

/** Build the writable column set from renderer input. */
function toStorage(input: SubscriptionInput) {
  return {
    name: clamp(input.name, MAX_TEXT) || 'Untitled subscription',
    cost: Math.max(0, num(input.cost)),
    cadence: clamp(input.cadence, 32) || 'monthly',
    category: clamp(input.category, MAX_TEXT),
    status: clamp(input.status, 32) || 'active',
    nextRenewal: clamp(input.nextRenewal, 32),
    paymentAccount: clamp(input.paymentAccount, MAX_TEXT),
    cancelUrl: clamp(input.cancelUrl, MAX_TEXT),
    notes: clamp(input.notes, MAX_NOTES)
  }
}

export function registerSubscriptionsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('subscriptions:list', () => {
    const db = getDb()
    const rows = db.select().from(subscriptions).all()
    // Active first, then by descending annual cost — the biggest live spend on top.
    const order: Record<string, number> = { active: 0, paused: 1, cancelled: 2 }
    return rows
      .map(rowToRecord)
      .sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.annualCost - a.annualCost
      )
  })

  // Live detector, read-only — flags which detected charges are already tracked.
  ipcMain.handle('subscriptions:get-detected', () => {
    const db = getDb()
    const audit = auditSubscriptions(db)
    const trackedKeys = new Set(
      db
        .select({ externalId: subscriptions.externalId })
        .from(subscriptions)
        .all()
        .map((r) => r.externalId)
    )
    const flag = (s: (typeof audit.active)[number]) => ({
      merchant: s.merchant,
      account: s.account,
      category: s.category,
      cadence: s.cadence,
      medianAmount: s.medianAmount,
      annualCost: s.annualCost,
      status: s.status,
      lastSeen: s.lastSeen,
      priceHike: s.priceHike,
      priceHikePct: s.priceHikePct,
      tracked: trackedKeys.has(detectedKey(s.merchant, s.account))
    })
    return {
      totalActiveAnnual: audit.totalActiveAnnual,
      active: audit.active.map(flag),
      zombies: audit.zombies.map(flag)
    }
  })

  ipcMain.handle('subscriptions:create', (_event, input: SubscriptionInput) => {
    if (!input?.name?.trim()) throw new Error('subscriptions:create requires a name')
    const db = getDb()
    const result = db
      .insert(subscriptions)
      .values({
        ...toStorage(input),
        externalId: `manual:${randomUUID()}`,
        source: 'manual',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .run()
    return { success: true, id: Number(result.lastInsertRowid) }
  })

  ipcMain.handle('subscriptions:update', (_event, id: number, updates: SubscriptionInput) => {
    if (!Number.isInteger(id)) throw new Error('subscriptions:update requires an integer id')
    const db = getDb()
    db.update(subscriptions)
      .set({ ...toStorage(updates), updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
      .run()
    return { success: true }
  })

  ipcMain.handle('subscriptions:delete', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('subscriptions:delete requires an integer id')
    const db = getDb()
    db.delete(subscriptions).where(eq(subscriptions.id, id)).run()
    return { success: true }
  })

  // Materialize a detected charge into the owned table (idempotent by external_id).
  ipcMain.handle(
    'subscriptions:track-detected',
    (
      _event,
      detected: {
        merchant: string
        account: string
        category?: string | null
        cadence?: string
        medianAmount?: number
      }
    ) => {
      if (!detected?.merchant?.trim()) throw new Error('track-detected requires a merchant')
      const db = getDb()
      const externalId = detectedKey(detected.merchant, detected.account ?? '—')
      const existing = db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.externalId, externalId))
        .all()[0]
      if (existing) return { success: true, id: existing.id, alreadyTracked: true }
      const result = db
        .insert(subscriptions)
        .values({
          ...toStorage({
            name: detected.merchant,
            cost: detected.medianAmount,
            cadence: detected.cadence,
            category: detected.category ?? null,
            paymentAccount: detected.account ?? null
          }),
          externalId,
          source: 'detected',
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .run()
      return { success: true, id: Number(result.lastInsertRowid) }
    }
  )

  ipcMain.handle('subscriptions:export-csv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export subscriptions to CSV',
      defaultPath: 'compass-subscriptions.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      const db = getDb()
      const count = db.select({ id: subscriptions.id }).from(subscriptions).all().length
      writeFileSync(filePath, buildSubscriptionsCsv(), 'utf-8')
      return { success: true, path: filePath, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
