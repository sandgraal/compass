import { describe, expect, it } from 'vitest'
import { CANOPY_ADAPTER } from './canopy.js'
import { getAdapter } from './index.js'

describe('Canopy adapter — allowlist (deny by default)', () => {
  it('allows a pull-data GET with a dynamic pull id', () => {
    expect(CANOPY_ADAPTER.allows('GET', '/pulls/abc123')).toBe(true)
    expect(CANOPY_ADAPTER.allows('GET', '/pulls/a-b_C9')).toBe(true)
  })

  it('allows the connect POST', () => {
    expect(CANOPY_ADAPTER.allows('POST', '/pull-requests')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(CANOPY_ADAPTER.allows('GET', '/pulls/')).toBe(false) // no id
    expect(CANOPY_ADAPTER.allows('GET', '/pulls/a/b')).toBe(false) // no nested paths
    expect(CANOPY_ADAPTER.allows('POST', '/pulls/abc123')).toBe(false) // wrong method
    expect(CANOPY_ADAPTER.allows('GET', '/pull-requests')).toBe(false) // wrong method
    expect(CANOPY_ADAPTER.allows('DELETE', '/pulls/abc123')).toBe(false)
    expect(CANOPY_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Canopy adapter — auth + cost', () => {
  it('injects the Bearer API key from env', () => {
    expect(CANOPY_ADAPTER.authHeaders({ CANOPY_API_KEY: 'k123' }).authorization).toBe('Bearer k123')
  })

  it('degrades to an empty bearer (never crashes) when env is missing', () => {
    expect(CANOPY_ADAPTER.authHeaders({}).authorization).toBe('Bearer ')
  })

  it('costs 1 and flags only the connect POST', () => {
    expect(CANOPY_ADAPTER.costOf('GET', '/pulls/x')).toBe(1)
    expect(CANOPY_ADAPTER.isConnect('POST', '/pull-requests')).toBe(true)
    expect(CANOPY_ADAPTER.isConnect('GET', '/pulls/x')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves canopy', () => {
    expect(getAdapter('canopy')).toBe(CANOPY_ADAPTER)
  })
})
