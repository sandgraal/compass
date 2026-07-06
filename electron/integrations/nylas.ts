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
    const given = str(c.given_name)
    const surname = str(c.surname)
    const emails = emailsOf(c)
    const displayName = [given, surname].filter(Boolean).join(' ') || emails[0]?.value || ''
    if (!displayName) continue // no name and no email → nothing to show
    out.push({
      externalId: id ? `nylas:${id}` : undefined, // upsertContacts mints a uuid if absent
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

/**
 * Open Nylas Hosted Auth in a sandboxed modal window; on the success redirect, capture
 * the connected account's `grant_id`. Hardened like the other connect flows (popups
 * denied, exact origin+pathname match, id charset-validated).
 *
 * CAVEAT: Hosted Auth (the provider-consent OAuth flow) + the code→grant exchange run
 * against a deployed relay with real Nylas app credentials; this path is not
 * test-exercised. The relay holds the app key; the client only ever sees the grant id.
 */
export async function openNylasConnect(
  sqlite: SqliteForFx,
  parent: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const cfg = resolveRelayConfig(sqlite, 'nylas', () => null)

  // Ask the relay to mint a Hosted-Auth URL (it holds the Nylas app id + key).
  let authUrl: string
  try {
    const res = await relayFetch(cfg, 'nylas', 'POST', '/v3/connect/token', {
      body: JSON.stringify({ action: 'auth-url', redirect_uri: NYLAS_SUCCESS_URL })
    })
    if (!res.ok) throw new Error(`Nylas connect → HTTP ${res.status}`)
    const body = (await res.json()) as { url?: string; authUrl?: string }
    const url = str(body.url) ?? str(body.authUrl)
    if (!url) throw new Error('Nylas did not return a Hosted Auth URL')
    authUrl = url
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

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
      e.preventDefault()
      const grantId = target.searchParams.get('grant_id') ?? ''
      if (!/^[A-Za-z0-9_-]+$/.test(grantId)) {
        finish({ success: false, error: 'Nylas returned no valid grant id' })
        return
      }
      saveToken('nylas', { ...loadNylasToken(), grantId })
      finish({ success: true })
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    win.loadURL(authUrl).catch((err) => finish({ success: false, error: String(err) }))
  })
}
