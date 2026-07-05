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
import type { RelayEnv } from './adapters/types.js'
import {
  type MeteringStore,
  type Quota,
  checkQuota,
  emptyState,
  recordCall,
  rollover
} from './metering.js'

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
}

function json(status: number, obj: unknown): RelayResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }
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
  let upstream: Response
  try {
    upstream = await doFetch(url, {
      method,
      headers: adapter.authHeaders(cfg.env),
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
