/**
 * Arcadia adapter (Phase 10.9) — utility-bill aggregator (125+ US utilities, "Plug" API).
 * The FIRST adapter to use `tokenAuth`: Arcadia authenticates with an OAuth2 client-
 * credentials exchange (client_id/secret → a short-lived bearer, ~2h), not a static key —
 * so the relay obtains + caches the bearer (see `TokenCache`) and injects it. The only
 * static header is `Arcadia-Version`. Managed-only (B2B; no consumer dev accounts).
 *
 * It feeds `finance-property.ts`'s Schedule-E P&L: utility bills become the utilities
 * operating-expense line for the connected rental. DENY-by-default: only the statements/
 * accounts reads + the connect-token POST are forwarded. Base + version confirmed against
 * https://docs.arcadia.com; field/endpoint shapes are **unvalidated against a real account**.
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.arcadia.com'
const ARCADIA_VERSION = '2024-02-21'

const STATEMENTS = /^\/plug\/statements$/ // GET utility statements (bills)
const UTILITY_ACCOUNTS = /^\/plug\/utility-accounts$/ // GET connected utility accounts
const CONNECT_PATH = '/plug/connect-tokens' // POST to mint a Connect widget session

export const ARCADIA_ADAPTER: AggregatorAdapter = {
  id: 'arcadia',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return STATEMENTS.test(path) || UTILITY_ACCOUNTS.test(path)
    if (m === 'POST') return path === CONNECT_PATH
    return false
  },
  authHeaders() {
    // The bearer is injected by the relay via `tokenAuth`; only the version header is static.
    return { 'arcadia-version': ARCADIA_VERSION, 'content-type': 'application/json' }
  },
  costOf() {
    return 1
  },
  isConnect(method, path) {
    return method.toUpperCase() === 'POST' && path === CONNECT_PATH
  },
  tokenAuth: {
    tokenUrl: `${BASE}/auth/access_token`,
    buildRequest(env: RelayEnv) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: env.ARCADIA_CLIENT_ID ?? '',
          clientSecret: env.ARCADIA_CLIENT_SECRET ?? ''
        })
      }
    },
    parseToken(json: unknown) {
      const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
      const accessToken =
        typeof j.accessToken === 'string'
          ? j.accessToken
          : typeof j.access_token === 'string'
            ? j.access_token
            : ''
      const expiresInSec =
        typeof j.expiresIn === 'number'
          ? j.expiresIn
          : typeof j.expires_in === 'number'
            ? j.expires_in
            : 7200 // Arcadia tokens last ~2h; default when the field is absent
      return { accessToken, expiresInSec }
    }
  }
}
