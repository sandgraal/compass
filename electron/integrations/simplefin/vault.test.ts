/**
 * Tests for the SimpleFIN encrypted vault.
 *
 * Mirrors the Plaid vault test: `electron.safeStorage` is mocked to a trivial
 * round-trip and VAULT_DIR is redirected to a per-test tmpdir. The AES-256-GCM
 * layer underneath is real.
 *
 * The Access URL embeds HTTP Basic credentials, so the key invariants here are
 * (1) it round-trips, (2) `listConnectionIds` never leaks the URLs, and
 * (3) malformed URLs are rejected loudly at write time.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let TMP_VAULT_DIR: string

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`SAFE:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('SAFE:')) throw new Error('mock safeStorage: invalid blob')
      return s.slice('SAFE:'.length)
    }
  }
}))

vi.mock('../../paths', () => ({
  get VAULT_DIR() {
    return TMP_VAULT_DIR
  }
}))

const {
  assertValidAccessUrl,
  getAccessUrl,
  setAccessUrl,
  removeAccessUrl,
  listConnectionIds,
  clearSimplefinVault
} = await import('./vault')

const URL_A = 'https://userA:passA@bridge.simplefin.org/simplefin'
const URL_B = 'https://userB:passB@bridge.simplefin.org/simplefin'

beforeEach(() => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-simplefin-vault-'))
})

afterEach(() => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('assertValidAccessUrl', () => {
  it('accepts an https URL with embedded credentials', () => {
    expect(() => assertValidAccessUrl(URL_A)).not.toThrow()
  })

  it('rejects a non-https URL', () => {
    expect(() => assertValidAccessUrl('http://u:p@bridge.simplefin.org/simplefin')).toThrow(/https/)
  })

  it('rejects an https URL without embedded credentials', () => {
    expect(() => assertValidAccessUrl('https://bridge.simplefin.org/simplefin')).toThrow(
      /credentials/
    )
  })

  it('rejects a non-URL string', () => {
    expect(() => assertValidAccessUrl('not a url')).toThrow(/valid URL/)
  })
})

describe('simplefin vault — access urls', () => {
  it('returns null when nothing is stored for a connection', () => {
    expect(getAccessUrl('conn-unknown')).toBeNull()
  })

  it('round-trips an access url', () => {
    setAccessUrl('conn-a', URL_A)
    expect(getAccessUrl('conn-a')).toBe(URL_A)
  })

  it('keeps urls per connection independent', () => {
    setAccessUrl('conn-a', URL_A)
    setAccessUrl('conn-b', URL_B)
    expect(getAccessUrl('conn-a')).toBe(URL_A)
    expect(getAccessUrl('conn-b')).toBe(URL_B)
  })

  it('removeAccessUrl deletes only the targeted connection', () => {
    setAccessUrl('conn-a', URL_A)
    setAccessUrl('conn-b', URL_B)
    removeAccessUrl('conn-a')
    expect(getAccessUrl('conn-a')).toBeNull()
    expect(getAccessUrl('conn-b')).toBe(URL_B)
  })

  it('listConnectionIds returns sorted ids and never the URLs', () => {
    setAccessUrl('conn-b', URL_B)
    setAccessUrl('conn-a', URL_A)
    const ids = listConnectionIds()
    expect(ids).toEqual(['conn-a', 'conn-b'])
    // The URLs (credentials) must not appear in the renderer-safe list.
    expect(JSON.stringify(ids)).not.toContain('passA')
    expect(JSON.stringify(ids)).not.toContain('passB')
  })

  it('rejects a malformed url at write time', () => {
    expect(() => setAccessUrl('conn-a', 'https://no-creds.example.com')).toThrow(/credentials/)
    expect(getAccessUrl('conn-a')).toBeNull()
  })

  it('rejects an empty connectionId', () => {
    expect(() => setAccessUrl('', URL_A)).toThrow(/connectionId/)
  })
})

describe('simplefin vault — clear', () => {
  it('wipes all stored urls', () => {
    setAccessUrl('conn-a', URL_A)
    clearSimplefinVault()
    expect(getAccessUrl('conn-a')).toBeNull()
    expect(listConnectionIds()).toEqual([])
  })

  it('is a no-op when the file does not exist', () => {
    expect(existsSync(join(TMP_VAULT_DIR, 'simplefin.enc'))).toBe(false)
    expect(() => clearSimplefinVault()).not.toThrow()
  })

  it('overwrites (does not rm) so disk observers can not tell wiped from never-used', () => {
    setAccessUrl('conn-a', URL_A)
    clearSimplefinVault()
    expect(existsSync(join(TMP_VAULT_DIR, 'simplefin.enc'))).toBe(true)
  })
})
