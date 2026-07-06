/**
 * Nylas adapter (Phase 10.9) — the sixth relay-fronted aggregator. Nylas connects 250+
 * email/calendar/contact providers (Gmail, Outlook, iCloud, Yahoo, Exchange) through one
 * integration. Like Canopy it's keyed by a static app-level **Bearer API key** (no OAuth
 * token exchange) — the key lives only in the relay. The end-user consents via Nylas
 * Hosted Auth (which produces a per-account `grant_id`); the relay then fronts the
 * grant-scoped contacts read + the auth-code→grant token exchange.
 *
 * It broadens the **People** directory beyond Google-direct contacts. DENY-by-default:
 * only the grant's contacts GET + the connect-token POST are forwarded. Base + shapes
 * confirmed against https://developer.nylas.com/docs/v3 (US region); unvalidated against
 * a real grant.
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.us.nylas.com'

const CONTACTS = /^\/v3\/grants\/[A-Za-z0-9_-]+\/contacts$/ // GET a grant's contacts
const CONNECT_PATH = '/v3/connect/token' // POST: exchange the auth code for a grant

export const NYLAS_ADAPTER: AggregatorAdapter = {
  id: 'nylas',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return CONTACTS.test(path)
    if (m === 'POST') return path === CONNECT_PATH
    return false
  },
  authHeaders(env: RelayEnv) {
    return {
      authorization: `Bearer ${env.NYLAS_API_KEY ?? ''}`,
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
