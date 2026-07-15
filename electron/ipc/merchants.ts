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
import { allMatchKeysForPlace, matchKeyForPlace } from '../lib/merchant-match'
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
import type { PlaceWebEnrichment } from '../lib/place-web-enrichment'
import { searchRecords } from '../lib/records-search'
import {
  MAX_LEN,
  type PlaceRecord,
  cleanString,
  cleanUrl,
  clearAbsorbedAliases,
  clearPromotedFlags,
  parseMeta
} from './places'

/** Namespaced JSON extras on a places row (`places.meta`). */
export interface MerchantMeta {
  support?: { email?: string; phone?: string }
  /**
   * Consent-gated web enrichment — written by the SHARED places surface
   * (electron/ipc/place-web-enrich.ts), which serves both kinds.
   */
  enrichment?: { web?: PlaceWebEnrichment }
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

/**
 * Slim rows for a set of merchant keys (a merchant's primary key plus any
 * merged-in aliases — see `allMatchKeysForPlace`), oldest-first (the
 * aggregates sort anyway).
 */
export function loadSlimTxnsByMerchantKeys(keys: string[]): MerchantSlimTxn[] {
  const unique = [...new Set(keys.filter((k) => k.length > 0))]
  if (unique.length === 0) return []
  return getRawSqlite()
    .prepare(
      `SELECT date, amount, currency, tax_tag AS taxTag, tax_year AS taxYear
         FROM finance_transactions
        WHERE normalized_merchant IN (${unique.map(() => '?').join(', ')})
        ORDER BY date`
    )
    .all(...unique) as MerchantSlimTxn[]
}

/**
 * Slim rows for ONE merchant key. Exported for reuse by `subscriptions:profile`
 * (electron/ipc/subscriptions.ts), which resolves the same merge key via
 * `matchKeyForSubscription` — the exact inverse of `findLinkedSubscription`
 * below — to compute a subscription's "total paid to date" without
 * re-deriving the transaction query. Subscriptions aren't merge-aware (out of
 * scope for the places/merchants merge feature), so this stays single-key.
 */
export function loadSlimTxnsByMerchantKey(matchKey: string): MerchantSlimTxn[] {
  return loadSlimTxnsByMerchantKeys([matchKey])
}

/**
 * Live ledger stats for many merchants in one grouped query. `keysByPlaceId`
 * maps each tracked merchant's `places.id` to its full key set (primary key
 * plus any merged-in aliases) — a merchant can no longer be identified by a
 * single key once merges exist, so this keys off place id rather than key.
 * Places with no matching rows under any of their keys are absent from the
 * result map.
 *
 * A key can map to MORE THAN ONE place id: two tracked merchants can share a
 * match key before they've been merged (e.g. a manual merchant whose
 * normalized name happens to equal another merchant's derived key) — both
 * must keep showing the same live stats until the user merges them, exactly
 * as they did before merge support existed.
 */
function liveStatsFor(
  keysByPlaceId: Map<number, string[]>
): Map<
  number,
  { totalSpend: number; txnCount: number; lastTxnDate: string | null; currency: string }
> {
  const map = new Map<
    number,
    { totalSpend: number; txnCount: number; lastTxnDate: string | null; currency: string }
  >()
  const keyToPlaceIds = new Map<string, number[]>()
  for (const [placeId, keys] of keysByPlaceId) {
    for (const key of keys) {
      if (key.length === 0) continue
      const list = keyToPlaceIds.get(key) ?? []
      list.push(placeId)
      keyToPlaceIds.set(key, list)
    }
  }
  const unique = [...keyToPlaceIds.keys()]
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
  const byPlaceId = new Map<number, MerchantSlimTxn[]>()
  for (const row of rows) {
    const placeIds = keyToPlaceIds.get(row.key)
    if (!placeIds) continue
    for (const placeId of placeIds) {
      const txns = byPlaceId.get(placeId) ?? []
      txns.push(row)
      byPlaceId.set(placeId, txns)
    }
  }
  for (const [placeId, txns] of byPlaceId) {
    const stats = computeMerchantStats(txns)
    map.set(placeId, {
      totalSpend: stats.totalSpend,
      txnCount: stats.txnCount,
      lastTxnDate: stats.lastTxnDate,
      currency: stats.currency
    })
  }
  return map
}

/**
 * The subscription this merchant bills as, when one is tracked — tried across
 * every key the merchant resolves to (primary key first), so a subscription
 * linked under a pre-merge key still shows as linked after the merge.
 */
function findLinkedSubscription(keys: string[]): MerchantProfile['subscription'] {
  const validKeys = keys.filter((k) => k.length > 0)
  if (validKeys.length === 0) return null
  const db = getDb()
  // Detected/materialized rows carry the merchant key in their external id …
  let row: typeof subscriptions.$inferSelect | undefined
  for (const matchKey of validKeys) {
    row = db
      .select()
      .from(subscriptions)
      .where(like(subscriptions.externalId, `detected:${matchKey}::%`))
      .all()[0]
    if (row) break
  }
  // … manual rows match when their name normalizes to one of the keys.
  if (!row) {
    const keySet = new Set(validKeys)
    row = db
      .select()
      .from(subscriptions)
      .all()
      .find((s) => keySet.has(normalizeMerchant(s.name)))
  }
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
    const sqlite = getRawSqlite()
    const rows = db
      .select()
      .from(places)
      .where(eq(places.kind, 'merchant'))
      .orderBy(desc(places.updatedAt))
      .all()
    const keyed = rows.map((r) => {
      const matchKey = matchKeyForPlace(r.externalId, r.name)
      return { row: r, matchKey, keys: allMatchKeysForPlace(sqlite, r.id, matchKey, 'merchant') }
    })
    const live = liveStatsFor(new Map(keyed.map((k) => [k.row.id, k.keys])))
    return keyed.map(({ row, matchKey }) => ({
      ...rowToRecord(row),
      matchKey,
      meta: parseMeta<MerchantMeta>(row.meta),
      live: live.get(row.id) ?? null
    }))
  })

  ipcMain.handle('merchants:profile', (_event, id: number): MerchantProfile => {
    if (!Number.isInteger(id)) throw new Error('merchants:profile requires an integer id')
    const db = getDb()
    const row = db.select().from(places).where(eq(places.id, id)).all()[0]
    if (!row) throw new Error('merchants:profile: not found')
    const matchKey = matchKeyForPlace(row.externalId, row.name)
    const keys = allMatchKeysForPlace(getRawSqlite(), id, matchKey, 'merchant')

    const slim = loadSlimTxnsByMerchantKeys(keys)
    const stats = computeMerchantStats(slim)
    const inDominant = slim.filter((t) => (t.currency || 'USD') === stats.currency)

    const validKeys = keys.filter((k) => k.length > 0)
    const transactions = (
      validKeys.length > 0
        ? getRawSqlite()
            .prepare(
              `SELECT id, date, amount, currency, description, category, tax_tag AS taxTag
                 FROM finance_transactions WHERE normalized_merchant IN (${validKeys.map(() => '?').join(', ')})
                ORDER BY date DESC, id DESC LIMIT ${TXN_LIST_LIMIT}`
            )
            .all(...validKeys)
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
      subscription: findLinkedSubscription(keys),
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
    clearAbsorbedAliases(db, 'merchant', id)
    return { success: true }
  })
}
