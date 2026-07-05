/**
 * Argyle adapter (Phase 10.9) — the third relay-fronted aggregator.
 *
 * Argyle (argyle.com) is "Plaid for payroll/employment" — real paystubs, employment,
 * and income for ~80% of the US workforce through one connection. Like Canopy it's a
 * B2B API keyed by a paid developer credential, so the key lives ONLY in the relay and
 * never reaches a client (no meaningful consumer BYO). It feeds the cash-flow forecast
 * (`finance-forecast.ts` / `finance-income.ts`): ground-truth pay cadence + net pay
 * replacing bank-deposit inference.
 *
 * AUTH: Argyle uses HTTP Basic auth — the API Key id as the username and the API Key
 * secret as the password (`Authorization: Basic base64(id:secret)`). Confirmed against
 * https://docs.argyle.com/api-guide/overview (base https://api.argyle.com/v2).
 *
 * DENY-by-default: only the read endpoints the income engine needs + the connect
 * (create-user / mint-token) endpoints are forwarded. The relay matches on PATH only —
 * query strings (e.g. `?account=…`) are forwarded untouched — so exact-path entries
 * cover `/paystubs?account=…`. Field shapes follow the documented REST API but are
 * **unvalidated against a real pull** — sharpen when one lands (same caveat as Canopy).
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.argyle.com/v2'

// Read endpoints (GET) the income engine needs. Path-only match; query passes through.
const READS = new Set(['/paystubs', '/accounts', '/employments'])
// Connect endpoints (POST) that mint a user + a Link token for the connect widget.
const CONNECTS = new Set(['/users', '/user-tokens'])

export const ARGYLE_ADAPTER: AggregatorAdapter = {
  id: 'argyle',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return READS.has(path)
    if (m === 'POST') return CONNECTS.has(path)
    return false
  },
  authHeaders(env: RelayEnv) {
    // HTTP Basic: base64("<key-id>:<key-secret>"). btoa is fine — API credentials are
    // ASCII — and stays portable (Node + edge/serverless) without a Node Buffer.
    const id = env.ARGYLE_API_KEY ?? ''
    const secret = env.ARGYLE_API_SECRET ?? ''
    return {
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'content-type': 'application/json'
    }
  },
  costOf() {
    return 1
  },
  isConnect(method, path) {
    return method.toUpperCase() === 'POST' && CONNECTS.has(path)
  }
}
