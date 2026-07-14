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
import { and, eq, gte, inArray } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { documentLinks, documents, records, subscriptions } from '../db/schema'
import {
  type Subscription as AuditedSubscription,
  type SubscriptionAudit,
  auditSubscriptions
} from '../integrations/finance-subscriptions'
import { serializeCsv } from '../lib/csv'
import { addExclusions, loadExclusionSet } from '../lib/curation'
import { matchKeyForSubscription } from '../lib/merchant-match'
import { type MerchantSlimTxn, computeMerchantStats } from '../lib/merchant-profile'
import { type Cadence, PER_YEAR, annualizeCost } from '../lib/normalize'
import {
  type SubscriptionUsageMatch,
  matchSubscriptionUsage,
  usagePairKey,
  wasSubscriptionUsed
} from '../lib/subscription-usage'
import { UNUSED_SUB_DAYS } from './insights'
import { loadSlimTxnsByMerchantKey } from './merchants'

// Re-exported for the Storehouse summary (electron/ipc/storehouse.ts), which
// annualizes the same subscription costs.
export { annualizeCost }

const MAX_TEXT = 4000
const MAX_NOTES = 20_000

/** The natural key a detected charge materializes under, so re-tracking dedupes. */
function detectedKey(merchant: string, account: string): string {
  return `detected:${merchant}::${account}`
}

/**
 * Materialize a detected recurring charge into the owned table, idempotent by the
 * `detected:<merchant>::<account>` external id. Shared by the finance-audit
 * "track" handler AND the cross-reference engine's `entities:promote`, so a
 * records-derived subscription candidate and a finance-detected one collapse to
 * the same row when their (merchant, account) match. Returns the row id.
 */
export function trackDetectedSubscription(detected: {
  merchant: string
  account?: string | null
  category?: string | null
  cadence?: string
  medianAmount?: number
}): { id: number; alreadyTracked: boolean } {
  const db = getDb()
  const externalId = detectedKey(detected.merchant, detected.account ?? '—')
  const existing = db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.externalId, externalId))
    .all()[0]
  if (existing) return { id: existing.id, alreadyTracked: true }
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
  return { id: Number(result.lastInsertRowid), alreadyTracked: false }
}

const CSV_HEADERS = [
  'name',
  'cost',
  'cadence',
  'annual_cost',
  'category',
  'status',
  'next_renewal',
  'trial_ends_at',
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
      trial_ends_at: r.trialEndsAt ?? '',
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
  trialEndsAt?: string | null
  paymentAccount?: string | null
  cancelUrl?: string | null
  notes?: string | null
}

/**
 * Namespaced JSON extras on a subscriptions row (`subscriptions.meta`) —
 * mirrors `places.meta`. `usage` is the user's own "is this worth it"
 * self-check-in (no usage-tracking API exists or should exist here — this is
 * an explicit, cheap, user-driven signal). `enrichment` is reserved for a
 * future consent-gated web-enrichment pass (pricing/cancellation/alternatives).
 */
export interface SubscriptionMeta {
  usage?: { rating: UsageRating; ratedAt: number }
}

export type UsageRating = 'love' | 'use' | 'rarely' | 'barely'
const USAGE_RATINGS: ReadonlySet<string> = new Set<UsageRating>(['love', 'use', 'rarely', 'barely'])

function parseSubMeta(raw: string | null): SubscriptionMeta | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SubscriptionMeta) : null
  } catch {
    return null
  }
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
    trialEndsAt: row.trialEndsAt,
    paymentAccount: row.paymentAccount,
    cancelUrl: row.cancelUrl,
    notes: row.notes,
    source: row.source,
    meta: parseSubMeta(row.meta),
    annualCost: annualizeCost(row.cost, row.cadence),
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null
  }
}

/** Build the writable column set from renderer input. Never touches `meta` —
 * that's written only via `subscriptions:set-usage`, so a generic edit can
 * never clobber the usage self-check-in (or a future enrichment namespace). */
function toStorage(input: SubscriptionInput) {
  return {
    name: clamp(input.name, MAX_TEXT) || 'Untitled subscription',
    cost: Math.max(0, num(input.cost)),
    cadence: clamp(input.cadence, 32) || 'monthly',
    category: clamp(input.category, MAX_TEXT),
    status: clamp(input.status, 32) || 'active',
    nextRenewal: clamp(input.nextRenewal, 32),
    trialEndsAt: clamp(input.trialEndsAt, 32),
    paymentAccount: clamp(input.paymentAccount, MAX_TEXT),
    cancelUrl: clamp(input.cancelUrl, MAX_TEXT),
    notes: clamp(input.notes, MAX_NOTES)
  }
}

/** Find this subscription's audit record — never recomputed, straight off the
 * existing ledger detector. Prefers an exact (merchant, account) match when
 * the subscription has a known payment account, else the first match on
 * merchant alone. */
function findAuditMatch(
  audit: SubscriptionAudit,
  matchKey: string,
  accountHint: string | null
): AuditedSubscription | null {
  const all = [...audit.active, ...audit.zombies, ...audit.expired]
  if (accountHint) {
    const exact = all.find((s) => s.merchant === matchKey && s.account === accountHint)
    if (exact) return exact
  }
  return all.find((s) => s.merchant === matchKey) ?? null
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

/** Cash-paid or manual subscription with no ledger match — estimate from
 * cadence × elapsed time since it was added, using the same PER_YEAR table
 * `annualizeCost` already uses so the estimate never invents its own math. */
function estimateTotalPaid(row: SubRow, now: Date): SubscriptionTotalPaid {
  const perYear = PER_YEAR[row.cadence as Cadence] ?? 12
  const start = row.createdAt ?? now
  const elapsedYears = Math.max(0, (now.getTime() - start.getTime()) / MS_PER_YEAR)
  const periods = Math.floor(elapsedYears * perYear)
  return {
    totalSpend: Math.round(row.cost * periods * 100) / 100,
    txnCount: 0,
    lastTxnDate: null,
    currency: 'USD',
    estimated: true
  }
}

export interface SubscriptionTotalPaid {
  totalSpend: number
  txnCount: number
  lastTxnDate: string | null
  currency: string
  /** True when there was no ledger match and this is a cadence×time estimate. */
  estimated: boolean
}

export interface SubscriptionSignals {
  matchKey: string
  hasLedgerMatch: boolean
  auditStatus: AuditedSubscription['status'] | null
  priceHike: boolean
  priceHikeDelta: number
  priceHikePct: number
  recentMedian: number
  historicalMedian: number
  isDuplicate: boolean
  duplicateAccounts: string[]
  duplicateCombinedAnnual: number
  /** False when this subscription isn't a usage-trackable streaming service. */
  unusedTrackable: boolean
  unused: boolean
  unusedWindowDays: number
}

export interface SubscriptionDocumentItem {
  linkId: number
  documentId: number
  title: string
  docDate: string | null
  mimeType: string | null
}

export interface SubscriptionProfile {
  subscription: ReturnType<typeof rowToRecord>
  totalPaid: SubscriptionTotalPaid
  signals: SubscriptionSignals
  documents: SubscriptionDocumentItem[]
}

/**
 * "Everything we know about one subscription" — total paid to date (a real
 * ledger match when we have one, an honest estimate otherwise), price-hike /
 * zombie / duplicate signals cross-referenced from the existing
 * `auditSubscriptions()` detector (never recomputed here), whether Compass
 * has SEEN this subscription actually used recently, and attached documents.
 * Exported (not just registered as an IPC handler) so it's directly testable.
 */
export function buildSubscriptionProfile(id: number, now: Date = new Date()): SubscriptionProfile {
  if (!Number.isInteger(id)) throw new Error('subscriptions:profile requires an integer id')
  const db = getDb()
  const row = db.select().from(subscriptions).where(eq(subscriptions.id, id)).all()[0]
  if (!row) throw new Error('subscriptions:profile: not found')

  const matchKey = matchKeyForSubscription(row.externalId, row.name)

  const slim: MerchantSlimTxn[] = matchKey ? loadSlimTxnsByMerchantKey(matchKey) : []
  const stats = computeMerchantStats(slim)
  const totalPaid: SubscriptionTotalPaid =
    stats.txnCount > 0
      ? {
          totalSpend: stats.totalSpend,
          txnCount: stats.txnCount,
          lastTxnDate: stats.lastTxnDate,
          currency: stats.currency,
          estimated: false
        }
      : estimateTotalPaid(row, now)

  const audit = auditSubscriptions(db)
  const auditMatch = findAuditMatch(audit, matchKey, row.paymentAccount)
  const duplicateEntry = audit.duplicates.find((d) => d.merchant === matchKey)

  const usageMatch = matchSubscriptionUsage(row.name)
  let unusedTrackable = false
  let unused = false
  if (usageMatch && row.status === 'active') {
    unusedTrackable = true
    const since = new Date(now.getTime() - UNUSED_SUB_DAYS * 24 * 3600 * 1000)
    const usedPairs = new Set(
      db
        .select({ source: records.source, type: records.type })
        .from(records)
        .where(
          and(
            inArray(records.source, usageMatch.sources),
            inArray(records.type, usageMatch.types),
            gte(records.occurredAt, since)
          )
        )
        .all()
        .map((r) => usagePairKey(r.source, r.type))
    )
    unused = !wasSubscriptionUsed(usageMatch, usedPairs)
  }

  const docs = db
    .select({
      linkId: documentLinks.id,
      documentId: documents.id,
      title: documents.title,
      docDate: documents.docDate,
      mimeType: documents.mimeType
    })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(
      and(eq(documentLinks.targetKind, 'subscription'), eq(documentLinks.targetId, row.externalId))
    )
    .all()

  return {
    subscription: rowToRecord(row),
    totalPaid,
    signals: {
      matchKey,
      hasLedgerMatch: Boolean(auditMatch),
      auditStatus: auditMatch?.status ?? null,
      priceHike: auditMatch?.priceHike ?? false,
      priceHikeDelta: auditMatch?.priceHikeDelta ?? 0,
      priceHikePct: auditMatch?.priceHikePct ?? 0,
      recentMedian: auditMatch?.recentMedian ?? 0,
      historicalMedian: auditMatch?.historicalMedian ?? 0,
      isDuplicate: Boolean(duplicateEntry),
      duplicateAccounts: duplicateEntry?.accounts ?? [],
      duplicateCombinedAnnual: duplicateEntry?.combinedAnnual ?? 0,
      unusedTrackable,
      unused,
      unusedWindowDays: UNUSED_SUB_DAYS
    },
    documents: docs
  }
}

export type SubscriptionListItem = ReturnType<typeof rowToRecord> & {
  priceHike: boolean
  zombie: boolean
  isDuplicate: boolean
  unused: boolean
}

export function registerSubscriptionsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('subscriptions:list', (): SubscriptionListItem[] => {
    const db = getDb()
    const rows = db.select().from(subscriptions).all()

    // One detector read + one usage-records read, reused across every row
    // below — never a per-row DB query. Per-row matching against the
    // in-memory audit arrays still goes through `findAuditMatch` (the same
    // account-aware lookup `subscriptions:profile` uses) so a merchant
    // billed on multiple accounts never shows a badge from the wrong one.
    const audit = auditSubscriptions(db)
    const duplicateMerchants = new Set(audit.duplicates.map((d) => d.merchant))

    const activeUsage = rows
      .filter((r) => r.status === 'active')
      .map((r) => ({ id: r.id, match: matchSubscriptionUsage(r.name) }))
      .filter((e): e is { id: number; match: SubscriptionUsageMatch } => Boolean(e.match))
    let usedPairs = new Set<string>()
    if (activeUsage.length > 0) {
      const sources = [...new Set(activeUsage.flatMap((e) => e.match.sources))]
      const types = [...new Set(activeUsage.flatMap((e) => e.match.types))]
      const since = new Date(Date.now() - UNUSED_SUB_DAYS * 24 * 3600 * 1000)
      usedPairs = new Set(
        db
          .select({ source: records.source, type: records.type })
          .from(records)
          .where(
            and(
              inArray(records.source, sources),
              inArray(records.type, types),
              gte(records.occurredAt, since)
            )
          )
          .all()
          .map((r) => usagePairKey(r.source, r.type))
      )
    }
    const unusedIds = new Set(
      activeUsage.filter((e) => !wasSubscriptionUsed(e.match, usedPairs)).map((e) => e.id)
    )

    // Active first, then by descending annual cost — the biggest live spend on top.
    const order: Record<string, number> = { active: 0, paused: 1, cancelled: 2 }
    return rows
      .map((row) => {
        const matchKey = matchKeyForSubscription(row.externalId, row.name)
        const auditMatch = findAuditMatch(audit, matchKey, row.paymentAccount)
        return {
          ...rowToRecord(row),
          priceHike: auditMatch?.priceHike ?? false,
          zombie: auditMatch?.status === 'zombie' || auditMatch?.status === 'expired',
          isDuplicate: duplicateMerchants.has(matchKey),
          unused: unusedIds.has(row.id)
        }
      })
      .sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.annualCost - a.annualCost
      )
  })

  ipcMain.handle('subscriptions:profile', (_event, id: number) => buildSubscriptionProfile(id))

  ipcMain.handle('subscriptions:set-usage', (_event, id: number, rating: string) => {
    if (!Number.isInteger(id)) throw new Error('subscriptions:set-usage requires an integer id')
    if (!USAGE_RATINGS.has(rating)) throw new Error('subscriptions:set-usage: invalid rating')
    const db = getDb()
    const row = db.select().from(subscriptions).where(eq(subscriptions.id, id)).all()[0]
    if (!row) throw new Error('subscriptions:set-usage: not found')
    const next: SubscriptionMeta = {
      ...(parseSubMeta(row.meta) ?? {}),
      usage: { rating: rating as UsageRating, ratedAt: Date.now() }
    }
    db.update(subscriptions)
      .set({ meta: JSON.stringify(next), updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
      .run()
    return { success: true }
  })

  // Live detector, read-only — flags which detected charges are already tracked.
  // Charges the user dismissed ("Not a subscription") are filtered out here so
  // the durable no survives every re-audit.
  ipcMain.handle('subscriptions:get-detected', () => {
    const db = getDb()
    const audit = auditSubscriptions(db)
    const dismissed = loadExclusionSet(db, ['subscription-dismissed'])
    audit.active = audit.active.filter((s) => !dismissed.has(detectedKey(s.merchant, s.account)))
    audit.zombies = audit.zombies.filter((s) => !dismissed.has(detectedKey(s.merchant, s.account)))
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

  // "Not a subscription" — durably hide a detected charge from the suggestions.
  // Renderer-only; never an AI tool. The exclusion is keyed exactly like
  // track-detected so the same (merchant, account) can never be re-suggested.
  ipcMain.handle(
    'subscriptions:dismiss-detected',
    (_event, input: { merchant?: string; account?: string }) => {
      const merchant = String(input?.merchant ?? '').trim()
      if (!merchant) throw new Error('subscriptions:dismiss-detected requires a merchant')
      const account = String(input?.account ?? '—').trim() || '—'
      addExclusions(getDb(), 'subscription-dismissed', [detectedKey(merchant, account)])
      return { success: true }
    }
  )

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
      const { id, alreadyTracked } = trackDetectedSubscription(detected)
      return alreadyTracked ? { success: true, id, alreadyTracked: true } : { success: true, id }
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
