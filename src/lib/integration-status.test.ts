import { describe, expect, it } from 'vitest'
import { deriveCardState } from './integration-status'

describe('deriveCardState', () => {
  it('single-connection: connected row → Connected', () => {
    const s = deriveCardState({ id: 'github', baseStatus: 'connected', hasStatusRow: true })
    expect(s.isConnected).toBe(true)
    expect(s.hasError).toBe(false)
    expect(s.statusLabel).toBe('Connected')
    expect(s.showNotConnectedGlyph).toBe(false)
  })

  it('single-connection: no row → Not connected + glyph', () => {
    const s = deriveCardState({ id: 'linear', hasStatusRow: false })
    expect(s.isConnected).toBe(false)
    expect(s.statusLabel).toBe('Not connected')
    expect(s.showNotConnectedGlyph).toBe(true)
  })

  it('single-connection: error row → Error + surfaces message', () => {
    const s = deriveCardState({
      id: 'oura',
      baseStatus: 'error',
      baseErrorMessage: 'HTTP 401',
      hasStatusRow: true
    })
    expect(s.hasError).toBe(true)
    expect(s.errorWins).toBe(true)
    expect(s.statusLabel).toBe('Error')
    expect(s.errorMessage).toBe('HTTP 401')
  })

  it('plaid: no items → Not connected', () => {
    const s = deriveCardState({ id: 'plaid', plaidItems: [] })
    expect(s.isMultiConn).toBe(true)
    expect(s.isConnected).toBe(false)
    expect(s.statusLabel).toBe('Not connected')
    // Multi-conn never shows the single-connection "not connected" glyph.
    expect(s.showNotConnectedGlyph).toBe(false)
  })

  it('plaid: all healthy items → Connected', () => {
    const s = deriveCardState({
      id: 'plaid',
      plaidItems: [{ errorCode: null, lastSyncedAt: 1 }]
    })
    expect(s.isConnected).toBe(true)
    expect(s.hasError).toBe(false)
    expect(s.statusLabel).toBe('Connected')
  })

  it('plaid: one bad item among healthy → Needs attention (not green)', () => {
    const s = deriveCardState({
      id: 'plaid',
      plaidItems: [
        { errorCode: null, lastSyncedAt: 1 },
        { errorCode: 'ITEM_LOGIN_REQUIRED', lastSyncedAt: null }
      ]
    })
    expect(s.isConnected).toBe(true)
    expect(s.hasError).toBe(true)
    expect(s.errorWins).toBe(true)
    expect(s.statusLabel).toBe('Needs attention')
    // Per-item errors render in the body, not the card banner.
    expect(s.errorMessage).toBeNull()
  })

  it('simplefin: only-bad connection → Error', () => {
    const s = deriveCardState({
      id: 'simplefin',
      simplefinConnections: [{ errorCode: 'AUTH_FAILED', lastSyncedAt: null }]
    })
    expect(s.isConnected).toBe(true)
    expect(s.errorWins).toBe(true)
    expect(s.statusLabel).toBe('Needs attention')
  })

  it('does not surface a card-level message for multi-conn', () => {
    const s = deriveCardState({
      id: 'plaid',
      baseStatus: 'error',
      baseErrorMessage: 'ignored for multi-conn',
      plaidItems: []
    })
    expect(s.errorMessage).toBeNull()
  })
})
