import { describe, expect, it } from 'vitest'
import { ARGYLE_ADAPTER } from './argyle.js'
import { getAdapter } from './index.js'

describe('Argyle adapter — allowlist (deny by default)', () => {
  it('allows the read endpoints the income engine needs', () => {
    expect(ARGYLE_ADAPTER.allows('GET', '/paystubs')).toBe(true)
    expect(ARGYLE_ADAPTER.allows('GET', '/accounts')).toBe(true)
    expect(ARGYLE_ADAPTER.allows('GET', '/employments')).toBe(true)
  })

  it('allows the connect POSTs (create user + mint token)', () => {
    expect(ARGYLE_ADAPTER.allows('POST', '/users')).toBe(true)
    expect(ARGYLE_ADAPTER.allows('POST', '/user-tokens')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(ARGYLE_ADAPTER.allows('GET', '/users')).toBe(false) // no listing users
    expect(ARGYLE_ADAPTER.allows('GET', '/identities')).toBe(false) // not allowlisted
    expect(ARGYLE_ADAPTER.allows('POST', '/paystubs')).toBe(false) // wrong method
    expect(ARGYLE_ADAPTER.allows('DELETE', '/accounts')).toBe(false)
    expect(ARGYLE_ADAPTER.allows('GET', '/paystubs/123')).toBe(false) // no nested paths
    expect(ARGYLE_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Argyle adapter — auth + cost', () => {
  it('injects HTTP Basic auth from the key id + secret', () => {
    const h = ARGYLE_ADAPTER.authHeaders({ ARGYLE_API_KEY: 'id123', ARGYLE_API_SECRET: 'sek' })
    expect(h.authorization).toBe(`Basic ${btoa('id123:sek')}`)
    // …and it round-trips back to "id:secret"
    expect(atob(h.authorization.slice('Basic '.length))).toBe('id123:sek')
  })

  it('degrades to Basic of ":" (never crashes) when env is missing', () => {
    expect(ARGYLE_ADAPTER.authHeaders({}).authorization).toBe(`Basic ${btoa(':')}`)
  })

  it('costs 1 and flags only the connect POSTs', () => {
    expect(ARGYLE_ADAPTER.costOf('GET', '/paystubs')).toBe(1)
    expect(ARGYLE_ADAPTER.isConnect('POST', '/users')).toBe(true)
    expect(ARGYLE_ADAPTER.isConnect('POST', '/user-tokens')).toBe(true)
    expect(ARGYLE_ADAPTER.isConnect('GET', '/paystubs')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves argyle', () => {
    expect(getAdapter('argyle')).toBe(ARGYLE_ADAPTER)
  })
})
