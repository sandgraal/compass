/**
 * Canopy Connect integration (Phase 10.9) — the second relay-fronted aggregator,
 * feeding the estate/insurance-readiness engine. Canopy ("Plaid for insurance")
 * returns structured P&C policy data; we project each policy into the `assets` table
 * as a `type:'insurance'` row (`external_id = 'canopy:<policyId>'`, upserted so a
 * re-sync refreshes in place), so `finance-estate.ts`'s adequacy/gap engine picks it
 * up with NO changes — real policies instead of hand-entered ones.
 *
 * Managed-only (Canopy has no consumer dev accounts) → always through the relay,
 * which holds the paid key. The connect + pull go through `relay-client.ts`. The
 * `normalizeCanopyPull` transform is PURE so it unit-tests without any network.
 *
 * PRIVACY: only adequacy-relevant, non-secret fields are stored (carrier, coverage
 * limit, line of business, renewal). The policy number is MASKED to its last 4 (like
 * the credit hub). FORMAT CAVEAT: the Canopy payload shapes follow the documented REST
 * API but are **unvalidated against a real pull** — sharpen the field paths when one lands.
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { assets, integrations, syncEvents } from '../db/schema'
import type { AssetInput } from '../ipc/assets'
import { loadToken, saveToken } from '../ipc/auth'
import type { SqliteForFx } from './finance-fx'
import { getOrCreateDeviceToken, relayFetch, resolveRelayConfig } from './relay-client'

// ── pure helpers ──────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
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

/** Map a Canopy line-of-business to a keyword-matchable name (so the estate gap-matcher works). */
export function lineOfBusinessName(lob: string): string {
  const s = lob.toUpperCase()
  if (/AUTO|VEHICLE|MOTOR/.test(s)) return 'Auto insurance'
  if (/HOMEOWN|DWELLING|^HOME|PROPERTY/.test(s)) return 'Homeowners insurance'
  if (/RENTER/.test(s)) return 'Renters insurance'
  if (/UMBRELLA|LIABILITY/.test(s)) return 'Umbrella / liability insurance'
  if (/LIFE/.test(s)) return 'Life insurance'
  if (/HEALTH|MEDICAL/.test(s)) return 'Health insurance'
  if (/FLOOD/.test(s)) return 'Flood insurance'
  const t = lob
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
  return t ? `${t} insurance` : 'Insurance policy'
}

/** Last-4 masked policy number (semi-sensitive → never store it whole). */
export function maskPolicyNumber(pn: unknown): string | null {
  const s = str(pn)
  if (!s) return null
  return s.length <= 4 ? s : `••••${s.slice(-4)}`
}

function coverageOf(policy: Record<string, unknown>): number | null {
  const covs = policy.coverages
  if (Array.isArray(covs)) {
    let max: number | null = null
    for (const c of covs) {
      const v = num(get(c, 'limit')) ?? num(get(c, 'per_occurrence_limit')) ?? num(get(c, 'amount'))
      if (v != null && (max == null || v > max)) max = v
    }
    if (max != null) return max
  }
  return num(policy.coverage_amount) ?? num(policy.dwelling_coverage) ?? null
}

function policiesOf(json: unknown): Record<string, unknown>[] {
  const arr =
    get(json, 'policies') ?? get(json, 'pull', 'policies') ?? get(json, 'data', 'policies')
  return Array.isArray(arr)
    ? (arr.filter((p) => p && typeof p === 'object') as Record<string, unknown>[])
    : []
}

export type CanopyAsset = { externalId: string; asset: AssetInput }

/** Canopy pull JSON → insurance asset rows (keyword-matchable name, coverage, masked #). */
export function normalizeCanopyPull(json: unknown): CanopyAsset[] {
  const out: CanopyAsset[] = []
  for (const p of policiesOf(json)) {
    const id = str(p.id) ?? str(p.policy_id) ?? str(p.policy_number)
    if (!id) continue
    const lob = str(p.policy_type) ?? str(p.line_of_business) ?? str(p.type) ?? ''
    const carrier = str(p.carrier_name) ?? str(p.carrier) ?? str(p.insurance_company)
    const expiration = (str(p.expiration_date) ?? str(p.renewal_date) ?? '').slice(0, 10) || null
    const premium = num(p.annual_premium) ?? num(get(p, 'premium', 'amount')) ?? num(p.premium)
    out.push({
      externalId: `canopy:${id}`,
      asset: {
        type: 'insurance',
        name: lineOfBusinessName(lob),
        value: coverageOf(p),
        provider: carrier,
        reference: maskPolicyNumber(p.policy_number),
        renewalDate: expiration,
        status: 'active',
        notes: premium != null ? `Premium ${Math.round(premium).toLocaleString('en-US')}` : null
      }
    })
  }
  return out
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
type CanopyToken = { pullId?: string }

const CANOPY_SUCCESS_URL = 'https://compass.app/canopy/success' // sentinel we intercept, never load

function loadCanopyToken(): CanopyToken {
  return (loadToken('canopy') as CanopyToken | null) ?? {}
}

/** Upsert insurance policies into `assets` (by external_id), refreshing on re-sync. */
export function upsertInsuranceAssets(
  db: ReturnType<typeof getDb>,
  items: CanopyAsset[],
  now: Date = new Date()
): number {
  let n = 0
  for (const { externalId, asset } of items) {
    const set = {
      type: 'insurance',
      name: (asset.name ?? 'Insurance policy').slice(0, 200),
      value: asset.value ?? null,
      provider: asset.provider ?? null,
      reference: asset.reference ?? null,
      renewalDate: asset.renewalDate ?? null,
      status: asset.status ?? 'active',
      notes: asset.notes ?? null,
      updatedAt: now
    }
    db.insert(assets)
      .values({ externalId, ...set })
      .onConflictDoUpdate({ target: assets.externalId, set })
      .run()
    n++
  }
  return n
}

/** Pull the connected Canopy policies → upsert into `assets` → feed the estate engine. */
export async function syncCanopy(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  const tok = loadCanopyToken()
  if (!tok.pullId) return { service: 'canopy', success: false, error: 'Canopy not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'canopy', () => null)

  let recordsUpdated = 0
  try {
    const res = await relayFetch(cfg, 'canopy', 'GET', `/pulls/${encodeURIComponent(tok.pullId)}`)
    if (!res.ok) throw new Error(`Canopy pull → HTTP ${res.status}`)
    recordsUpdated = upsertInsuranceAssets(db, normalizeCanopyPull(await res.json()))

    db.insert(integrations)
      .values({
        service: 'canopy',
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
      .where(eq(integrations.service, 'canopy'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'canopy',
      status: 'done',
      recordsUpdated
    })
    return { service: 'canopy', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'canopy', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    mainWindow?.webContents.send('sync:update', {
      service: 'canopy',
      status: 'error',
      error: message
    })
    return { service: 'canopy', success: false, error: message }
  }
}

/**
 * Open the Canopy Connect flow (session minted via the relay) and capture the `pull_id`
 * on the success redirect. Sandboxed + preventDefault, same hardening as the Terra window.
 * Unvalidated without live keys.
 */
export async function openCanopyConnect(
  sqlite: SqliteForFx,
  mainWindow?: BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  const cfg = resolveRelayConfig(sqlite, 'canopy', () => null)
  let connectUrl: string
  try {
    const res = await relayFetch(cfg, 'canopy', 'POST', '/pull-requests', {
      body: JSON.stringify({
        reference_id: getOrCreateDeviceToken(sqlite),
        redirect_url: CANOPY_SUCCESS_URL
      })
    })
    if (!res.ok) throw new Error(`Canopy connect session → HTTP ${res.status}`)
    const json = (await res.json()) as { url?: string; connect_url?: string }
    const url = json.url ?? json.connect_url
    if (!url) throw new Error('Canopy connect session returned no url')
    connectUrl = url
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      title: 'Connect your insurance (Canopy)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'canopy-connect'
      }
    })
    let settled = false
    const finish = (result: { success: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }
    const onNavigate = (e: Electron.Event, url: string): void => {
      if (!url.startsWith(CANOPY_SUCCESS_URL)) return
      e.preventDefault()
      try {
        const pullId = new URL(url).searchParams.get('pull_id') ?? ''
        if (!pullId) {
          finish({ success: false, error: 'Canopy returned no pull_id' })
          return
        }
        saveToken('canopy', { ...loadCanopyToken(), pullId })
        finish({ success: true })
      } catch (err) {
        finish({ success: false, error: String(err) })
      }
    }
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.on('will-navigate', onNavigate)
    win.on('closed', () => finish({ success: false, error: 'Connection window closed' }))
    void win.loadURL(connectUrl)
  })
}
