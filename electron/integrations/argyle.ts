/**
 * Argyle integration (Phase 10.9) — the third relay-fronted aggregator, feeding the
 * cash-flow forecast. Argyle ("Plaid for payroll") returns real paystubs; we store the
 * adequacy-relevant fields in the dedicated `argyle_paystubs` table (OFF the `records`
 * spine — payroll is aggregates-only at the AI/MCP boundary) and the forecast prefers
 * this ground-truth income over bank-deposit inference (`finance-income.ts`).
 *
 * Managed-only (Argyle has no consumer dev accounts) → always through the relay, which
 * holds the paid Basic-auth key. `normalizeArgylePaystubs` is PURE so it unit-tests
 * without any network. FORMAT CAVEAT: the paystub shapes follow the documented REST API
 * but are **unvalidated against a real pull** — sharpen the field paths when one lands.
 *
 * PRIVACY: only summed withholding / deductions are kept (for the effective-rate
 * summary) — never the per-tax breakdown, account numbers, or SSN.
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { argylePaystubs, integrations, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import type { SqliteForFx } from './finance-fx'
import { relayFetch, resolveRelayConfig } from './relay-client'

// ── pure helpers ──────────────────────────────────────────────────────────────

/** Parse a money value that Argyle returns as a string ("1234.56") or number. */
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
/** Slice any date-ish string to a local-day 'YYYY-MM-DD' (stored dates are local-day). */
function day(v: unknown): string | null {
  const s = str(v)
  return s ? s.slice(0, 10) : null
}
/** Σ of the `amount` field across a taxes[]/deductions[] array → a positive total. */
function sumAmounts(v: unknown): number | null {
  if (!Array.isArray(v)) return null
  let sum = 0
  let seen = false
  for (const e of v) {
    const a = num(get(e, 'amount'))
    if (a != null) {
      sum += a
      seen = true
    }
  }
  return seen ? Math.abs(Math.round(sum * 100) / 100) : null
}

export type ArgylePaystubRow = {
  externalId: string
  employer: string | null
  grossPay: number | null
  netPay: number | null
  withholding: number | null
  deductions: number | null
  currency: string
  periodStart: string | null
  periodEnd: string | null
  paidAt: string | null
  payCycle: string | null
}

function paystubsOf(json: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(json)
    ? json
    : (get(json, 'results') ?? get(json, 'paystubs') ?? get(json, 'data'))
  return Array.isArray(arr)
    ? (arr.filter((p) => p && typeof p === 'object') as Record<string, unknown>[])
    : []
}

/** Argyle paystubs JSON → dedup-keyed rows (net pay = cash inflow; Σ withholding/deductions). */
export function normalizeArgylePaystubs(json: unknown): ArgylePaystubRow[] {
  const out: ArgylePaystubRow[] = []
  for (const p of paystubsOf(json)) {
    const id = str(p.id)
    if (!id) continue
    const period = (get(p, 'paystub_period') ?? get(p, 'pay_period') ?? {}) as Record<
      string,
      unknown
    >
    out.push({
      externalId: `argyle:${id}`,
      employer: str(p.employer) ?? str(get(p, 'employer_name')),
      grossPay: num(p.gross_pay),
      netPay: num(p.net_pay),
      withholding: sumAmounts(p.taxes),
      deductions: sumAmounts(p.deductions),
      currency: str(p.currency) ?? 'USD',
      periodStart: day(get(period, 'start_date') ?? p.period_start),
      periodEnd: day(get(period, 'end_date') ?? p.period_end),
      // The date cash actually lands — the forecast keys income events on this.
      paidAt: day(p.paid_at ?? p.payout_date ?? get(period, 'pay_date') ?? get(period, 'end_date')),
      payCycle: str(p.pay_cycle) ?? str(p.pay_frequency) ?? null
    })
  }
  return out
}

/** Upsert paystub rows by `external_id` — a re-sync refreshes in place, never duplicates. */
export function upsertPaystubs(
  db: ReturnType<typeof getDb>,
  rows: ArgylePaystubRow[],
  now: Date = new Date()
): number {
  let n = 0
  for (const r of rows) {
    const set = {
      employer: r.employer,
      grossPay: r.grossPay,
      netPay: r.netPay,
      withholding: r.withholding,
      deductions: r.deductions,
      currency: r.currency,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      paidAt: r.paidAt,
      payCycle: r.payCycle,
      ingestedAt: now
    }
    db.insert(argylePaystubs)
      .values({ externalId: r.externalId, ...set })
      .onConflictDoUpdate({ target: argylePaystubs.externalId, set })
      .run()
    n++
  }
  return n
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type ArgyleToken = { userId?: string }

const ARGYLE_SUCCESS_URL = 'https://compass.app/argyle/success' // sentinel we intercept, never load
const ARGYLE_SUCCESS = new URL(ARGYLE_SUCCESS_URL) // parsed once for exact origin+path matching

function loadArgyleToken(): ArgyleToken {
  return (loadToken('argyle') as ArgyleToken | null) ?? {}
}

/** Pull the connected user's paystubs → upsert into `argyle_paystubs` → feed the forecast. */
export async function syncArgyle(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadArgyleToken()
  if (!tok.userId) return { service: 'argyle', success: false, error: 'Argyle not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'argyle', () => null)

  let recordsUpdated = 0
  try {
    const res = await relayFetch(cfg, 'argyle', 'GET', '/paystubs', {
      query: `?user=${encodeURIComponent(tok.userId)}&limit=200`
    })
    if (!res.ok) throw new Error(`Argyle paystubs → HTTP ${res.status}`)
    recordsUpdated = upsertPaystubs(db, normalizeArgylePaystubs(await res.json()))

    db.insert(integrations)
      .values({
        service: 'argyle',
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
      .where(eq(integrations.service, 'argyle'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'argyle',
      status: 'done',
      recordsUpdated
    })
    return { service: 'argyle', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'argyle', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'argyle'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'argyle',
      status: 'error',
      error: message
    })
    return { service: 'argyle', success: false, error: message }
  }
}

/**
 * Open the Argyle Link flow in a sandboxed modal window; on the success redirect,
 * capture the connected user id. Hardened from the start (per PR #304's review): the
 * redirect is matched on origin+pathname EXACTLY (not `startsWith`) and the id is
 * validated against the relay's allowlist charset before it's stored.
 *
 * CAVEAT: the connect network path is structural (relay mints the user + Link token);
 * it is not test-exercised — like all relay aggregators it needs a deployed relay.
 */
export async function openArgyleConnect(
  sqlite: SqliteForFx,
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const cfg = resolveRelayConfig(sqlite, 'argyle', () => null)

  // Mint a connect session through the relay: create a user, then a Link user-token.
  let linkUrl: string
  let userId: string
  try {
    const userRes = await relayFetch(cfg, 'argyle', 'POST', '/users', { body: '{}' })
    if (!userRes.ok) throw new Error(`Argyle create-user → HTTP ${userRes.status}`)
    const user = (await userRes.json()) as { id?: string }
    userId = String(user.id ?? '')
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Argyle returned no valid user id')
    const tokRes = await relayFetch(cfg, 'argyle', 'POST', '/user-tokens', {
      body: JSON.stringify({ user: userId })
    })
    if (!tokRes.ok) throw new Error(`Argyle user-token → HTTP ${tokRes.status}`)
    const tok = (await tokRes.json()) as { token?: string; url?: string }
    // Prefer a hosted Link URL if the relay returns one; else the standard hosted host.
    linkUrl =
      str(tok.url) ??
      `https://link.argyle.com/?user_token=${encodeURIComponent(tok.token ?? '')}&redirect_url=${encodeURIComponent(ARGYLE_SUCCESS_URL)}`
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Connect Argyle',
      webPreferences: { sandbox: true, partition: 'argyle-connect', contextIsolation: true }
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
      // Exact origin+pathname match — `startsWith` would also fire on e.g. `/argyle/successful…`.
      if (target.origin !== ARGYLE_SUCCESS.origin || target.pathname !== ARGYLE_SUCCESS.pathname) {
        return
      }
      e.preventDefault()
      // We already hold the user id from the mint step; persist it as the sync handle.
      saveToken('argyle', { ...loadArgyleToken(), userId })
      finish({ success: true })
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(linkUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}
