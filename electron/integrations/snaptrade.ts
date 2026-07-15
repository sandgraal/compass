/**
 * SnapTrade integration (Phase 10.9) — the fourth aggregator, and the first **BYO-direct**
 * one (no relay). SnapTrade ("Plaid for brokerages") connects Robinhood/Schwab/Fidelity/
 * E*TRADE/etc. and returns real positions. Per the Hybrid access model, self-servable
 * aggregators stay BYO/local — SnapTrade's auth is a per-request HMAC signature that
 * doesn't fit the relay's static header injection, and its partner keys are self-serve
 * (free dev tier), so Compass calls SnapTrade DIRECTLY with the user's own credentials
 * (like Plaid/SimpleFIN). It completes the holdings → net-worth feature that today relies
 * on the unvalidated brokerage-CSV importer (`finance-holdings.ts`).
 *
 * AUTH: every request is signed — `Signature: base64(HMAC-SHA256(consumerKey, C))` where
 * C = JSON of `{content, path, query}` with sorted keys (content = the request body or
 * null). `clientId` + `timestamp` are query params; most calls also carry `userId` +
 * `userSecret`. Confirmed against https://docs.snaptrade.com (the SDK does the same).
 *
 * PRIVACY: holdings feed net worth (records-snapshot, like the CSV importer). The partner
 * `consumerKey` + per-user `userSecret` are SECRETS — stored via the encrypted token store
 * (safeStorage), never in app_settings or exports. FORMAT CAVEAT: position shapes follow
 * the documented API but are **unvalidated against a real account** — sharpen when one lands.
 */

import { createHmac, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import { type ParsedHolding, SNAPTRADE_SOURCE, importHoldings } from './finance-holdings'

// ── pure helpers ──────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^0-9.\-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}
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

// ── request signing (pure, testable) ────────────────────────────────────────────

/** Recursively key-sorted JSON — SnapTrade signs the canonical (sorted) form. */
function stableStringify(value: unknown): string {
  // Mirror JSON.stringify semantics for `undefined` so the SIGNED shape equals the
  // SENT shape (the body goes out via JSON.stringify): a standalone/array undefined
  // becomes null; an object key whose value is undefined is OMITTED, not null.
  if (value === undefined || value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * The exact content SnapTrade signs: `{content, path, query}` with sorted keys.
 * `content` is the request body object (POST) or null (GET). Pure — the signature
 * bug surface (key order, null handling) is fully unit-testable from this.
 */
export function buildSignedContent(path: string, query: string, content: unknown = null): string {
  return stableStringify({ content: content ?? null, path, query })
}

/** SnapTrade request signature: base64(HMAC-SHA256(consumerKey, signedContent)). */
export function signSnaptrade(
  consumerKey: string,
  path: string,
  query: string,
  content: unknown = null
): string {
  return createHmac('sha256', consumerKey)
    .update(buildSignedContent(path, query, content), 'utf8')
    .digest('base64')
}

// ── holdings normalization (pure, testable) ─────────────────────────────────────

export type SnaptradeHolding = {
  symbol: string
  description: string | null
  units: number
  price: number | null
  value: number | null // market value (units × price, or a provided value)
  costBasis: number | null // average purchase price × units
  currency: string
  account: string | null
}

/** Pull the ticker out of SnapTrade's deeply-nested symbol object (several shapes). */
function tickerOf(pos: Record<string, unknown>): string | null {
  return (
    str(get(pos, 'symbol', 'symbol', 'symbol')) ?? // universal-symbol nesting
    str(get(pos, 'symbol', 'symbol', 'raw_symbol')) ??
    str(get(pos, 'symbol', 'raw_symbol')) ??
    str(get(pos, 'symbol', 'symbol')) ??
    str(get(pos, 'symbol'))
  )
}
function currencyOf(pos: Record<string, unknown>): string {
  return (
    str(get(pos, 'symbol', 'symbol', 'currency', 'code')) ??
    str(get(pos, 'currency', 'code')) ??
    'USD'
  )
}
function descriptionOf(pos: Record<string, unknown>): string | null {
  return str(get(pos, 'symbol', 'symbol', 'description')) ?? str(get(pos, 'symbol', 'description'))
}

/** A SnapTrade holdings response may be one account object or an array of them. */
function accountsOf(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json))
    return json.filter((a) => a && typeof a === 'object') as Record<string, unknown>[]
  if (json && typeof json === 'object') return [json as Record<string, unknown>]
  return []
}

/** SnapTrade holdings JSON → neutral holding rows (ticker, units, price, value, cost basis). */
export function normalizeSnaptradeHoldings(json: unknown): SnaptradeHolding[] {
  const out: SnaptradeHolding[] = []
  for (const acct of accountsOf(json)) {
    const accountId =
      str(get(acct, 'account', 'id')) ??
      str(get(acct, 'account', 'number')) ??
      str(get(acct, 'account', 'name')) ??
      str(get(acct, 'id'))
    const positions = get(acct, 'positions')
    if (!Array.isArray(positions)) continue
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object') continue
      const pos = raw as Record<string, unknown>
      const symbol = tickerOf(pos)
      const units = num(pos.units) ?? num(pos.fractional_units)
      if (!symbol || units == null) continue
      const price = num(pos.price)
      const avg = num(pos.average_purchase_price) ?? num(get(pos, 'average_purchase_price'))
      out.push({
        symbol,
        description: descriptionOf(pos),
        units,
        price,
        value: price != null ? Math.round(units * price * 100) / 100 : num(pos.market_value),
        costBasis: avg != null ? Math.round(avg * units * 100) / 100 : null,
        currency: currencyOf(pos),
        account: accountId
      })
    }
  }
  return out
}

/** Map SnapTrade holdings to the shared `ParsedHolding` shape the net-worth store reads. */
export function snaptradeHoldingsToParsed(holdings: SnaptradeHolding[]): ParsedHolding[] {
  return holdings.map((h) => ({
    // Uppercase like the CSV + Plaid-Investments importers — `importHoldings` dedups
    // by symbol, so mixed-case would split one position into two snapshots.
    symbol: h.symbol.toUpperCase(),
    description: h.description,
    quantity: h.units,
    price: h.price,
    marketValue: h.value,
    costBasis: h.costBasis,
    account: h.account
  }))
}

/** Local-day 'YYYY-MM-DD' (stored snapshot dates are local-day, like the CSV importer). */
function localDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// ── credentials (encrypted BYO — partner key + per-user secret) ─────────────────

type SnaptradeToken = {
  clientId?: string
  consumerKey?: string // SECRET — signs every request
  userId?: string
  userSecret?: string // SECRET — per connected user
}

function loadSnaptradeToken(): SnaptradeToken {
  return (loadToken('snaptrade') as SnaptradeToken | null) ?? {}
}

/** Store the user's own SnapTrade partner credentials (encrypted via safeStorage). */
export function setSnaptradeByoCreds(clientId: string, consumerKey: string): void {
  saveToken('snaptrade', {
    ...loadSnaptradeToken(),
    clientId: clientId.trim(),
    consumerKey: consumerKey.trim()
  })
}

/** True once partner credentials are present (the connect flow can then run). */
export function hasSnaptradeCreds(): boolean {
  const t = loadSnaptradeToken()
  return !!(t.clientId && t.consumerKey)
}

/**
 * Forget the connected user (disconnect) while preserving the partner
 * clientId/consumerKey — mirrors Plaid's split between dev keys and per-item
 * access tokens. Unlike the generic auth:disconnect (which wipes the whole
 * 'snaptrade' token blob), this only drops the connection-derived
 * userId/userSecret, so reconnecting doesn't force re-entering BYO creds.
 */
export function clearSnaptradeConnection(): void {
  const tok = loadSnaptradeToken()
  saveToken('snaptrade', { clientId: tok.clientId, consumerKey: tok.consumerKey })
}

// ── signed fetch + connect + sync (impure; BYO-direct, no relay) ────────────────

const SNAPTRADE_BASE = 'https://api.snaptrade.com'
const SNAPTRADE_SUCCESS_URL = 'https://compass.app/snaptrade/success' // sentinel we intercept
const SNAPTRADE_SUCCESS = new URL(SNAPTRADE_SUCCESS_URL)

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Fire a signed SnapTrade request. `clientId` + `timestamp` are always appended; the
 * SAME query string is both signed and sent (so the server's recomputed signature
 * matches). GETs sign `content:null`; POSTs sign the body object.
 */
async function snaptradeFetch(
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; now?: number } = {}
): Promise<Response> {
  const tok = loadSnaptradeToken()
  if (!tok.clientId || !tok.consumerKey) throw new Error('SnapTrade credentials not set')
  const now = opts.now ?? Date.now()
  const params = new URLSearchParams({
    clientId: tok.clientId,
    ...(opts.query ?? {}),
    timestamp: String(Math.floor(now / 1000))
  })
  const query = params.toString()
  const body = opts.body ?? null
  const signature = signSnaptrade(tok.consumerKey, path, query, body)
  return fetch(`${SNAPTRADE_BASE}${path}?${query}`, {
    method,
    headers: { 'content-type': 'application/json', Signature: signature },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
    redirect: 'manual'
  })
}

/**
 * Open the SnapTrade Connection Portal in a sandboxed modal window. Registers the
 * end-user first (storing the per-user `userSecret`) if needed, then mints a portal
 * login URL with a sentinel `customRedirect` we intercept on exact origin+pathname.
 *
 * CAVEAT: the connect network path is structural, not test-exercised — needs real
 * SnapTrade partner credentials.
 */
export async function openSnaptradeConnect(
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  if (!hasSnaptradeCreds()) {
    return { success: false, error: 'Enter your SnapTrade clientId + consumerKey first' }
  }
  let { userId, userSecret } = loadSnaptradeToken()
  try {
    if (!userId || !userSecret) {
      userId = userId ?? `compass-${randomUUID()}`
      const regRes = await snaptradeFetch('POST', '/api/v1/snapTrade/registerUser', {
        body: { userId }
      })
      if (!regRes.ok) throw new Error(`SnapTrade registerUser → HTTP ${regRes.status}`)
      const reg = (await regRes.json()) as { userId?: string; userSecret?: string }
      userId = str(reg.userId) ?? userId
      userSecret = str(reg.userSecret) ?? undefined
      if (!userSecret) throw new Error('SnapTrade did not return a userSecret')
      saveToken('snaptrade', { ...loadSnaptradeToken(), userId, userSecret })
    }
    const loginRes = await snaptradeFetch('POST', '/api/v1/snapTrade/login', {
      query: { userId, userSecret, customRedirect: SNAPTRADE_SUCCESS_URL }
    })
    if (!loginRes.ok) throw new Error(`SnapTrade login → HTTP ${loginRes.status}`)
    const login = (await loginRes.json()) as { redirectURI?: string }
    const portalUrl = str(login.redirectURI)
    if (!portalUrl) throw new Error('SnapTrade did not return a connection portal URL')
    return await openPortalWindow(parent, portalUrl)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function openPortalWindow(
  parent: BrowserWindow | null,
  portalUrl: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Connect your brokerage (SnapTrade)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'snaptrade-connect'
      }
    })
    // Deny popups — a connect page should never spawn child windows (mirrors the
    // CRED sandbox). Keeps the isolation model intact against unexpected navigations.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
      // Exact origin+pathname match — never a `startsWith` (would also fire on siblings).
      if (
        target.origin !== SNAPTRADE_SUCCESS.origin ||
        target.pathname !== SNAPTRADE_SUCCESS.pathname
      ) {
        return
      }
      e.preventDefault()
      finish({ success: true }) // userSecret already stored; a sync pulls the holdings
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(portalUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}

/** Pull every connected account's holdings → snapshot into the net-worth store. */
export async function syncSnaptrade(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadSnaptradeToken()
  if (!tok.clientId || !tok.consumerKey) {
    return { service: 'snaptrade', success: false, error: 'SnapTrade credentials not set' }
  }
  if (!tok.userId || !tok.userSecret) {
    return { service: 'snaptrade', success: false, error: 'SnapTrade not connected' }
  }

  let recordsUpdated = 0
  try {
    const userQuery = { userId: tok.userId, userSecret: tok.userSecret }
    const acctRes = await snaptradeFetch('GET', '/api/v1/accounts', { query: userQuery })
    if (!acctRes.ok) throw new Error(`SnapTrade accounts → HTTP ${acctRes.status}`)
    const accounts = (await acctRes.json()) as Array<{ id?: string }>
    const holdingsResponses: unknown[] = []
    for (const a of Array.isArray(accounts) ? accounts : []) {
      const id = str(a?.id)
      if (!id) continue
      const hRes = await snaptradeFetch(
        'GET',
        `/api/v1/accounts/${encodeURIComponent(id)}/holdings`,
        { query: userQuery }
      )
      if (hRes.ok) holdingsResponses.push(await hRes.json())
    }
    const holdings = snaptradeHoldingsToParsed(normalizeSnaptradeHoldings(holdingsResponses))
    const { imported } = importHoldings(
      db,
      holdings,
      localDay(new Date()),
      'snaptrade',
      SNAPTRADE_SOURCE
    )
    recordsUpdated = imported

    db.insert(integrations)
      .values({
        service: 'snaptrade',
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
      .where(eq(integrations.service, 'snaptrade'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'snaptrade',
      status: 'done',
      recordsUpdated
    })
    return { service: 'snaptrade', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'snaptrade', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'snaptrade'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'snaptrade',
      status: 'error',
      error: message
    })
    return { service: 'snaptrade', success: false, error: message }
  }
}
