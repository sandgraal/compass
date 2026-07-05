/**
 * Canopy Connect adapter (Phase 10.9) — the second relay-fronted aggregator.
 *
 * Canopy Connect ("Plaid for insurance", usecanopy.com) returns fully-structured P&C
 * policy data (coverages, premiums, carriers, declarations) from 400+ carriers. It's
 * a B2B API keyed by a paid developer credential, so — like Terra — the key lives only
 * in the relay and never reaches a client (there's no meaningful BYO for Canopy). It
 * feeds the existing estate/insurance-adequacy engine (`finance-estate.ts`).
 *
 * DENY-by-default: only the pull-data fetch + the connect (pull-request) endpoint are
 * forwarded. API reference: https://docs.usecanopy.com — *(verify base + auth scheme
 * at build time; the shapes here follow the documented REST API).*
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.usecanopy.com'

const PULL_DATA = /^\/pulls\/[A-Za-z0-9_-]+$/ // GET a completed pull's structured data
const CONNECT_PATH = '/pull-requests' // POST to start a connect session

export const CANOPY_ADAPTER: AggregatorAdapter = {
  id: 'canopy',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return PULL_DATA.test(path)
    if (m === 'POST') return path === CONNECT_PATH
    return false
  },
  authHeaders(env: RelayEnv) {
    return {
      authorization: `Bearer ${env.CANOPY_API_KEY ?? ''}`,
      'content-type': 'application/json'
    }
  },
  costOf() {
    return 1
  },
  isConnect(method, path) {
    return method.toUpperCase() === 'POST' && path === CONNECT_PATH
  }
}
