import { describe, expect, it } from 'vitest'
import { ARCADIA_ADAPTER } from './arcadia.js'
import { getAdapter } from './index.js'

describe('Arcadia adapter — allowlist (deny by default)', () => {
  it('allows the statement + utility-account reads', () => {
    expect(ARCADIA_ADAPTER.allows('GET', '/plug/statements')).toBe(true)
    expect(ARCADIA_ADAPTER.allows('GET', '/plug/utility-accounts')).toBe(true)
  })

  it('allows the connect-token POST', () => {
    expect(ARCADIA_ADAPTER.allows('POST', '/plug/connect-tokens')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(ARCADIA_ADAPTER.allows('GET', '/plug/statements/123')).toBe(false) // no nested paths
    expect(ARCADIA_ADAPTER.allows('POST', '/plug/statements')).toBe(false) // wrong method
    expect(ARCADIA_ADAPTER.allows('DELETE', '/plug/utility-accounts')).toBe(false)
    expect(ARCADIA_ADAPTER.allows('GET', '/auth/access_token')).toBe(false) // token URL not proxied
    expect(ARCADIA_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Arcadia adapter — auth (OAuth token exchange + static version header)', () => {
  it('static headers carry only the version + content-type (bearer is injected by the relay)', () => {
    const h = ARCADIA_ADAPTER.authHeaders({})
    expect(h['arcadia-version']).toBe('2024-02-21')
    expect(h.authorization).toBeUndefined() // relay adds this from tokenAuth
  })

  it('tokenAuth builds a client-credentials request and parses camelCase + snake_case', () => {
    const ta = ARCADIA_ADAPTER.tokenAuth
    expect(ta?.tokenUrl).toBe('https://api.arcadia.com/auth/access_token')
    const req = ta?.buildRequest({ ARCADIA_CLIENT_ID: 'cid', ARCADIA_CLIENT_SECRET: 'sek' })
    expect(req?.method).toBe('POST')
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ clientId: 'cid', clientSecret: 'sek' })
    // both response shapes parse; a missing lifetime defaults to ~2h
    expect(ta?.parseToken({ accessToken: 'a', expiresIn: 3600 })).toEqual({
      accessToken: 'a',
      expiresInSec: 3600
    })
    expect(ta?.parseToken({ access_token: 'b' })).toEqual({ accessToken: 'b', expiresInSec: 7200 })
  })

  it('costs 1 and flags only the connect POST', () => {
    expect(ARCADIA_ADAPTER.costOf('GET', '/plug/statements')).toBe(1)
    expect(ARCADIA_ADAPTER.isConnect('POST', '/plug/connect-tokens')).toBe(true)
    expect(ARCADIA_ADAPTER.isConnect('GET', '/plug/statements')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves arcadia', () => {
    expect(getAdapter('arcadia')).toBe(ARCADIA_ADAPTER)
  })
})
