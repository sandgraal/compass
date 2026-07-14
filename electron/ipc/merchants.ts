/**
 * Merchants IPC (merchants redesign, 2026-07) — the tracked-merchant surface.
 *
 * A tracked merchant is an owned `places` row (kind='merchant', created by
 * `entities:promote`). This namespace layers the rich profile on top:
 *
 *   merchants:list-tracked → every tracked merchant + LIVE ledger stats (one
 *     grouped query over the persisted `normalized_merchant` key — the stale
 *     `places.totalSpend` promote-time snapshot is display-superseded here)
 *   merchants:profile      → everything we know about one merchant: stats,
 *     monthly spend, price trend, recent transactions, cross-source timeline
 *     activity, subscription linkage, attached documents, tax rollup
 *   merchants:update       → the user-editable fields on the places row
 *     (category / url / address / notes / name) + meta.support contacts
 *   merchants:untrack      → delete the places row and clear the projection
 *     row's promoted flags so the merchant reappears in Discovered immediately
 *
 * Reads the ledger + records spine + owned tables only — never the vault
 * (docs/data-access-policy.md). All inputs validated; `derived_entities` is a
 * rebuildable cache and never stores user edits.
 */

import { and, desc, eq, like } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { documentLinks, documents, places, subscriptions } from '../db/schema'
import { matchKeyForPlace } from '../lib/merchant-match'
import {
  type MerchantPriceTrend,
  type MerchantSlimTxn,
  type MerchantStats,
  type MerchantTaxRow,
  type MonthlyBucket,
  computeMerchantStats,
  computeMonthlyBuckets,
  computePriceTrend,
  computeTaxSummary
} from '../lib/merchant-profile'
import { normalizeMerchant } from '../lib/normalize'
import { searchRecords } from '../lib/records-search'
import {
  MAX_LEN,
  type PlaceRecord,
  cleanString,
  cleanUrl,
  clearPromotedFlags,
  parseMeta
} from './places'

/** Namespaced JSON extras on a places row (`places.meta`). */
export interface MerchantMeta {
  support?: { email?: string; phone?: string }
  /** Reserved for the future consent-gated web-enrichment flow. */
  enrichment?: Record<string, unknown>
}

export interface TrackedMerchant extends PlaceRecord {
  matchKey: string
  meta: MerchantMeta | null
  live: {
    totalSpend: number
    txnCount: number
    lastTxnDate: string | null
    currency: string
  } | null
}

export interface MerchantTxnListItem {
  id: number
  date: string
  amount: number
  currency: string
  description: string
  category: string | null
  taxTag: string
}

export interface MerchantActivityHit {
  recordId: number
  source: string
  type: string
  title: string
  occurredAt: number | null
}

export interface MerchantUpdatePatch {
  name?: string
  category?: string | null
  address?: string | null
  url?: string | null
  notes?: string | null
  meta?: MerchantMeta | null
}

export interface MerchantDocumentItem {
  linkId: number
  documentId: number
  title: string
  docDate: string | null
  mimeType: string | null
}

export interface MerchantProfile {
  place: PlaceRecord & { meta: MerchantMeta | null }
  matchKey: string
  stats: MerchantStats
  monthly: MonthlyBucket[]
  priceTrend: MerchantPriceTrend | null
  transactions: MerchantTxnListItem[]
  activity: MerchantActivityHit[]
  subscription: {
    id: number
    name: string
    cost: number
    cadence: string
    status: string
    nextRenewal: string | null
    cancelUrl: string | null
  } | null
  documents: MerchantDocumentItem[]
  tax: MerchantTaxRow[]
}

const TXN_LIST_LIMIT = 50
const ACTIVITY_LIMIT = 20
// Ledger rows already have their own canonical view (the transaction list) —
// keep them out of the cross-source activity feed or every purchase shows twice.
const FINANCE_SOURCES = new Set(['finance'])

type PlaceRow = typeof places.$inferSelect

function rowToRecord(r: PlaceRow): PlaceRecord {
  return {
    id: r.id,
    externalId: r.externalId,
    kind: r.kind,
    name: r.name,
    category: r.category,
    address: r.address,
    url: r.url,
    totalSpend: r.totalSpend,
    notes: r.notes,
    source: r.source
  }
}

/** Slim rows for one merchant key, oldest-first (the aggregates sort anyway). */
function loadSlimTxns(matchKey: string): MerchantSlimTxn[] {
  if (!matchKey) return []
  return getRawSqlite()
    .prepare(
      `SELECT date, amount, currency, tax_tag AS taxTag, tax_year AS taxYear
         FROM finance_transactions WHERE normalized_merchant = ? ORDER BY date`
    )
    .all(matchKey) as MerchantSlimTxn[]
}

/**
 * Live ledger stats for many merchants in one grouped query. Keys with no
 * matching rows are absent from the result map.
 */
function liveStatsFor(
  keys: string[]
): Map<
  string,
  { totalSpend: number; txnCount: number; lastTxnDate: string | null; currency: string }
> {
  const map = new Map<
    string,
    { totalSpend: number; txnCount: number; lastTxnDate: string | null; currency: string }
  >()
  const unique = [...new Set(keys.filter((k) => k.length > 0))]
  if (unique.length === 0) return map
  const rows = getRawSqlite()
    .prepare(
      `SELECT normalized_merchant AS key,
             date,
             amount,
             currency,
             tax_tag AS taxTag,
             tax_year AS taxYear
        FROM finance_transactions
       WHERE normalized_merchant IN (${unique.map(() => '?').join(', ')})
       ORDER BY normalized_merchant, date`
    )
    .all(...unique) as Array<
    {
      key: string
    } & MerchantSlimTxn
  >
  const byKey = new Map<string, MerchantSlimTxn[]>()
  for (const row of rows) {
    const txns = byKey.get(row.key) ?? []
    txns.push(row)
    byKey.set(row.key, txns)
  }
  for (const [key, txns] of byKey) {
    const stats = computeMerchantStats(txns)
    map.set(key, {
      totalSpend: stats.totalSpend,
      txnCount: stats.txnCount,
      lastTxnDate: stats.lastTxnDate,
      currency: stats.currency
    })
  }
  return map
}

/** The subscription this merchant bills as, when one is tracked. */
function findLinkedSubscription(matchKey: string): MerchantProfile['subscription'] {
  if (!matchKey) return null
  const db = getDb()
  // Detected/materialized rows carry the merchant key in their external id …
  const byId = db
    .select()
    .from(subscriptions)
    .where(like(subscriptions.externalId, `detected:${matchKey}::%`))
    .all()[0]
  // … manual rows match when their name normalizes to the same key.
  const row =
    byId ??
    db
      .select()
      .from(subscriptions)
      .all()
      .find((s) => normalizeMerchant(s.name) === matchKey)
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    cost: row.cost,
    cadence: row.cadence,
    status: row.status,
    nextRenewal: row.nextRenewal,
    cancelUrl: row.cancelUrl
  }
}

// Field length caps + string/url validators are shared with places.ts (the
// two namespaces edit the same table).
function cleanMeta(v: unknown, existing: MerchantMeta | null): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'object') throw new Error('merchants:update: meta must be an object')
  const input = v as { support?: { email?: unknown; phone?: unknown } }
  const next: MerchantMeta = { ...(existing ?? {}) }
  if ('support' in input) {
    if (input.support === null || input.support === undefined) {
      next.support = undefined
    } else {
      const email = cleanString(input.support.email, 200)
      const phone = cleanString(input.support.phone, 50)
      const support: MerchantMeta['support'] = {}
      if (email) support.email = email
      if (phone) support.phone = phone
      next.support = Object.keys(support).length > 0 ? support : undefined
    }
  }
  const hasContent = next.support || next.enrichment
  return hasContent ? JSON.stringify(next) : null
}

export function registerMerchantsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('merchants:list-tracked', (): TrackedMerchant[] => {
    const db = getDb()
    const rows = db
      .select()
      .from(places)
      .where(eq(places.kind, 'merchant'))
      .orderBy(desc(places.updatedAt))
      .all()
    const keyed = rows.map((r) => ({ row: r, matchKey: matchKeyForPlace(r.externalId, r.name) }))
    const live = liveStatsFor(keyed.map((k) => k.matchKey))
    return keyed.map(({ row, matchKey }) => ({
      ...rowToRecord(row),
      matchKey,
      meta: parseMeta<MerchantMeta>(row.meta),
      live: live.get(matchKey) ?? null
    }))
  })

  ipcMain.handle('merchants:profile', (_event, id: number): MerchantProfile => {
    if (!Number.isInteger(id)) throw new Error('merchants:profile requires an integer id')
    const db = getDb()
    const row = db.select().from(places).where(eq(places.id, id)).all()[0]
    if (!row) throw new Error('merchants:profile: not found')
    const matchKey = matchKeyForPlace(row.externalId, row.name)

    const slim = loadSlimTxns(matchKey)
    const stats = computeMerchantStats(slim)
    const inDominant = slim.filter((t) => (t.currency || 'USD') === stats.currency)

    const transactions = (
      matchKey
        ? getRawSqlite()
            .prepare(
              `SELECT id, date, amount, currency, description, category, tax_tag AS taxTag
                 FROM finance_transactions WHERE normalized_merchant = ?
                ORDER BY date DESC, id DESC LIMIT ${TXN_LIST_LIMIT}`
            )
            .all(matchKey)
        : []
    ) as MerchantTxnListItem[]

    // Cross-source activity: email receipts, PayPal history, media — the
    // timeline hits for this merchant's name, minus ledger rows (see
    // FINANCE_SOURCES) which the transaction list already covers.
    const activity: MerchantActivityHit[] = searchRecords(getRawSqlite(), {
      q: row.name,
      limit: ACTIVITY_LIMIT * 2
    })
      .filter((h) => !FINANCE_SOURCES.has(h.source))
      .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))
      .slice(0, ACTIVITY_LIMIT)
      .map((h) => ({
        recordId: h.id,
        source: h.source,
        type: h.type,
        title: h.title,
        occurredAt: h.occurredAt
      }))

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
        and(eq(documentLinks.targetKind, 'merchant'), eq(documentLinks.targetId, row.externalId))
      )
      .all()

    return {
      place: { ...rowToRecord(row), meta: parseMeta<MerchantMeta>(row.meta) },
      matchKey,
      stats,
      monthly: computeMonthlyBuckets(inDominant),
      priceTrend: computePriceTrend(inDominant),
      transactions,
      activity,
      subscription: findLinkedSubscription(matchKey),
      documents: docs,
      tax: computeTaxSummary(inDominant)
    }
  })

  ipcMain.handle('merchants:update', (_event, id: number, patch: MerchantUpdatePatch) => {
    if (!Number.isInteger(id)) throw new Error('merchants:update requires an integer id')
    if (!patch || typeof patch !== 'object') throw new Error('merchants:update: patch required')
    const db = getDb()
    const row = db.select().from(places).where(eq(places.id, id)).all()[0]
    if (!row) throw new Error('merchants:update: not found')

    const updates: Partial<PlaceRow> = {}
    const name = cleanString(patch.name, MAX_LEN.name)
    // A merchant can't be nameless; dropping the name entirely is rejected
    // rather than silently keeping the old one.
    if (name === null) throw new Error('merchants:update: name cannot be empty')
    if (name !== undefined) updates.name = name
    const category = cleanString(patch.category, MAX_LEN.category)
    if (category !== undefined) updates.category = category
    const address = cleanString(patch.address, MAX_LEN.address)
    if (address !== undefined) updates.address = address
    const url = cleanUrl(patch.url)
    if (url !== undefined) updates.url = url
    const notes = cleanString(patch.notes, MAX_LEN.notes)
    if (notes !== undefined) updates.notes = notes
    const meta = cleanMeta(patch.meta, parseMeta<MerchantMeta>(row.meta))
    if (meta !== undefined) updates.meta = meta

    if (Object.keys(updates).length === 0) return { success: true }
    updates.updatedAt = new Date()
    db.update(places).set(updates).where(eq(places.id, id)).run()
    return { success: true }
  })

  // Untrack = delete the owned row AND clear the projection row's promoted
  // flags inline (see clearPromotedFlags in places.ts) — refreshDerivedEntities
  // recomputes them from owned tables, but that only runs on the next import;
  // without this the merchant would stay hidden from Discovered until then.
  ipcMain.handle('merchants:untrack', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('merchants:untrack requires an integer id')
    const db = getDb()
    const row = db.select().from(places).where(eq(places.id, id)).all()[0]
    if (!row) return { success: true }
    db.delete(places).where(eq(places.id, id)).run()
    clearPromotedFlags(db, row.externalId)
    return { success: true }
  })
}
