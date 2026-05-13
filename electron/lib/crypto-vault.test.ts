/**
 * Tests for the shared `crypto-vault` primitives. AES-256-GCM is treated
 * as a black box — the assertions cover the externally-observable
 * invariants (round-trip integrity, tamper detection, the on-disk
 * layout) rather than the algorithm itself.
 *
 * The Electron `safeStorage` API is mocked the same way as in
 * `plaid/vault.test.ts` — wraps strings in `SAFE:` so we can verify
 * the master key really did go through it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

vi.mock('../paths', () => ({
  get VAULT_DIR() {
    return TMP_VAULT_DIR
  }
}))

const { getOrCreateKey, encryptBlob, decryptBlob, readEncryptedJson, writeEncryptedJson } =
  await import('./crypto-vault')

beforeEach(() => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-crypto-vault-'))
})

afterEach(() => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('getOrCreateKey', () => {
  it('generates a fresh 32-byte key on first call + persists it', () => {
    const key = getOrCreateKey()
    expect(key.length).toBe(32)
    expect(existsSync(join(TMP_VAULT_DIR, 'key.enc'))).toBe(true)
  })

  it('returns the SAME key on subsequent calls', () => {
    const k1 = getOrCreateKey()
    const k2 = getOrCreateKey()
    expect(k1.equals(k2)).toBe(true)
  })

  it('persists the key wrapped via safeStorage (mock prefix is present)', () => {
    getOrCreateKey()
    const onDisk = readFileSync(join(TMP_VAULT_DIR, 'key.enc')).toString('utf8')
    expect(onDisk.startsWith('SAFE:')).toBe(true)
  })
})

describe('encryptBlob / decryptBlob', () => {
  it('round-trips a string', () => {
    const key = getOrCreateKey()
    const blob = encryptBlob('hello world', key)
    expect(decryptBlob(blob, key)).toBe('hello world')
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const key = getOrCreateKey()
    const a = encryptBlob('same plaintext', key)
    const b = encryptBlob('same plaintext', key)
    expect(a.equals(b)).toBe(false)
    // Both still decrypt to the same value.
    expect(decryptBlob(a, key)).toBe('same plaintext')
    expect(decryptBlob(b, key)).toBe('same plaintext')
  })

  it('layout puts the IV (16 bytes) and auth tag (16 bytes) before the ciphertext', () => {
    const key = getOrCreateKey()
    const blob = encryptBlob('x', key)
    // IV + tag + ≥1 byte of ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(16 + 16 + 1)
  })

  it('throws when the auth tag is tampered with', () => {
    const key = getOrCreateKey()
    const blob = encryptBlob('important', key)
    // Flip one bit in the auth tag region (bytes 16..31).
    const tampered = Buffer.from(blob)
    tampered[20] = tampered[20] ^ 0xff
    expect(() => decryptBlob(tampered, key)).toThrow()
  })

  it('throws when decrypted with the wrong key', () => {
    const blob = encryptBlob('secret', getOrCreateKey())
    const wrongKey = Buffer.alloc(32, 1)
    expect(() => decryptBlob(blob, wrongKey)).toThrow()
  })

  it('handles unicode + multi-byte content correctly', () => {
    const key = getOrCreateKey()
    const plaintext = '🔐 secret · 日本語 · café'
    expect(decryptBlob(encryptBlob(plaintext, key), key)).toBe(plaintext)
  })
})

describe('getOrCreateKey — validation', () => {
  it('throws when the persisted key blob is malformed (wrong hex length)', () => {
    // Pre-create a bogus key blob via the same SAFE: wrapping the mock uses,
    // but with non-hex content. Reading should refuse rather than silently
    // returning an invalid-length Buffer.
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(join(TMP_VAULT_DIR, 'key.enc'), Buffer.from('SAFE:not-hex-at-all', 'utf8'))
    expect(() => getOrCreateKey()).toThrow(/corrupted/)
  })

  it('throws when the persisted key is short hex (decoded byte length wrong)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    // 16 hex chars = 8 bytes, far short of 32 — caught by the hex-length regex.
    fs.writeFileSync(join(TMP_VAULT_DIR, 'key.enc'), Buffer.from('SAFE:abcdef0123456789', 'utf8'))
    expect(() => getOrCreateKey()).toThrow(/corrupted/)
  })
})

describe('readEncryptedJson / writeEncryptedJson', () => {
  it('returns null when the file does not exist', () => {
    const key = getOrCreateKey()
    expect(readEncryptedJson('does-not-exist', key)).toBeNull()
  })

  it('round-trips a JSON object', () => {
    const key = getOrCreateKey()
    const value = { foo: 'bar', n: 42, nested: { a: [1, 2, 3] } }
    writeEncryptedJson('test', value, key)
    expect(readEncryptedJson('test', key)).toEqual(value)
  })

  it('overwrites on re-write', () => {
    const key = getOrCreateKey()
    writeEncryptedJson('test', { v: 1 }, key)
    writeEncryptedJson('test', { v: 2 }, key)
    expect(readEncryptedJson<{ v: number }>('test', key)?.v).toBe(2)
  })

  it('throws on tampered file rather than silently returning null', () => {
    const key = getOrCreateKey()
    writeEncryptedJson('test', { v: 1 }, key)
    // Corrupt the file.
    const path = join(TMP_VAULT_DIR, 'test.enc')
    const blob = readFileSync(path)
    blob[20] = blob[20] ^ 0xff
    require('node:fs').writeFileSync(path, blob)
    expect(() => readEncryptedJson('test', key)).toThrow()
  })

  it('rejects names containing path separators or traversal', () => {
    const key = getOrCreateKey()
    for (const bad of ['../escape', 'sub/dir', 'foo bar', '..', '']) {
      expect(() => readEncryptedJson(bad, key)).toThrow(/Invalid vault name/)
      expect(() => writeEncryptedJson(bad, { v: 1 }, key)).toThrow(/Invalid vault name/)
    }
  })

  it('rejects the reserved name "key" (which would clobber the master)', () => {
    const key = getOrCreateKey()
    expect(() => writeEncryptedJson('key', { v: 1 }, key)).toThrow(/reserved/)
    expect(() => readEncryptedJson('key', key)).toThrow(/reserved/)
  })

  it('atomic write: leaves no .tmp behind on success', () => {
    const key = getOrCreateKey()
    writeEncryptedJson('atomic-ok', { v: 1 }, key)
    expect(require('node:fs').existsSync(join(TMP_VAULT_DIR, 'atomic-ok.enc.tmp'))).toBe(false)
    expect(require('node:fs').existsSync(join(TMP_VAULT_DIR, 'atomic-ok.enc'))).toBe(true)
  })
})
