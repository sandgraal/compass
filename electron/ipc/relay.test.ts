import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAY_URL } from '../integrations/relay-client'
import { pickRelayUrl, validateRelayUrl } from './relay'

describe('validateRelayUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    const v = validateRelayUrl('https://relay.example.com/')
    expect(v.ok).toBe(true)
    expect(v.url).toBe('https://relay.example.com')
  })

  it('accepts http localhost', () => {
    const v = validateRelayUrl('http://localhost:8787')
    expect(v.ok).toBe(true)
    expect(v.url).toBe('http://localhost:8787')
  })

  it('rejects empty input', () => {
    expect(validateRelayUrl('   ').ok).toBe(false)
  })

  it('rejects non-URL text', () => {
    expect(validateRelayUrl('not a url').ok).toBe(false)
  })

  it('rejects non-http(s) protocols', () => {
    const v = validateRelayUrl('ftp://relay.example.com')
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/http/)
  })
})

describe('pickRelayUrl', () => {
  it('falls back to the built-in default when unset', () => {
    expect(pickRelayUrl(null)).toEqual({ relayUrl: DEFAULT_RELAY_URL, isDefault: true })
    expect(pickRelayUrl('   ')).toEqual({ relayUrl: DEFAULT_RELAY_URL, isDefault: true })
  })

  it('uses the custom URL when set', () => {
    expect(pickRelayUrl('http://localhost:8787')).toEqual({
      relayUrl: 'http://localhost:8787',
      isDefault: false
    })
  })
})
