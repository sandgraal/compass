/**
 * Tests for the Plaid encrypted vault.
 *
 * `electron.safeStorage` is unavailable outside the main process at
 * runtime, so we mock it to a simple round-trip (encrypt = identity-ish,
 * decrypt = inverse). The AES-256-GCM layer underneath is real — the
 * mock only stands in for the OS-Keychain wrap on the master key.
 *
 * VAULT_DIR is redirected to a temp directory per test via `vi.mock` of
 * `../../paths`, keeping every test fully isolated.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-test tmpdir. Captured in module-scope so the mocks below can read
// it; beforeEach mints a fresh one for each test.
let TMP_VAULT_DIR: string

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Trivial round-trip: wrap/unwrap with a fixed prefix so the
    // "decrypts back to the original" invariant is testable.
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

// Late imports so the mocks are wired before the modules read their constants.
const {
  getPlaidSecret,
  setPlaidSecret,
  removePlaidSecret,
  getAccessToken,
  setAccessToken,
  removeAccessToken,
  listItemIds,
  clearPlaidVault
} = await import('./vault')

beforeEach(() => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-plaid-vault-'))
})

afterEach(() => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* tmpdir cleanup is best-effort */
  }
})

describe('plaid vault — secrets', () => {
  it('returns null when no secret has been stored', () => {
    expect(getPlaidSecret('sandbox')).toBeNull()
    expect(getPlaidSecret('development')).toBeNull()
    expect(getPlaidSecret('production')).toBeNull()
  })

  it('round-trips a secret', () => {
    setPlaidSecret('development', 'secret-abc')
    expect(getPlaidSecret('development')).toBe('secret-abc')
  })

  it('keeps secrets per environment independent', () => {
    setPlaidSecret('sandbox', 'sandbox-secret')
    setPlaidSecret('production', 'prod-secret')
    expect(getPlaidSecret('sandbox')).toBe('sandbox-secret')
    expect(getPlaidSecret('production')).toBe('prod-secret')
    expect(getPlaidSecret('development')).toBeNull()
  })

  it('overwrites on re-set', () => {
    setPlaidSecret('sandbox', 'first')
    setPlaidSecret('sandbox', 'second')
    expect(getPlaidSecret('sandbox')).toBe('second')
  })

  it('removePlaidSecret deletes only the targeted env', () => {
    setPlaidSecret('sandbox', 'sb')
    setPlaidSecret('production', 'pr')
    removePlaidSecret('sandbox')
    expect(getPlaidSecret('sandbox')).toBeNull()
    expect(getPlaidSecret('production')).toBe('pr')
  })

  it('removePlaidSecret is a no-op when nothing is stored', () => {
    expect(() => removePlaidSecret('development')).not.toThrow()
  })

  it('rejects empty secret strings', () => {
    expect(() => setPlaidSecret('sandbox', '')).toThrow(/non-empty/)
  })
})

describe('plaid vault — access tokens', () => {
  it('returns null when no token is stored for an item', () => {
    expect(getAccessToken('item_unknown')).toBeNull()
  })

  it('round-trips an access token', () => {
    setAccessToken('item_abc', 'access-sandbox-xyz')
    expect(getAccessToken('item_abc')).toBe('access-sandbox-xyz')
  })

  it('keeps tokens per Item independent', () => {
    setAccessToken('item_a', 'token-a')
    setAccessToken('item_b', 'token-b')
    expect(getAccessToken('item_a')).toBe('token-a')
    expect(getAccessToken('item_b')).toBe('token-b')
  })

  it('removeAccessToken deletes only the targeted item', () => {
    setAccessToken('item_a', 'token-a')
    setAccessToken('item_b', 'token-b')
    removeAccessToken('item_a')
    expect(getAccessToken('item_a')).toBeNull()
    expect(getAccessToken('item_b')).toBe('token-b')
  })

  it('listItemIds returns sorted ids without leaking tokens', () => {
    setAccessToken('item_b', 'b')
    setAccessToken('item_a', 'a')
    setAccessToken('item_c', 'c')
    expect(listItemIds()).toEqual(['item_a', 'item_b', 'item_c'])
  })

  it('listItemIds returns [] for a fresh vault', () => {
    expect(listItemIds()).toEqual([])
  })

  it('rejects empty itemId / token', () => {
    expect(() => setAccessToken('', 'token')).toThrow(/itemId/)
    expect(() => setAccessToken('item_a', '')).toThrow(/access_token/)
  })

  it('getAccessToken returns null for empty itemId rather than throwing', () => {
    // Defensive — callers may not have validated input.
    expect(getAccessToken('')).toBeNull()
  })
})

describe('plaid vault — clear', () => {
  it('clearPlaidVault wipes both secrets and tokens', () => {
    setPlaidSecret('sandbox', 'sb')
    setAccessToken('item_a', 'tok')
    clearPlaidVault()
    expect(getPlaidSecret('sandbox')).toBeNull()
    expect(getAccessToken('item_a')).toBeNull()
    expect(listItemIds()).toEqual([])
  })

  it('clearPlaidVault is a no-op when the file does not exist', () => {
    expect(existsSync(join(TMP_VAULT_DIR, 'plaid.enc'))).toBe(false)
    expect(() => clearPlaidVault()).not.toThrow()
  })

  it('clearPlaidVault leaves the encrypted file on disk (overwrites, does not rm)', () => {
    // On-disk observers shouldn't be able to tell "wiped" apart from
    // "never used".
    setAccessToken('item_a', 'tok')
    clearPlaidVault()
    expect(existsSync(join(TMP_VAULT_DIR, 'plaid.enc'))).toBe(true)
  })
})

describe('plaid vault — secrets + tokens coexist', () => {
  it('writing a secret does not clobber tokens (and vice versa)', () => {
    setAccessToken('item_a', 'tok')
    setPlaidSecret('sandbox', 'sb')
    expect(getAccessToken('item_a')).toBe('tok')
    expect(getPlaidSecret('sandbox')).toBe('sb')

    setAccessToken('item_b', 'tok2')
    expect(getPlaidSecret('sandbox')).toBe('sb')

    setPlaidSecret('production', 'pr')
    expect(getAccessToken('item_a')).toBe('tok')
    expect(getAccessToken('item_b')).toBe('tok2')
  })
})
