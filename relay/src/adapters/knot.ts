/**
 * Knot adapter (Phase 10.9) — the seventh relay-fronted aggregator and the last on
 * the roadmap.
 *
 * Knot (knotapi.com) is "Plaid for merchant transactions" — its **TransactionLink**
 * product returns SKU-level order history (the actual line items, not just the card
 * charge) from merchants like Amazon, Walmart, DoorDash, Uber, Instacart, etc. through
 * one connection. Like Canopy/Argyle it's a B2B API keyed by a paid developer
 * credential, so the key lives ONLY in the relay and never reaches a client.
 *
 * It feeds the **commerce / purchase timeline** — the same `records` thread the static
 * Amazon order-history recognizer (`electron/lib/amazon.ts`) opened, but live and across
 * every connected merchant. Merchant purchases are low-sensitivity (records-readable per
 * the AI boundary), so unlike health/payroll/medical this lands ON the spine.
 *
 * AUTH: HTTP Basic — the client id as the username and the secret as the password
 * (`Authorization: Basic base64(client_id:secret)`), same shape as Argyle. Confirmed
 * against https://docs.knotapi.com (base https://production.knotapi.com).
 *
 * DENY-by-default: only the transaction-sync read, the session-create connect, and the
 * merchant-list lookup are forwarded. `/transactions/sync` is a POST *read* (Knot pages
 * transactions via a request body cursor), so it is allowed but NOT flagged isConnect —
 * only `/session/create` mints a new merchant connection. Field shapes follow the
 * documented REST API but are **unvalidated against a real pull** (same caveat as Canopy
 * /Argyle) — sharpen when one lands.
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://production.knotapi.com'

// POST reads (paginated via a request-body cursor) the purchase timeline needs.
const POST_READS = new Set(['/transactions/sync'])
// POST that mints a new merchant connection (SDK session). Account-cap + isConnect.
const CONNECTS = new Set(['/session/create'])
// GET lookups (supported-merchant catalog).
const GET_READS = new Set(['/merchant/list'])

export const KNOT_ADAPTER: AggregatorAdapter = {
  id: 'knot',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return GET_READS.has(path)
    if (m === 'POST') return POST_READS.has(path) || CONNECTS.has(path)
    return false
  },
  authHeaders(env: RelayEnv) {
    // HTTP Basic: base64("<client-id>:<secret>"). btoa is fine — API credentials are
    // ASCII — and stays portable (Node + edge/serverless) without a Node Buffer.
    const id = env.KNOT_CLIENT_ID ?? ''
    const secret = env.KNOT_SECRET ?? ''
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
