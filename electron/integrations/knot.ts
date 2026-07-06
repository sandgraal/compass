/**
 * Knot integration (Phase 10.9) — the seventh relay-fronted aggregator and the last on
 * the roadmap. Knot's **TransactionLink** returns SKU-level order history (the real line
 * items, not just the card charge) from merchants like Amazon, Walmart, DoorDash, Uber,
 * Instacart, etc.
 *
 * COMPLETES-A-FEATURE: the **commerce / purchase timeline**. The static Amazon order
 * recognizer (`electron/lib/amazon.ts`) opened this `records` thread from a dropped CSV;
 * Knot makes it LIVE and multi-merchant, writing one timeline record per ordered item
 * through the SAME `upsertLiveRecords` writer Terra uses — ZERO records-engine change.
 * Merchant purchases are LOW-sensitivity (records-readable per the AI boundary), so this
 * is the FIRST relay aggregator whose data lands ON the AI spine (contrast Terra/Argyle/
 * Arcadia/Metriport, whose sensitive data stays in dedicated aggregates-only tables).
 *
 * Managed-only (Knot has no consumer dev accounts) → always through the relay, which
 * holds the paid HTTP-Basic key. `normalizeKnotTransactions` is PURE so it unit-tests
 * without any network. FORMAT CAVEAT: the transaction shapes follow the documented REST
 * API but are **unvalidated against a real pull** — sharpen the field paths when one
 * lands (same caveat as Canopy/Argyle). The connect network path is structural (relay
 * mints the SDK session) and, like every relay aggregator, is not test-exercised.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import { upsertLiveRecords } from '../ipc/records'
import { parseWhen } from '../lib/dates'
import type { RecordInput } from '../lib/recognizers'
import type { SqliteForFx } from './finance-fx'
import { relayFetch, resolveRelayConfig } from './relay-client'

// ── pure helpers ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}
/** A money value Knot returns as a number or a numeric string → number | null. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '')
    if (!cleaned || cleaned === '-' || cleaned === '.') return null
    const n = Number.parseFloat(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}
/** Format an amount + optional currency for the record body, or undefined if absent. */
function formatMoney(amount: number | null, currency: string | null): string | undefined {
  if (amount == null) return undefined
  const n = amount.toFixed(2)
  return currency ? `${n} ${currency}` : n
}

/** The transactions array, tolerating Knot's `{transactions:[…]}` or a bare array. */
function transactionsOf(json: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(json) ? json : (get(json, 'transactions') ?? get(json, 'data'))
  return Array.isArray(arr)
    ? (arr.filter((t) => t && typeof t === 'object') as Record<string, unknown>[])
    : []
}

/** Resolve a merchant's display name + a stable id from a txn (object or scalar shape). */
function merchantOf(txn: Record<string, unknown>): { id: string; name: string } {
  const m = txn.merchant
  if (m && typeof m === 'object') {
    const id = str(get(m, 'id')) ?? str(get(m, 'merchant_id')) ?? ''
    const name = str(get(m, 'name')) ?? 'Merchant'
    return { id: id || name, name }
  }
  const scalar = str(m) ?? str(txn.merchant_name) ?? str(txn.merchant_id)
  return { id: scalar ?? 'merchant', name: scalar ?? 'Merchant' }
}

/**
 * Knot transactions JSON → one `records` row per ordered line item (mirrors the Amazon
 * recognizer's one-record-per-item shape). Orders with no itemized products still emit a
 * single order-level row so the purchase is not lost. `source:'knot'`, `type:'order'`.
 */
export function normalizeKnotTransactions(json: unknown): RecordInput[] {
  const out: RecordInput[] = []
  for (const txn of transactionsOf(json)) {
    const orderId = str(txn.id) ?? str(txn.external_id) ?? str(txn.order_id)
    if (!orderId) continue
    const { id: merchantId, name: merchantName } = merchantOf(txn)
    const occurredAt = parseWhen(str(txn.datetime) ?? str(txn.date) ?? str(txn.order_date) ?? '')
    const currency = str(get(txn, 'price', 'currency')) ?? str(txn.currency)
    const products = get(txn, 'products')
    const items = Array.isArray(products)
      ? (products.filter((p) => p && typeof p === 'object') as Record<string, unknown>[])
      : []

    if (items.length === 0) {
      // Order-level row (no SKU detail available).
      const total = num(get(txn, 'price', 'total')) ?? num(txn.total)
      out.push({
        source: 'knot',
        type: 'order',
        occurredAt,
        title: `Order at ${merchantName}`,
        body: formatMoney(total, currency),
        payload: { merchant: merchantName, merchantId, orderId },
        naturalKey: `${merchantId}|${orderId}`
      })
      continue
    }

    items.forEach((p, i) => {
      const name = str(p.name) ?? str(p.title) ?? str(p.description) ?? `Item ${i + 1}`
      const unit =
        num(get(p, 'price', 'total')) ?? num(get(p, 'price', 'unit_price')) ?? num(p.price)
      const qty = num(p.quantity)
      out.push({
        source: 'knot',
        type: 'order',
        occurredAt,
        title: `${name} — ${merchantName}`,
        body: formatMoney(unit, currency),
        payload: { merchant: merchantName, merchantId, orderId, quantity: qty, url: str(p.url) },
        // Key on (merchant, order, line-index, name) so re-syncs of the same historical
        // order dedupe per item — the line order within a fixed order id is stable.
        naturalKey: `${merchantId}|${orderId}|${i}|${name}`
      })
    })
  }
  return out
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type KnotToken = {
  externalUserId?: string // stable per-install user id sent to Knot
  merchants?: string[] // connected merchant ids to sync
  cursors?: Record<string, string> // per-merchant incremental sync cursor
}

const KNOT_SUCCESS_URL = 'https://compass.app/knot/success' // sentinel we intercept, never load
const KNOT_SUCCESS = new URL(KNOT_SUCCESS_URL) // parsed once for exact origin+path matching
const MAX_PAGES = 20 // per-merchant pagination guard (each page ≤ ~100 txns)

function loadKnotToken(): KnotToken {
  return (loadToken('knot') as KnotToken | null) ?? {}
}

/**
 * Pull each connected merchant's transactions → the purchase `records` timeline.
 * Paginates `/transactions/sync` via the request-body cursor and persists the final
 * cursor per merchant so the next run is incremental.
 */
export async function syncKnot(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadKnotToken()
  if (!tok.externalUserId || !tok.merchants?.length)
    return { service: 'knot', success: false, error: 'Knot not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'knot', () => null)

  let recordsUpdated = 0
  const cursors: Record<string, string> = { ...(tok.cursors ?? {}) }
  try {
    for (const merchant of tok.merchants) {
      let cursor: string | null = cursors[merchant] ?? null
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await relayFetch(cfg, 'knot', 'POST', '/transactions/sync', {
          body: JSON.stringify({
            merchant,
            external_user_id: tok.externalUserId,
            ...(cursor ? { cursor } : {})
          })
        })
        if (!res.ok) throw new Error(`Knot transactions/sync → HTTP ${res.status}`)
        const pageJson = (await res.json()) as {
          next_cursor?: string
          has_more?: boolean
        }
        const recs = normalizeKnotTransactions(pageJson)
        if (recs.length > 0) recordsUpdated += upsertLiveRecords(recs, 'knot').imported
        cursor = str(pageJson.next_cursor) ?? cursor
        if (!pageJson.has_more) break
      }
      if (cursor) cursors[merchant] = cursor
    }
    // Persist advanced cursors for the next incremental run.
    saveToken('knot', { ...loadKnotToken(), cursors })

    db.insert(integrations)
      .values({
        service: 'knot',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'knot'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', { service: 'knot', status: 'done', recordsUpdated })
    return { service: 'knot', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'knot', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'knot'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'knot',
      status: 'error',
      error: message
    })
    return { service: 'knot', success: false, error: message }
  }
}

/**
 * Open the Knot connect experience in a sandboxed modal window. Knot's flow is a
 * client-side SDK initialized with a session id; when the relay fronts a hosted connect
 * page it returns that page's `url`, which we open here. On the success redirect we
 * capture the connected merchant id (charset-validated) and add it to the sync set.
 *
 * A stable `external_user_id` is generated + persisted on first connect (it keys every
 * subsequent transaction pull). Hardened like the other connects: exact origin+pathname
 * redirect match + `^[0-9A-Za-z_-]+$` merchant-id validation.
 *
 * CAVEAT: the connect network path is structural (needs a deployed relay that returns a
 * hosted session URL); it is not test-exercised.
 */
export async function openKnotConnect(
  sqlite: SqliteForFx,
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const existing = loadKnotToken()
  const externalUserId = existing.externalUserId ?? randomUUID()
  if (!existing.externalUserId) saveToken('knot', { ...existing, externalUserId })
  const cfg = resolveRelayConfig(sqlite, 'knot', () => null)

  let connectUrl: string
  try {
    const res = await relayFetch(cfg, 'knot', 'POST', '/session/create', {
      body: JSON.stringify({ type: 'transaction_link', external_user_id: externalUserId })
    })
    if (!res.ok) throw new Error(`Knot session → HTTP ${res.status}`)
    const session = (await res.json()) as { session?: string; url?: string }
    // The Knot Web SDK is initialized with `session` client-side; when the relay fronts a
    // hosted connect page it returns its `url`. We require that hosted URL rather than
    // fabricate a host (the raw SDK step would be a separate follow-up).
    const url = str(session.url)
    if (!url)
      throw new Error(
        'Knot session created but no hosted connect URL was returned (the Knot Web SDK step is a follow-up).'
      )
    connectUrl = url
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Connect Knot',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'knot-connect'
      }
    })
    let settled = false
    const finish = (result: { success: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }
    const onNavigate = (e: Electron.Event, url: string): void => {
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return
      }
      // Exact origin+pathname match — `startsWith` would also fire on e.g. `/knot/successful…`.
      if (target.origin !== KNOT_SUCCESS.origin || target.pathname !== KNOT_SUCCESS.pathname) return
      e.preventDefault()
      const merchant = target.searchParams.get('merchant') ?? ''
      // Knot merchant ids are integers; validate against the relay allowlist charset
      // before storing — it's sent straight back in the sync request body.
      if (!/^[0-9A-Za-z_-]+$/.test(merchant)) {
        finish({ success: false, error: 'Knot returned no valid merchant id' })
        return
      }
      const cur = loadKnotToken()
      const merchants = Array.from(new Set([...(cur.merchants ?? []), merchant]))
      saveToken('knot', { ...cur, merchants })
      finish({ success: true })
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(connectUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}
