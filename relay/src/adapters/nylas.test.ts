import { describe, expect, it } from 'vitest'
import { getAdapter } from './index.js'
import { NYLAS_ADAPTER } from './nylas.js'

describe('Nylas adapter — allowlist (deny by default)', () => {
  it('allows a grant-scoped contacts GET', () => {
    expect(NYLAS_ADAPTER.allows('GET', '/v3/grants/abc-123/contacts')).toBe(true)
    expect(NYLAS_ADAPTER.allows('GET', '/v3/grants/GR_ant_9/contacts')).toBe(true)
  })

  it('allows the connect-token POST', () => {
    expect(NYLAS_ADAPTER.allows('POST', '/v3/connect/token')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(NYLAS_ADAPTER.allows('GET', '/v3/grants//contacts')).toBe(false) // empty grant
    expect(NYLAS_ADAPTER.allows('GET', '/v3/grants/abc/contacts/1')).toBe(false) // nested
    expect(NYLAS_ADAPTER.allows('GET', '/v3/grants/abc/messages')).toBe(false) // email NOT proxied
    expect(NYLAS_ADAPTER.allows('POST', '/v3/grants/abc/contacts')).toBe(false) // wrong method
    expect(NYLAS_ADAPTER.allows('DELETE', '/v3/grants/abc/contacts')).toBe(false)
    expect(NYLAS_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Nylas adapter — auth + cost', () => {
  it('injects the Bearer app API key from env', () => {
    expect(NYLAS_ADAPTER.authHeaders({ NYLAS_API_KEY: 'nyk_1' }).authorization).toBe('Bearer nyk_1')
  })

  it('degrades to an empty bearer (never crashes) when env is missing', () => {
    expect(NYLAS_ADAPTER.authHeaders({}).authorization).toBe('Bearer ')
  })

  it('costs 1 and flags only the connect POST', () => {
    expect(NYLAS_ADAPTER.costOf('GET', '/v3/grants/x/contacts')).toBe(1)
    expect(NYLAS_ADAPTER.isConnect('POST', '/v3/connect/token')).toBe(true)
    expect(NYLAS_ADAPTER.isConnect('GET', '/v3/grants/x/contacts')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves nylas', () => {
    expect(getAdapter('nylas')).toBe(NYLAS_ADAPTER)
  })
})
