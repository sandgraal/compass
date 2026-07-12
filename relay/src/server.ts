/**
 * Relay request pipeline (Phase 10.9).
 *
 * `handleRelayRequest` is transport-agnostic (plain in/out objects) so the whole
 * path is unit-testable without binding a socket — `index.ts` wraps it in a Node
 * http server, but it could equally be a serverless handler.
 *
 * Pipeline: health check → bearer auth (token → metered user) → route
 * `/<aggregator>/<upstreamPath>` to an adapter → DENY-by-default allowlist → quota
 * check → proxy to the upstream with the secret auth headers injected → pass the
 * response straight back. It records COUNTERS ONLY (calls/bytes/cost); the upstream
 * payload is never stored — the relay is a stateless meter, not a data custodian.
 */

import { createHash } from 'node:crypto'
import { getAdapter } from './adapters/index.js'
import type { AggregatorAdapter, RelayEnv } from './adapters/types.js'
import {
  type MeteringStore,
  type Quota,
  checkQuota,
  emptyState,
  recordCall,
  rollover
} from './metering.js'
import { type SyncConfig, handleSyncRequest } from './sync.js'
import { TokenCache } from './token-cache.js'

export type RelayRequest = {
  method: string
  path: string // e.g. '/terra/daily'
  query: string // raw query string incl. leading '?', or ''
  headers: Record<string, string | undefined>
  body: string | null
}

export type RelayResponse = { status: number; headers: Record<string, string>; body: string }

export type RelayConfig = {
  env: RelayEnv // holds the secret aggregator credentials (TERRA_DEV_ID, TERRA_API_KEY, …)
  store: MeteringStore
  quota: Quota
  /** Permitted client bearer tokens; each token = one metered user. Empty set = allow any non-empty token (dev only). */
  clientTokens: Set<string>
  fetchImpl?: typeof fetch // injected in tests
  now?: () => number // injected in tests
  tokenCache?: TokenCache // OAuth bearer cache for tokenAuth adapters; defaults to a shared one
  /** Device-sync ciphertext mailbox (Phase 4b). Absent = /sync/* returns 404. */
  sync?: SyncConfig
}

function json(status: number, obj: unknown): RelayResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }
}

// Shared cache for OAuth client-credentials bearers (Arcadia). Holds only the relay's own
// short-lived service tokens — never user data. Tests may inject their own via cfg.tokenCache.
const sharedTokenCache = new TokenCache()

/**
 * Resolve the auth headers for a proxied request: the adapter's static `authHeaders`,
 * plus — for `tokenAuth` adapters — a cached OAuth bearer merged into Authorization.
 */
async function resolveAuthHeaders(
  adapter: AggregatorAdapter,
  cfg: RelayConfig,
  now: number,
  doFetch: typeof fetch
): Promise<Record<string, string>> {
  const headers = adapter.authHeaders(cfg.env)
  const ta = adapter.tokenAuth
  if (!ta) return headers
  const cache = cfg.tokenCache ?? sharedTokenCache
  const bearer = await cache.get(adapter.id, now, async () => {
    const r = ta.buildRequest(cfg.env)
    const res = await doFetch(ta.tokenUrl, {
      method: r.method ?? 'POST',
      headers: r.headers,
      body: r.body
    })
    if (!res.ok) throw new Error(`token exchange HTTP ${res.status}`)
    const parsed = ta.parseToken(await res.json())
    // Never cache/use an empty bearer — that only produces confusing downstream 401s
    // and invalidation loops. Fail the request now so the caller gets a clean 502.
    if (!parsed.accessToken) throw new Error('token exchange returned no access token')
    return parsed
  })
  return { ...headers, authorization: `Bearer ${bearer}` }
}

export async function handleRelayRequest(
  req: RelayRequest,
  cfg: RelayConfig
): Promise<RelayResponse> {
  const now = (cfg.now ?? Date.now)()
  const doFetch = cfg.fetchImpl ?? fetch
  const method = req.method.toUpperCase()

  if (method === 'GET' && req.path === '/healthz') return json(200, { ok: true })

  // ── AuthN: bearer token → metered user id ──
  const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return json(401, { error: 'Missing bearer token' })
  if (cfg.clientTokens.size > 0 && !cfg.clientTokens.has(token)) {
    return json(403, { error: 'Unknown client token' })
  }
  // Metering key = a NON-reversible hash of the token, so a shared KV store never
  // persists raw client auth tokens. The raw token is used only for the allowlist above.
  const userId = createHash('sha256').update(token).digest('hex')

  // ── Device sync (Phase 4b): a ciphertext mailbox, not an aggregator proxy ──
  // Behind the same bearer gate; opt-in via cfg.sync (RELAY_SYNC_DIR). Not
  // metered — one PUT/GET per sync beat, bounded by sync.maxBlobBytes.
  if (req.path.startsWith('/sync/')) {
    if (!cfg.sync) return json(404, { error: 'Sync is not enabled on this relay' })
    return handleSyncRequest(req, cfg.sync, cfg.now)
  }

  // ── Route: /<aggregatorId>/<upstreamPath…> ──
  const segments = req.path.replace(/^\/+/, '').split('/')
  const aggregatorId = segments.shift() ?? ''
  const upstreamPath = `/${segments.join('/')}`
  const adapter = getAdapter(aggregatorId)
  if (!adapter) return json(404, { error: `Unknown aggregator: ${aggregatorId}` })
  if (!adapter.allows(method, upstreamPath)) {
    return json(403, { error: `Endpoint not permitted: ${method} ${upstreamPath}` })
  }

  // ── Meter ──
  const state = rollover(cfg.store.get(userId) ?? emptyState(now), now)
  const call = {
    cost: adapter.costOf(method, upstreamPath),
    isConnect: adapter.isConnect(method, upstreamPath)
  }
  const decision = checkQuota(state, cfg.quota, call, now)
  if (!decision.allowed) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (decision.retryAfterSec) headers['retry-after'] = String(decision.retryAfterSec)
    return { status: decision.status, headers, body: JSON.stringify({ error: decision.reason }) }
  }

  // ── Proxy (inject secret credentials; forward method/query/body) ──
  const url = adapter.upstreamBase + upstreamPath + (req.query ?? '')
  let headers: Record<string, string>
  try {
    headers = await resolveAuthHeaders(adapter, cfg, now, doFetch)
  } catch (err) {
    // A failed OAuth token exchange — log server-side only, return a generic error.
    console.error('[relay] token exchange failed', err)
    return json(502, { error: 'Upstream auth failed' })
  }
  let upstream: Response
  try {
    upstream = await doFetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined),
      // Never auto-follow redirects: the secret credentials are attached to THIS request
      // and must not be replayed to a redirect target. Hand any 3xx back to the client.
      redirect: 'manual'
    })
  } catch (err) {
    // Log server-side only — never leak internal error detail (stack traces) to the caller.
    console.error('[relay] upstream fetch failed', err)
    return json(502, { error: 'Upstream fetch failed' })
  }

  // A 401 from a tokenAuth upstream means the cached bearer went stale — drop it so the
  // NEXT request re-exchanges (the 60s skew makes mid-flight expiry rare; this is the backstop).
  if (upstream.status === 401 && adapter.tokenAuth) {
    ;(cfg.tokenCache ?? sharedTokenCache).invalidate(adapter.id)
  }

  // Enforce the daily byte cap as a HARD cap: reject before reading the body when the
  // advertised Content-Length would push the user past their remaining quota.
  const contentLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(contentLength) && state.bytesToday + contentLength > cfg.quota.bytesPerDay) {
    return json(429, {
      error: 'Daily data quota would be exceeded. Connect your own aggregator key to continue.'
    })
  }
  const text = await upstream.text()

  // Record usage — counters only. The response body is passed through, never stored.
  const bytes = new TextEncoder().encode(text).length // portable (no Node Buffer)
  cfg.store.set(userId, recordCall(state, { ...call, bytes }, now))

  return {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    body: text
  }
}
