/**
 * Metriport adapter (Phase 10.9) — the seventh relay-fronted aggregator, and the first
 * MEDICAL one. Metriport (open-source universal healthcare API) pulls a patient's clinical
 * records from the health-information networks (TEFCA / Carequality / Commonwell) and
 * returns them as **FHIR R4** bundles. Like Terra/Canopy it's keyed by a static app-level
 * key (the `x-api-key` header) that lives only in the relay.
 *
 * It feeds a new, aggregates-only **Medical records** surface. DENY-by-default: only the
 * consolidated-data GET + the patient-create / start-query POSTs are forwarded. Base + auth
 * confirmed against https://docs.metriport.com (Medical API). The consolidated query is
 * asynchronous (Metriport pushes to a webhook); the client reads the CACHED consolidated
 * bundle via GET — the trigger + webhook wiring is a deploy-time concern.
 */

import type { AggregatorAdapter, RelayEnv } from './types.js'

const BASE = 'https://api.metriport.com'

const CONSOLIDATED = /^\/medical\/v1\/patient\/[A-Za-z0-9_-]+\/consolidated$/ // GET cached FHIR bundle
const START_QUERY = /^\/medical\/v1\/patient\/[A-Za-z0-9_-]+\/consolidated\/query$/ // POST: refresh
const PATIENT_CREATE = '/medical/v1/patient' // POST: onboard the patient (connect)

export const METRIPORT_ADAPTER: AggregatorAdapter = {
  id: 'metriport',
  upstreamBase: BASE,
  allows(method, path) {
    const m = method.toUpperCase()
    if (m === 'GET') return CONSOLIDATED.test(path)
    if (m === 'POST') return path === PATIENT_CREATE || START_QUERY.test(path)
    return false
  },
  authHeaders(env: RelayEnv) {
    return {
      'x-api-key': env.METRIPORT_API_KEY ?? '',
      'content-type': 'application/json'
    }
  },
  costOf() {
    return 1
  },
  isConnect(method, path) {
    // Onboarding a new patient is the account-connect action; the query is a data refresh.
    return method.toUpperCase() === 'POST' && path === PATIENT_CREATE
  }
}
