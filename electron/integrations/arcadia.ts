/**
 * Arcadia integration (Phase 10.9) — utility-bill aggregator (125+ US utilities), the
 * fifth relay-fronted aggregator. Arcadia ("Plug") returns utility statements; we store
 * them in the dedicated `utility_bills` table (OFF the records/finance_transactions spine —
 * statements aren't cash transactions, so this avoids double-counting the bank payment and
 * keeps the service address off the AI timeline). `finance-property.ts` reads them as the
 * utilities operating-expense line for the connected rental (matched by service address).
 *
 * Managed-only (Arcadia has no consumer dev accounts) → always through the relay, which
 * holds the OAuth client credentials and exchanges the short-lived bearer (see the relay's
 * `tokenAuth` + `TokenCache`). `normalizeArcadiaStatements` is PURE (unit-tested, no network).
 * FORMAT CAVEAT: statement shapes follow the documented Plug API but are **unvalidated
 * against a real account** — sharpen the field paths when one lands.
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { integrations, syncEvents, utilityBills } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import type { SqliteForFx } from './finance-fx'
import { relayFetch, resolveRelayConfig } from './relay-client'

// ── pure helpers ──────────────────────────────────────────────────────────────

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
function day(v: unknown): string | null {
  const s = str(v)
  return s ? s.slice(0, 10) : null
}

export type UtilityBillRow = {
  externalId: string
  provider: string | null
  serviceAddress: string | null
  statementDate: string | null
  periodStart: string | null
  periodEnd: string | null
  amount: number | null
  currency: string
  usageKwh: number | null
}

/** Assemble a human-readable service address from Arcadia's object or string shapes. */
function addressOf(s: Record<string, unknown>): string | null {
  const direct = str(s.serviceAddress) ?? str(s.service_address) ?? str(s.address)
  if (direct) return direct
  const addr = (get(s, 'serviceAddress') ?? get(s, 'address')) as
    | Record<string, unknown>
    | undefined
  if (!addr || typeof addr !== 'object') return null
  const parts = [
    str(addr.line1) ?? str(addr.street),
    str(addr.city),
    str(addr.state) ?? str(addr.region),
    str(addr.postalCode) ?? str(addr.zip)
  ].filter((p): p is string => !!p)
  return parts.length ? parts.join(', ') : null
}

function statementsOf(json: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(json)
    ? json
    : (get(json, 'results') ?? get(json, 'statements') ?? get(json, 'data'))
  return Array.isArray(arr)
    ? (arr.filter((s) => s && typeof s === 'object') as Record<string, unknown>[])
    : []
}

/** Arcadia Plug statements JSON → dedup-keyed utility-bill rows. */
export function normalizeArcadiaStatements(json: unknown): UtilityBillRow[] {
  const out: UtilityBillRow[] = []
  for (const s of statementsOf(json)) {
    const id = str(s.id) ?? str(s.statementId)
    if (!id) continue
    const period = (get(s, 'servicePeriod') ?? get(s, 'service_period') ?? {}) as Record<
      string,
      unknown
    >
    const amount =
      num(s.totalAmountDue) ?? num(s.amount) ?? num(get(s, 'total', 'amount')) ?? num(s.amountDue)
    out.push({
      externalId: `arcadia:${id}`,
      provider:
        str(get(s, 'utilityProvider', 'name')) ??
        str(s.provider) ??
        str(get(s, 'provider', 'name')) ??
        str(s.utilityName),
      serviceAddress: addressOf(s),
      // The expense date the property P&L buckets by year.
      statementDate: day(s.statementDate ?? s.statement_date ?? get(period, 'endDate')),
      periodStart: day(get(period, 'startDate') ?? get(period, 'start_date') ?? s.period_start),
      periodEnd: day(get(period, 'endDate') ?? get(period, 'end_date') ?? s.period_end),
      amount: amount != null ? Math.abs(amount) : null,
      currency: str(s.currency) ?? 'USD',
      usageKwh: num(get(s, 'totalUsage', 'value')) ?? num(s.usage) ?? num(get(s, 'usage', 'value'))
    })
  }
  return out
}

/** Upsert utility bills by `external_id` — a re-sync refreshes in place, never duplicates. */
export function upsertUtilityBills(
  db: ReturnType<typeof getDb>,
  rows: UtilityBillRow[],
  now: Date = new Date()
): number {
  let n = 0
  for (const r of rows) {
    const set = {
      provider: r.provider,
      serviceAddress: r.serviceAddress,
      statementDate: r.statementDate,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      amount: r.amount,
      currency: r.currency,
      usageKwh: r.usageKwh,
      ingestedAt: now
    }
    db.insert(utilityBills)
      .values({ externalId: r.externalId, ...set })
      .onConflictDoUpdate({ target: utilityBills.externalId, set })
      .run()
    n++
  }
  return n
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type ArcadiaToken = { connected?: boolean; correlationId?: string }

const ARCADIA_SUCCESS_URL = 'https://compass.app/arcadia/success' // sentinel we intercept
const ARCADIA_SUCCESS = new URL(ARCADIA_SUCCESS_URL)

function loadArcadiaToken(): ArcadiaToken {
  return (loadToken('arcadia') as ArcadiaToken | null) ?? {}
}

/** Pull the connected utility statements → upsert into `utility_bills` → feed the property P&L. */
export async function syncArcadia(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadArcadiaToken()
  if (!tok.connected) return { service: 'arcadia', success: false, error: 'Arcadia not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'arcadia', () => null)

  let recordsUpdated = 0
  try {
    // Scope to this user's linked utilities when a correlationId is known.
    const query = tok.correlationId
      ? `?search=correlationIds==${encodeURIComponent(tok.correlationId)}&page=0&size=100`
      : '?page=0&size=100'
    const res = await relayFetch(cfg, 'arcadia', 'GET', '/plug/statements', { query })
    if (!res.ok) throw new Error(`Arcadia statements → HTTP ${res.status}`)
    recordsUpdated = upsertUtilityBills(db, normalizeArcadiaStatements(await res.json()))

    db.insert(integrations)
      .values({
        service: 'arcadia',
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
      .where(eq(integrations.service, 'arcadia'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'arcadia',
      status: 'done',
      recordsUpdated
    })
    return { service: 'arcadia', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'arcadia', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'arcadia'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'arcadia',
      status: 'error',
      error: message
    })
    return { service: 'arcadia', success: false, error: message }
  }
}

/**
 * Open the Arcadia Connect widget in a sandboxed modal window. Mints a connect session via
 * the relay, opens it, and marks the integration connected on the success redirect (exact
 * origin+pathname match; popups denied). CAVEAT: this network path is structural, not
 * test-exercised — needs a deployed relay + real Arcadia credentials.
 */
export async function openArcadiaConnect(
  sqlite: SqliteForFx,
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const cfg = resolveRelayConfig(sqlite, 'arcadia', () => null)

  let widgetUrl: string
  let correlationId: string | undefined
  try {
    const res = await relayFetch(cfg, 'arcadia', 'POST', '/plug/connect-tokens', {
      body: JSON.stringify({ redirectUrl: ARCADIA_SUCCESS_URL })
    })
    if (!res.ok) throw new Error(`Arcadia connect-token → HTTP ${res.status}`)
    const tok = (await res.json()) as { url?: string; connectUrl?: string; correlationId?: string }
    correlationId = str(tok.correlationId) ?? undefined
    const url = str(tok.url) ?? str(tok.connectUrl)
    if (!url) throw new Error('Arcadia did not return a connect URL')
    widgetUrl = url
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Connect your utilities (Arcadia)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'arcadia-connect'
      }
    })
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
      if (
        target.origin !== ARCADIA_SUCCESS.origin ||
        target.pathname !== ARCADIA_SUCCESS.pathname
      ) {
        return
      }
      e.preventDefault()
      saveToken('arcadia', { ...loadArcadiaToken(), connected: true, correlationId })
      finish({ success: true })
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(widgetUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}
