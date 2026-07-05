/**
 * Terra integration (Phase 10.9) — the first relay-fronted aggregator, feeding the
 * Health hub. Terra (tryterra.co) normalizes 500+ wearables behind one API; we pull
 * its `/daily`, `/sleep`, `/activity` collections and project them into the health
 * `records` (source `'terra'`) using the SAME record shapes the other wearable
 * sources use, so the Health hub picks them up with only `'terra'` added to its
 * source list.
 *
 * The connect flow + live pull go through `relay-client.ts` (managed via the relay,
 * or BYO-direct with the user's own Terra key). The response → record transforms
 * below are PURE so they unit-test without any network.
 *
 * FORMAT CAVEAT: the Terra payload shapes here follow the documented schema but are
 * **unvalidated against a real Terra response** — sharpen the field paths when a real
 * payload lands (same posture as the brokerage-holdings / rideshare recognizers).
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import { upsertLiveRecords } from '../ipc/records'
import { afterConnectorSync } from '../ipc/storehouse-sync'
import { localYmd } from '../lib/dates'
import type { RecordInput } from '../lib/recognizers'
import type { SqliteForFx } from './finance-fx'
import {
  type ByoCreds,
  getOrCreateDeviceToken,
  relayFetch,
  resolveRelayConfig
} from './relay-client'

const SRC = 'terra'

function iso(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}
function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}
function entries(json: unknown): Record<string, unknown>[] {
  const data = get(json, 'data')
  return Array.isArray(data)
    ? (data.filter((x) => x && typeof x === 'object') as Record<string, unknown>[])
    : []
}
function dayOf(e: Record<string, unknown>): number | null {
  return iso(get(e, 'metadata', 'start_time')) ?? iso(get(e, 'metadata', 'end_time'))
}

/** Terra `/daily` → steps (payload.value) + resting-HR (payload.value) health records. */
export function normalizeTerraDaily(json: unknown): RecordInput[] {
  const out: RecordInput[] = []
  for (const e of entries(json)) {
    const at = dayOf(e)
    if (at == null) continue
    const steps = numOf(get(e, 'distance_data', 'steps')) ?? numOf(get(e, 'steps'))
    if (steps != null) {
      out.push({
        source: SRC,
        type: 'steps',
        occurredAt: at,
        title: `${Math.round(steps).toLocaleString('en-US')} steps`,
        payload: { value: Math.round(steps) },
        naturalKey: `steps|${at}`
      })
    }
    const restingHr =
      numOf(get(e, 'heart_rate_data', 'summary', 'resting_hr_bpm')) ??
      numOf(get(e, 'heart_rate_data', 'resting_hr_bpm'))
    if (restingHr != null) {
      out.push({
        source: SRC,
        type: 'resting-hr',
        occurredAt: at,
        title: `${Math.round(restingHr)} bpm`,
        payload: { value: Math.round(restingHr) },
        naturalKey: `resting-hr|${at}`
      })
    }
  }
  return out
}

/** Terra `/sleep` → sleep records (payload.ms — matches the Health hub's non-fitbit branch). */
export function normalizeTerraSleep(json: unknown): RecordInput[] {
  const out: RecordInput[] = []
  for (const e of entries(json)) {
    const at = dayOf(e)
    if (at == null) continue
    const sec =
      numOf(get(e, 'sleep_durations_data', 'asleep', 'duration_asleep_state_seconds')) ??
      numOf(get(e, 'sleep_durations_data', 'total_sleep_duration_seconds'))
    if (sec == null || sec <= 0) continue
    const ms = Math.round(sec * 1000)
    const h = Math.floor(ms / 3_600_000)
    const m = Math.round((ms % 3_600_000) / 60_000)
    out.push({
      source: SRC,
      type: 'sleep',
      occurredAt: at,
      title: `${h}h ${m}m asleep`,
      payload: { ms },
      naturalKey: `sleep|${at}`
    })
  }
  return out
}

/** Terra `/activity` → workout records (title from the session name/type). */
export function normalizeTerraActivity(json: unknown): RecordInput[] {
  const out: RecordInput[] = []
  for (const e of entries(json)) {
    const at = dayOf(e)
    if (at == null) continue
    const name = get(e, 'metadata', 'name')
    const title = typeof name === 'string' && name.trim() ? name.trim() : 'Workout'
    out.push({
      source: SRC,
      type: 'workout',
      occurredAt: at,
      title,
      payload: { name: title },
      naturalKey: `workout|${at}|${title}`
    })
  }
  return out
}

/** All three collections a full Terra sync pulls, in one place. */
export const TERRA_COLLECTIONS = [
  { path: '/daily', normalize: normalizeTerraDaily },
  { path: '/sleep', normalize: normalizeTerraSleep },
  { path: '/activity', normalize: normalizeTerraActivity }
] as const

// ── Connect + sync (impure; goes through the relay, or BYO-direct) ─────────────
// These need a live relay + real Terra credentials to actually run, so they're
// structured but NOT exercised by tests (the pure normalizers above are). The token
// blob for service 'terra' holds { userId } (managed) and/or { devId, apiKey } (BYO).

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type TerraToken = { userId?: string; devId?: string; apiKey?: string }

const WINDOW_DAYS = 30
const TERRA_SUCCESS_URL = 'https://compass.app/terra/success' // sentinel we intercept, never actually load
const TERRA_PROVIDERS = 'GARMIN,FITBIT,OURA,WHOOP,GOOGLE,APPLE,SAMSUNG,POLAR,SUUNTO,PELOTON,STRAVA'

function loadTerraToken(): TerraToken {
  return (loadToken('terra') as TerraToken | null) ?? {}
}
/** BYO iff the user pasted their own Terra dev-id + x-api-key. */
function terraByo(): ByoCreds | null {
  const t = loadTerraToken()
  return t.devId?.trim() && t.apiKey?.trim() ? { devId: t.devId, apiKey: t.apiKey } : null
}

/** Pull the last 30 days of Terra daily/sleep/activity → health `records` (source 'terra'). */
export async function syncTerra(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadTerraToken()
  if (!tok.userId) return { service: 'terra', success: false, error: 'Terra not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'terra', () => terraByo())
  const end = new Date()
  const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000)
  const query = `?user_id=${encodeURIComponent(tok.userId)}&start_date=${localYmd(start)}&end_date=${localYmd(end)}`

  let recordsUpdated = 0
  try {
    const records: RecordInput[] = []
    for (const c of TERRA_COLLECTIONS) {
      const res = await relayFetch(cfg, 'terra', 'GET', c.path, { query })
      if (!res.ok) throw new Error(`Terra ${c.path} → HTTP ${res.status}`)
      records.push(...c.normalize(await res.json()))
    }
    if (records.length > 0) recordsUpdated = upsertLiveRecords(records, 'terra').imported

    db.insert(integrations)
      .values({
        service: 'terra',
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
      .where(eq(integrations.service, 'terra'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'terra',
      status: 'done',
      recordsUpdated
    })
    afterConnectorSync()
    return { service: 'terra', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'terra', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'terra'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'terra',
      status: 'error',
      error: message
    })
    return { service: 'terra', success: false, error: message }
  }
}

/** Save the user's own Terra credentials → switches this aggregator to BYO-direct mode. */
export function setTerraByoCreds(devId: string, apiKey: string): void {
  saveToken('terra', { ...loadTerraToken(), devId: devId.trim(), apiKey: apiKey.trim() })
}

/**
 * Open the Terra Connect widget (session generated via the relay, which holds the secret
 * key) in a modal window and capture the resulting `user_id` on the success redirect.
 * Unvalidated without live keys — the redirect-capture pattern mirrors the Plaid Link window.
 */
export async function openTerraConnect(
  sqlite: SqliteForFx,
  mainWindow?: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const cfg = resolveRelayConfig(sqlite, 'terra', () => terraByo())
  let widgetUrl: string
  try {
    const res = await relayFetch(cfg, 'terra', 'POST', '/auth/generateWidgetSession', {
      body: JSON.stringify({
        reference_id: getOrCreateDeviceToken(sqlite),
        providers: TERRA_PROVIDERS,
        language: 'en',
        auth_success_redirect_url: TERRA_SUCCESS_URL
      })
    })
    if (!res.ok) throw new Error(`Terra widget session → HTTP ${res.status}`)
    const json = (await res.json()) as { url?: string }
    if (!json.url) throw new Error('Terra widget session returned no url')
    widgetUrl = json.url
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      title: 'Connect a wearable (Terra)',
      // Loads third-party remote content → tighten the boundary: sandboxed renderer,
      // no Node, and an in-memory partition so nothing persists (mirrors the Plaid/CRED windows).
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'terra-connect'
      }
    })
    let settled = false
    const finish = (result: { success: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }
    // Intercept the success redirect BEFORE it navigates — preventDefault so the sentinel
    // URL (which carries user_id) is never actually requested / logged.
    const onNavigate = (e: Electron.Event, url: string): void => {
      if (!url.startsWith(TERRA_SUCCESS_URL)) return
      e.preventDefault()
      try {
        const userId = new URL(url).searchParams.get('user_id') ?? ''
        if (!userId) {
          finish({ success: false, error: 'Terra returned no user_id' })
          return
        }
        saveToken('terra', { ...loadTerraToken(), userId })
        finish({ success: true })
      } catch (err) {
        finish({ success: false, error: String(err) })
      }
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    void win.loadURL(widgetUrl)
  })
}
