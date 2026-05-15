/**
 * `compass://` URL parser tests. The handler (`registerCompassUrlScheme`)
 * binds Electron app-level events and is integration-tested by the
 * smoke flow in the PR plan. The pure parser + argv-scan + executor
 * functions are what get exercised here.
 */

import { describe, expect, it } from 'vitest'
import { findCompassUrlInArgv, parseCompassUrl } from './url-scheme'

describe('parseCompassUrl', () => {
  it('parses a capture command with text + category', () => {
    const cmd = parseCompassUrl('compass://capture?text=Buy%20milk&category=personal')
    expect(cmd).toEqual({ kind: 'capture', text: 'Buy milk', category: 'personal' })
  })

  it('parses a capture command without category', () => {
    const cmd = parseCompassUrl('compass://capture?text=Hello')
    expect(cmd).toEqual({ kind: 'capture', text: 'Hello', category: undefined })
  })

  it('parses an open command for a whitelisted page', () => {
    expect(parseCompassUrl('compass://open/dashboard')).toEqual({ kind: 'open', page: 'dashboard' })
    expect(parseCompassUrl('compass://open/finance')).toEqual({ kind: 'open', page: 'finance' })
  })

  it('rejects open for an unknown page', () => {
    expect(parseCompassUrl('compass://open/internal-admin')).toEqual({ kind: 'unknown' })
  })

  it('parses a search command', () => {
    expect(parseCompassUrl('compass://search?q=invoice')).toEqual({
      kind: 'search',
      query: 'invoice'
    })
  })

  it('treats unknown routes as `unknown`', () => {
    expect(parseCompassUrl('compass://launch-missiles')).toEqual({ kind: 'unknown' })
  })

  it('rejects non-compass schemes', () => {
    expect(parseCompassUrl('https://example.com/foo')).toEqual({ kind: 'unknown' })
    expect(parseCompassUrl('http://capture?text=oops')).toEqual({ kind: 'unknown' })
  })

  it('returns `unknown` for malformed URLs', () => {
    expect(parseCompassUrl('not a url')).toEqual({ kind: 'unknown' })
  })
})

describe('findCompassUrlInArgv', () => {
  it('finds a compass:// arg', () => {
    expect(findCompassUrlInArgv(['/path/to/app', 'compass://open/dashboard'])).toBe(
      'compass://open/dashboard'
    )
  })

  it('returns null when none present', () => {
    expect(findCompassUrlInArgv(['/path/to/app', '--flag', 'value'])).toBeNull()
  })

  it('returns the first match if multiple', () => {
    expect(findCompassUrlInArgv(['x', 'compass://search?q=a', 'compass://capture?text=b'])).toBe(
      'compass://search?q=a'
    )
  })

  it('handles non-string array elements defensively', () => {
    expect(findCompassUrlInArgv([undefined as unknown as string, 'compass://open/daily'])).toBe(
      'compass://open/daily'
    )
  })
})
