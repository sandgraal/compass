import { describe, expect, it } from 'vitest'
import { getAdapter } from './index.js'
import { TERRA_ADAPTER } from './terra.js'

describe('Terra adapter — allowlist (deny by default)', () => {
  it('allows the data collection GETs', () => {
    for (const p of ['/daily', '/activity', '/sleep', '/body', '/nutrition', '/athlete']) {
      expect(TERRA_ADAPTER.allows('GET', p)).toBe(true)
    }
  })

  it('allows the connect + disconnect POSTs', () => {
    expect(TERRA_ADAPTER.allows('POST', '/auth/generateWidgetSession')).toBe(true)
    expect(TERRA_ADAPTER.allows('POST', '/auth/deauthenticateUser')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(TERRA_ADAPTER.allows('GET', '/auth/generateWidgetSession')).toBe(false) // wrong method
    expect(TERRA_ADAPTER.allows('POST', '/daily')).toBe(false) // wrong method
    expect(TERRA_ADAPTER.allows('GET', '/admin')).toBe(false)
    expect(TERRA_ADAPTER.allows('DELETE', '/daily')).toBe(false)
    expect(TERRA_ADAPTER.allows('POST', '/auth/anything')).toBe(false)
  })
})

describe('Terra adapter — auth + cost', () => {
  it('injects the secret dev credentials from env', () => {
    const h = TERRA_ADAPTER.authHeaders({ TERRA_DEV_ID: 'dev123', TERRA_API_KEY: 'key456' })
    expect(h['dev-id']).toBe('dev123')
    expect(h['x-api-key']).toBe('key456')
  })

  it('degrades to empty credentials (never crashes) when env is missing', () => {
    const h = TERRA_ADAPTER.authHeaders({})
    expect(h['dev-id']).toBe('')
    expect(h['x-api-key']).toBe('')
  })

  it('costs 1 for connect + data, 0 for disconnect', () => {
    expect(TERRA_ADAPTER.costOf('POST', '/auth/generateWidgetSession')).toBe(1)
    expect(TERRA_ADAPTER.costOf('GET', '/daily')).toBe(1)
    expect(TERRA_ADAPTER.costOf('POST', '/auth/deauthenticateUser')).toBe(0)
  })

  it('flags only the widget session as a connect', () => {
    expect(TERRA_ADAPTER.isConnect('POST', '/auth/generateWidgetSession')).toBe(true)
    expect(TERRA_ADAPTER.isConnect('GET', '/daily')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves terra and nothing else', () => {
    expect(getAdapter('terra')).toBe(TERRA_ADAPTER)
    expect(getAdapter('unknown')).toBeUndefined()
  })
})
