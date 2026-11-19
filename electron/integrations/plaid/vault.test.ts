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
    isAsyncEncryptionAvailable: async () => true,
    // Trivial round-trip: wrap/unwrap with a fixed prefix so the
    // "decrypts back to the original" invariant is testable.
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

beforeEach(async () => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-plaid-vault-'))
})

afterEach(async () => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* tmpdir cleanup is best-effort */
  }
})

describe('plaid vault — secrets', () => {
  it('returns null when no secret has been stored', async () => {
    expect(await getPlaidSecret('sandbox')).toBeNull()
    expect(await getPlaidSecret('development')).toBeNull()
    expect(await getPlaidSecret('production')).toBeNull()
  })

  it('round-trips a secret', async () => {
    await setPlaidSecret('development', 'secret-abc')
    expect(await getPlaidSecret('development')).toBe('secret-abc')
  })

  it('keeps secrets per environment independent', async () => {
    await setPlaidSecret('sandbox', 'sandbox-secret')
    await setPlaidSecret('production', 'prod-secret')
    expect(await getPlaidSecret('sandbox')).toBe('sandbox-secret')
    expect(await getPlaidSecret('production')).toBe('prod-secret')
    expect(await getPlaidSecret('development')).toBeNull()
  })

  it('overwrites on re-set', async () => {
    await setPlaidSecret('sandbox', 'first')
    await setPlaidSecret('sandbox', 'second')
    expect(await getPlaidSecret('sandbox')).toBe('second')
  })

  it('removePlaidSecret deletes only the targeted env', async () => {
    await setPlaidSecret('sandbox', 'sb')
    await setPlaidSecret('production', 'pr')
    await removePlaidSecret('sandbox')
    expect(await getPlaidSecret('sandbox')).toBeNull()
    expect(await getPlaidSecret('production')).toBe('pr')
  })

  it('removePlaidSecret is a no-op when nothing is stored', async () => {
    await expect(removePlaidSecret('development')).resolves.not.toThrow()
  })

  it('rejects empty secret strings', async () => {
    await expect(setPlaidSecret('sandbox', '')).rejects.toThrow(/non-empty/)
  })
})

describe('plaid vault — access tokens', () => {
  it('returns null when no token is stored for an item', async () => {
    expect(await getAccessToken('item_unknown')).toBeNull()
  })

  it('round-trips an access token', async () => {
    await setAccessToken('item_abc', 'access-sandbox-xyz')
    expect(await getAccessToken('item_abc')).toBe('access-sandbox-xyz')
  })

  it('keeps tokens per Item independent', async () => {
    await setAccessToken('item_a', 'token-a')
    await setAccessToken('item_b', 'token-b')
    expect(await getAccessToken('item_a')).toBe('token-a')
    expect(await getAccessToken('item_b')).toBe('token-b')
  })

  it('removeAccessToken deletes only the targeted item', async () => {
    await setAccessToken('item_a', 'token-a')
    await setAccessToken('item_b', 'token-b')
    await removeAccessToken('item_a')
    expect(await getAccessToken('item_a')).toBeNull()
    expect(await getAccessToken('item_b')).toBe('token-b')
  })

  it('listItemIds returns sorted ids without leaking tokens', async () => {
    await setAccessToken('item_b', 'b')
    await setAccessToken('item_a', 'a')
    await setAccessToken('item_c', 'c')
    expect(await listItemIds()).toEqual(['item_a', 'item_b', 'item_c'])
  })

  it('listItemIds returns [] for a fresh vault', async () => {
    expect(await listItemIds()).toEqual([])
  })

  it('rejects empty itemId / token', async () => {
    await expect(setAccessToken('', 'token')).rejects.toThrow(/itemId/)
    await expect(setAccessToken('item_a', '')).rejects.toThrow(/access_token/)
  })

  it('getAccessToken returns null for empty itemId rather than throwing', async () => {
    // Defensive — callers may not have validated input.
    expect(await getAccessToken('')).toBeNull()
  })
})

describe('plaid vault — clear', () => {
  it('clearPlaidVault wipes both secrets and tokens', async () => {
    await setPlaidSecret('sandbox', 'sb')
    await setAccessToken('item_a', 'tok')
    await clearPlaidVault()
    expect(await getPlaidSecret('sandbox')).toBeNull()
    expect(await getAccessToken('item_a')).toBeNull()
    expect(await listItemIds()).toEqual([])
  })

  it('clearPlaidVault is a no-op when the file does not exist', async () => {
    expect(existsSync(join(TMP_VAULT_DIR, 'plaid.enc'))).toBe(false)
    await expect(clearPlaidVault()).resolves.not.toThrow()
  })

  it('clearPlaidVault leaves the encrypted file on disk (overwrites, does not rm)', async () => {
    // On-disk observers shouldn't be able to tell "wiped" apart from
    // "never used".
    await setAccessToken('item_a', 'tok')
    await clearPlaidVault()
    expect(existsSync(join(TMP_VAULT_DIR, 'plaid.enc'))).toBe(true)
  })
})

describe('plaid vault — secrets + tokens coexist', () => {
  it('writing a secret does not clobber tokens (and vice versa)', async () => {
    await setAccessToken('item_a', 'tok')
    await setPlaidSecret('sandbox', 'sb')
    expect(await getAccessToken('item_a')).toBe('tok')
    expect(await getPlaidSecret('sandbox')).toBe('sb')

    await setAccessToken('item_b', 'tok2')
    expect(await getPlaidSecret('sandbox')).toBe('sb')

    await setPlaidSecret('production', 'pr')
    expect(await getAccessToken('item_a')).toBe('tok')
    expect(await getAccessToken('item_b')).toBe('tok2')
  })
})
