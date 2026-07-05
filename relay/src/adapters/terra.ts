/**
 * Terra adapter (Phase 10.9) — the first relay-fronted aggregator.
 *
 * Terra (tryterra.co) normalizes 500+ wearables/health apps behind one API. Both the
 * connect flow (`POST /auth/generateWidgetSession`) and every data pull require the
 * developer's secret `dev-id` + `x-api-key` on each request — which is exactly why
 * this must go through the relay: those paid credentials live server-side and never
 * reach a client. (A user with their own Terra dev account can instead go BYO-direct;
 * see the Electron `relay-client.ts`.)
 *
 * DENY-by-default: only the data collection endpoints + the connect/disconnect auth
 * endpoints are forwarded. Terra API reference: https://docs.tryterra.co/reference
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.tryterra.co/v2'

// Data collection endpoints (GET, date-range queries), relative to BASE.
const DATA_GET = new Set([
  '/daily',
  '/activity',
  '/sleep',
  '/body',
  '/nutrition',
  '/menstruation',
  '/athlete'
])

const CONNECT_PATH = '/auth/generateWidgetSession'
const DISCONNECT_PATH = '/auth/deauthenticateUser'

export const TERRA_ADAPTER: AggregatorAdapter = {
  id: 'terra',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return DATA_GET.has(path)
    if (m === 'POST') return path === CONNECT_PATH || path === DISCONNECT_PATH
    return false
  },
  authHeaders(env: RelayEnv) {
    return {
      'dev-id': env.TERRA_DEV_ID ?? '',
      'x-api-key': env.TERRA_API_KEY ?? '',
      'content-type': 'application/json'
    }
  },
  costOf(_method, path) {
    if (path === DISCONNECT_PATH) return 0
    return 1 // widget session + each data pull cost one unit
  },
  isConnect(method, path) {
    return method.toUpperCase() === 'POST' && path === CONNECT_PATH
  }
}
