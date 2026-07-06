/**
 * Nylas adapter (Phase 10.9) — the sixth relay-fronted aggregator. Nylas connects 250+
 * email/calendar/contact providers (Gmail, Outlook, iCloud, Yahoo, Exchange) through one
 * integration. It's keyed by a static app-level **Bearer API key** (the secret app key,
 * which doubles as the OAuth client secret) — that key lives only in the relay and is the
 * single injected credential for BOTH permitted calls. The end-user consents via Nylas
 * Hosted Auth; the relay fronts (a) the grant-scoped contacts read and (b) the OAuth
 * authorization-code→grant token exchange (`POST /v3/connect/token`, where the injected
 * Bearer key authorizes the exchange). The client sends the auth `code` + public
 * `client_id`; only the app key stays server-side.
 *
 * It broadens the owned **contacts** / People directory beyond Google-direct. DENY-by-
 * default: only the grant's contacts GET + the connect-token POST are forwarded. Base +
 * shapes confirmed against https://developer.nylas.com/docs/v3 (US region); unvalidated
 * against a real grant.
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
