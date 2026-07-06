import { describe, expect, it } from 'vitest'
import { getAdapter } from './index.js'
import { KNOT_ADAPTER } from './knot.js'

describe('Knot adapter — allowlist (deny by default)', () => {
  it('allows the transaction-sync POST read + the merchant-list GET', () => {
    expect(KNOT_ADAPTER.allows('POST', '/transactions/sync')).toBe(true)
    expect(KNOT_ADAPTER.allows('GET', '/merchant/list')).toBe(true)
  })

  it('allows the connect POST (create session)', () => {
    expect(KNOT_ADAPTER.allows('POST', '/session/create')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(KNOT_ADAPTER.allows('GET', '/transactions/sync')).toBe(false) // read is POST-only
    expect(KNOT_ADAPTER.allows('POST', '/merchant/list')).toBe(false) // lookup is GET-only
    expect(KNOT_ADAPTER.allows('GET', '/session/create')).toBe(false) // connect is POST-only
    expect(KNOT_ADAPTER.allows('DELETE', '/transactions/sync')).toBe(false)
    expect(KNOT_ADAPTER.allows('POST', '/transactions')).toBe(false) // not allowlisted
    expect(KNOT_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Knot adapter — auth + cost', () => {
  it('injects HTTP Basic auth from the client id + secret', () => {
    const h = KNOT_ADAPTER.authHeaders({ KNOT_CLIENT_ID: 'cid', KNOT_SECRET: 'sek' })
    expect(h.authorization).toBe(`Basic ${btoa('cid:sek')}`)
    // …and it round-trips back to "id:secret"
    expect(atob(h.authorization.slice('Basic '.length))).toBe('cid:sek')
  })

  it('degrades to Basic of ":" (never crashes) when env is missing', () => {
    expect(KNOT_ADAPTER.authHeaders({}).authorization).toBe(`Basic ${btoa(':')}`)
  })

  it('costs 1 and flags ONLY the session-create connect (not the POST read)', () => {
    expect(KNOT_ADAPTER.costOf('POST', '/transactions/sync')).toBe(1)
    expect(KNOT_ADAPTER.isConnect('POST', '/session/create')).toBe(true)
    expect(KNOT_ADAPTER.isConnect('POST', '/transactions/sync')).toBe(false)
    expect(KNOT_ADAPTER.isConnect('GET', '/merchant/list')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves knot', () => {
    expect(getAdapter('knot')).toBe(KNOT_ADAPTER)
  })
})
