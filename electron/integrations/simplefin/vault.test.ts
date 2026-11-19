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
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s: string) => Buffer.from(`SAFE:${s}`, 'utf8'),
    decryptStringAsync: async (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('SAFE:')) throw new Error('mock safeStorage: invalid blob')
      return { result: s.slice('SAFE:'.length), shouldReEncrypt: false }
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

beforeEach(async () => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-simplefin-vault-'))
})

afterEach(async () => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('assertValidAccessUrl', () => {
  it('accepts an https URL with embedded credentials', async () => {
    expect(() => assertValidAccessUrl(URL_A)).not.toThrow()
  })

  it('rejects a non-https URL', async () => {
    expect(() => assertValidAccessUrl('http://u:p@bridge.simplefin.org/simplefin')).toThrow(/https/)
  })

  it('rejects an https URL without embedded credentials', async () => {
    expect(() => assertValidAccessUrl('https://bridge.simplefin.org/simplefin')).toThrow(
      /credentials/
    )
  })

  it('rejects a non-URL string', async () => {
    expect(() => assertValidAccessUrl('not a url')).toThrow(/valid URL/)
  })
})

describe('simplefin vault — access urls', () => {
  it('returns null when nothing is stored for a connection', async () => {
    expect(await getAccessUrl('conn-unknown')).toBeNull()
  })

  it('round-trips an access url', async () => {
    await setAccessUrl('conn-a', URL_A)
    expect(await getAccessUrl('conn-a')).toBe(URL_A)
  })

  it('keeps urls per connection independent', async () => {
    await setAccessUrl('conn-a', URL_A)
    await setAccessUrl('conn-b', URL_B)
    expect(await getAccessUrl('conn-a')).toBe(URL_A)
    expect(await getAccessUrl('conn-b')).toBe(URL_B)
  })

  it('removeAccessUrl deletes only the targeted connection', async () => {
    await setAccessUrl('conn-a', URL_A)
    await setAccessUrl('conn-b', URL_B)
    await removeAccessUrl('conn-a')
    expect(await getAccessUrl('conn-a')).toBeNull()
    expect(await getAccessUrl('conn-b')).toBe(URL_B)
  })

  it('listConnectionIds returns sorted ids and never the URLs', async () => {
    await setAccessUrl('conn-b', URL_B)
    await setAccessUrl('conn-a', URL_A)
    const ids = await listConnectionIds()
    expect(ids).toEqual(['conn-a', 'conn-b'])
    // The URLs (credentials) must not appear in the renderer-safe list.
    expect(JSON.stringify(ids)).not.toContain('passA')
    expect(JSON.stringify(ids)).not.toContain('passB')
  })

  it('rejects a malformed url at write time', async () => {
    await expect(setAccessUrl('conn-a', 'https://no-creds.example.com')).rejects.toThrow(
      /credentials/
    )
    expect(await getAccessUrl('conn-a')).toBeNull()
  })

  it('rejects an empty connectionId', async () => {
    await expect(setAccessUrl('', URL_A)).rejects.toThrow(/connectionId/)
  })
})

describe('simplefin vault — clear', () => {
  it('wipes all stored urls', async () => {
    await setAccessUrl('conn-a', URL_A)
    await clearSimplefinVault()
    expect(await getAccessUrl('conn-a')).toBeNull()
    expect(await listConnectionIds()).toEqual([])
  })

  it('is a no-op when the file does not exist', async () => {
    expect(existsSync(join(TMP_VAULT_DIR, 'simplefin.enc'))).toBe(false)
    await expect(clearSimplefinVault()).resolves.not.toThrow()
  })

  it('overwrites (does not rm) so disk observers can not tell wiped from never-used', async () => {
    await setAccessUrl('conn-a', URL_A)
    await clearSimplefinVault()
    expect(existsSync(join(TMP_VAULT_DIR, 'simplefin.enc'))).toBe(true)
  })
})
