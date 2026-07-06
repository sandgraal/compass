/**
 * Nylas integration (Phase 10.9) — the sixth relay-fronted aggregator. Nylas connects
 * 250+ email/calendar/contact providers (Gmail, Outlook, iCloud, Yahoo, Exchange) through
 * one integration. This slice imports **contacts**, broadening the owned address book
 * beyond Google-direct — the same way Google Contacts works today: `normalizeNylasContacts`
 * maps to the shared `ContactInput` shape and `upsertContacts(source:'nylas')` writes them
 * into the `contacts` table (dedup by `external_id`). They then surface wherever owned
 * contacts do (Contacts search, `profile/relationships.md`, and People via the timeline /
 * explicit promotion) — no schema or engine change.
 *
 * Managed-only (Nylas is keyed by a static app-level Bearer API key that lives only in the
 * relay). The end-user consents via Nylas Hosted Auth → a per-account `grant_id`. The pure
 * `normalizeNylasContacts` is unit-tested; the connect + fetch paths need a deployed relay
 * + real Nylas app config and are **not** test-exercised. FORMAT CAVEAT: the contact shape
 * follows the documented v3 API, unvalidated against a real grant. (Contacts are fetched a
 * page at a time — pagination via `cursor` is a follow-up.)
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import { type ContactInput, upsertContacts } from '../ipc/contacts'
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

function contactsOf(json: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(json) ? json : get(json, 'data')
  return Array.isArray(arr)
    ? (arr.filter((c) => c && typeof c === 'object') as Record<string, unknown>[])
    : []
}

function emailsOf(c: Record<string, unknown>): { type: string; value: string }[] {
  const arr = c.emails
  if (!Array.isArray(arr)) return []
  const out: { type: string; value: string }[] = []
  for (const e of arr) {
    const value = str(get(e, 'email'))
    if (value) out.push({ type: str(get(e, 'type')) || 'other', value })
  }
  return out
}

function phonesOf(c: Record<string, unknown>): { type: string; value: string }[] {
  const arr = c.phone_numbers
  if (!Array.isArray(arr)) return []
  const out: { type: string; value: string }[] = []
  for (const p of arr) {
    const value = str(get(p, 'number'))
    if (value) out.push({ type: str(get(p, 'type')) || 'other', value })
  }
  return out
}

/** Nylas contacts JSON → shared `ContactInput` rows (mirrors `googlePersonToContact`). */
export function normalizeNylasContacts(json: unknown): ContactInput[] {
  const out: ContactInput[] = []
  for (const c of contactsOf(json)) {
    const id = str(c.id)
    // A remote sync source MUST have a stable external id — without one, upsertContacts
    // would mint a fresh uuid every run and duplicate the contact on each sync.
    if (!id) continue
    const given = str(c.given_name)
    const surname = str(c.surname)
    const emails = emailsOf(c)
    const displayName = [given, surname].filter(Boolean).join(' ') || emails[0]?.value || ''
    if (!displayName) continue // no name and no email → nothing to show
    out.push({
      externalId: `nylas:${id}`,
      displayName,
      givenName: given,
      familyName: surname,
      middleName: str(c.middle_name),
      org: str(c.company_name),
      jobTitle: str(c.job_title),
      emails,
      phones: phonesOf(c),
      source: 'nylas'
    })
  }
  return out
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type NylasToken = { grantId?: string }

const NYLAS_SUCCESS_URL = 'https://compass.app/nylas/success' // sentinel we intercept
const NYLAS_SUCCESS = new URL(NYLAS_SUCCESS_URL)

function loadNylasToken(): NylasToken {
  return (loadToken('nylas') as NylasToken | null) ?? {}
}

/** Pull the connected grant's contacts → upsert into `contacts` → owned address book. */
export async function syncNylas(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadNylasToken()
  if (!tok.grantId) return { service: 'nylas', success: false, error: 'Nylas not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'nylas', () => null)

  let recordsUpdated = 0
  try {
    const res = await relayFetch(
      cfg,
      'nylas',
      'GET',
      `/v3/grants/${encodeURIComponent(tok.grantId)}/contacts`,
      { query: '?limit=200' }
    )
    if (!res.ok) throw new Error(`Nylas contacts → HTTP ${res.status}`)
    const inputs = normalizeNylasContacts(await res.json())
    const { imported, updated } = upsertContacts(inputs)
    recordsUpdated = imported + updated

    db.insert(integrations)
      .values({
        service: 'nylas',
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
      .where(eq(integrations.service, 'nylas'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'nylas',
      status: 'done',
      recordsUpdated
    })
    return { service: 'nylas', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'nylas', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'nylas'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'nylas',
      status: 'error',
      error: message
    })
    return { service: 'nylas', success: false, error: message }
  }
}

const NYLAS_BASE = 'https://api.us.nylas.com'

function readSetting(sqlite: SqliteForFx, key: string): string | null {
  try {
    const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value?.trim() || null
  } catch {
    return null
  }
}

/**
 * Nylas Hosted Auth is a standard OAuth **authorization-code** flow:
 *   1. Open Nylas's hosted consent page (`/v3/connect/auth?...response_type=code`) — the
 *      user authenticates at their own provider. The `client_id` is public (a `nylasClientId`
 *      app setting); the redirect_uri sentinel is registered in the Nylas app.
 *   2. Nylas redirects back with `?code=<AUTH_CODE>` — we intercept it (exact origin+pathname).
 *   3. Exchange the code for a **grant** via the relay `POST /v3/connect/token` (the relay
 *      injects the secret app key) → `{ grant_id }`, which we store as the sync handle.
 *
 * Hardened: popups denied, exact-redirect match, code + grant charset-validated. CAVEAT:
 * this whole path needs a DEPLOYED relay + a configured Nylas app; it is not test-exercised.
 */
export async function openNylasConnect(
  sqlite: SqliteForFx,
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const clientId = readSetting(sqlite, 'nylasClientId')
  if (!clientId) {
    return { success: false, error: 'Nylas is not configured (missing app client id).' }
  }
  const cfg = resolveRelayConfig(sqlite, 'nylas', () => null)
  const authUrl = `${NYLAS_BASE}/v3/connect/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(NYLAS_SUCCESS_URL)}&response_type=code`

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Connect your email account (Nylas)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'nylas-connect'
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
      if (target.origin !== NYLAS_SUCCESS.origin || target.pathname !== NYLAS_SUCCESS.pathname) {
        return
      }
      e.preventDefault() // synchronous — stop the navigation before the async exchange
      const code = target.searchParams.get('code') ?? ''
      if (!/^[\w.\-]+$/.test(code)) {
        finish({ success: false, error: 'Nylas returned no valid auth code' })
        return
      }
      // Exchange the auth code for a grant via the relay (which injects the app secret).
      void (async () => {
        try {
          const res = await relayFetch(cfg, 'nylas', 'POST', '/v3/connect/token', {
            body: JSON.stringify({
              code,
              client_id: clientId,
              redirect_uri: NYLAS_SUCCESS_URL,
              grant_type: 'authorization_code'
            })
          })
          if (!res.ok) {
            finish({ success: false, error: `Nylas token exchange → HTTP ${res.status}` })
            return
          }
          const body = (await res.json()) as { grant_id?: string }
          const grantId = str(body.grant_id)
          if (!grantId || !/^[\w.\-]+$/.test(grantId)) {
            finish({ success: false, error: 'Nylas returned no grant id' })
            return
          }
          saveToken('nylas', { ...loadNylasToken(), grantId })
          finish({ success: true })
        } catch (err) {
          finish({ success: false, error: err instanceof Error ? err.message : String(err) })
        }
      })()
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(authUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}
