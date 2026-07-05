/**
 * Aggregator relay client (Phase 10.9) — the Electron (main-process) seam that talks
 * to paid aggregators, in one of two modes:
 *
 *  - **managed**: through the Compass relay (`../../relay`). The relay holds the paid
 *    key; the client authenticates with a device token. Zero setup for the user.
 *  - **byo**: the user supplied their OWN aggregator dev credentials, so we call the
 *    upstream API DIRECTLY and bypass the relay entirely (the "escape hatch" for power
 *    users / privacy-maximalists / anyone who's hit the shared quota).
 *
 * `buildAggregatorRequest` is a pure function (the seam the tests pin): given a config
 * and a logical call, it returns the exact URL + headers + body for whichever mode is
 * active. Main-process only (like the Oura/Linear fetches) so it never widens the
 * renderer CSP beyond adding the two hosts.
 */

import { randomUUID } from 'node:crypto'
import type { SqliteForFx } from './finance-fx'

export type AggregatorId = 'terra' | 'canopy'
export type RelayMode = 'managed' | 'byo'

/** BYO credentials per aggregator (Terra: dev-id + x-api-key). */
export type ByoCreds = { devId: string; apiKey: string }

export type RelayClientConfig = {
  mode: RelayMode
  relayUrl: string // managed: the relay base, e.g. https://relay.compass.app
  deviceToken: string // managed: per-install bearer token (also the relay's metering key)
  byo: ByoCreds | null // byo: the user's own credentials
}

/** Upstream API bases for BYO-direct mode (must mirror each relay adapter's `upstreamBase`). */
export const UPSTREAM_BASE: Record<AggregatorId, string> = {
  terra: 'https://api.tryterra.co/v2',
  canopy: 'https://api.usecanopy.com' // Canopy is managed-only in practice (no consumer dev accounts)
}

/** Default managed relay host. Overridable via the `relayUrl` app setting. */
export const DEFAULT_RELAY_URL = 'https://relay.compass.app'

export type BuiltRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Build the concrete HTTP request for a logical aggregator call, honoring the mode.
 * Pure — no network, no DB — so the managed↔BYO routing is fully unit-testable.
 */
export function buildAggregatorRequest(
  cfg: RelayClientConfig,
  aggregatorId: AggregatorId,
  method: string,
  upstreamPath: string,
  query = '',
  body: string | null = null
): BuiltRequest {
  const m = method.toUpperCase()
  const sendBody = m === 'GET' || m === 'HEAD' ? undefined : (body ?? undefined)

  if (cfg.mode === 'byo') {
    if (!cfg.byo) throw new Error('BYO mode selected but no credentials are set')
    return {
      url: `${UPSTREAM_BASE[aggregatorId]}${upstreamPath}${query}`,
      method: m,
      headers: {
        'dev-id': cfg.byo.devId,
        'x-api-key': cfg.byo.apiKey,
        'content-type': 'application/json'
      },
      body: sendBody
    }
  }

  return {
    url: `${cfg.relayUrl.replace(/\/+$/, '')}/${aggregatorId}${upstreamPath}${query}`,
    method: m,
    headers: {
      authorization: `Bearer ${cfg.deviceToken}`,
      'content-type': 'application/json'
    },
    body: sendBody
  }
}

/** Fire the built request. Thin wrapper over global fetch (main-process; CSP-free). */
export async function relayFetch(
  cfg: RelayClientConfig,
  aggregatorId: AggregatorId,
  method: string,
  upstreamPath: string,
  opts: { query?: string; body?: string | null } = {}
): Promise<Response> {
  const built = buildAggregatorRequest(
    cfg,
    aggregatorId,
    method,
    upstreamPath,
    opts.query ?? '',
    opts.body ?? null
  )
  return fetch(built.url, { method: built.method, headers: built.headers, body: built.body })
}

// ── Config resolution (impure — app_settings + the encrypted BYO token store) ──

function readSetting(sqlite: SqliteForFx, key: string): string | null {
  try {
    const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeSetting(sqlite: SqliteForFx, key: string, value: string, now: number): void {
  sqlite
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, now)
}

/** The per-install device token for the managed relay; generated + persisted on first use. */
export function getOrCreateDeviceToken(sqlite: SqliteForFx, now: number = Date.now()): string {
  const existing = readSetting(sqlite, 'relayDeviceToken')
  if (existing?.trim()) return existing
  const token = randomUUID()
  writeSetting(sqlite, 'relayDeviceToken', token, now)
  return token
}

/**
 * Resolve the active relay config for an aggregator. BYO wins when the user has set
 * their own credentials (`byoLoader` returns them); otherwise managed via the relay.
 */
export function resolveRelayConfig(
  sqlite: SqliteForFx,
  aggregatorId: AggregatorId,
  byoLoader: (aggregatorId: AggregatorId) => ByoCreds | null,
  now: number = Date.now()
): RelayClientConfig {
  const byo = byoLoader(aggregatorId)
  return {
    mode: byo ? 'byo' : 'managed',
    relayUrl: readSetting(sqlite, 'relayUrl')?.trim() || DEFAULT_RELAY_URL,
    deviceToken: getOrCreateDeviceToken(sqlite, now),
    byo
  }
}
