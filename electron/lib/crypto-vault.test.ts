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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let TMP_VAULT_DIR: string

// Controllable async safeStorage stand-in. `SAFE:` blobs decrypt normally;
// `OLD:` blobs model ciphertext under a rotated OS key (decryptable, but
// flagged shouldReEncrypt). Hooks let a test mutate key.enc mid-operation.
const ss = vi.hoisted(() => ({
  available: true,
  alwaysReEncrypt: false,
  // Real ciphertext differs on every encrypt (random nonce); model that with a
  // counter in the prefix while alwaysReEncrypt is on.
  nonce: 0,
  onDecrypt: null as null | (() => void),
  onEncrypt: null as null | (() => void)
}))

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => ss.available,
    encryptStringAsync: async (s: string) => {
      ss.onEncrypt?.()
      return Buffer.from(`SAFE${ss.alwaysReEncrypt ? ss.nonce++ : ''}:${s}`, 'utf8')
    },
    decryptStringAsync: async (b: Buffer) => {
      ss.onDecrypt?.()
      const s = b.toString('utf8')
      const safe = /^SAFE\d*:/.exec(s)
      if (safe) return { result: s.slice(safe[0].length), shouldReEncrypt: ss.alwaysReEncrypt }
      if (s.startsWith('OLD:')) return { result: s.slice(4), shouldReEncrypt: true }
      throw new Error('mock safeStorage: invalid blob')
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

beforeEach(async () => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-crypto-vault-'))
  ss.available = true
  ss.alwaysReEncrypt = false
  ss.onDecrypt = null
  ss.onEncrypt = null
})

afterEach(async () => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('getOrCreateKey', () => {
  it('generates a fresh 32-byte key on first call + persists it', async () => {
    const key = await getOrCreateKey()
    expect(key.length).toBe(32)
    expect(existsSync(join(TMP_VAULT_DIR, 'key.enc'))).toBe(true)
  })

  it('returns the SAME key on subsequent calls', async () => {
    const k1 = await getOrCreateKey()
    const k2 = await getOrCreateKey()
    expect(k1.equals(k2)).toBe(true)
  })

  it('persists the key wrapped via safeStorage (mock prefix is present)', async () => {
    await getOrCreateKey()
    const onDisk = readFileSync(join(TMP_VAULT_DIR, 'key.enc')).toString('utf8')
    expect(onDisk.startsWith('SAFE:')).toBe(true)
  })
})

describe('encryptBlob / decryptBlob', () => {
  it('round-trips a string', async () => {
    const key = await getOrCreateKey()
    const blob = encryptBlob('hello world', key)
    expect(decryptBlob(blob, key)).toBe('hello world')
  })

  it('produces a different ciphertext each time (random IV)', async () => {
    const key = await getOrCreateKey()
    const a = encryptBlob('same plaintext', key)
    const b = encryptBlob('same plaintext', key)
    expect(a.equals(b)).toBe(false)
    // Both still decrypt to the same value.
    expect(decryptBlob(a, key)).toBe('same plaintext')
    expect(decryptBlob(b, key)).toBe('same plaintext')
  })

  it('layout puts the IV (16 bytes) and auth tag (16 bytes) before the ciphertext', async () => {
    const key = await getOrCreateKey()
    const blob = encryptBlob('x', key)
    // IV + tag + ≥1 byte of ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(16 + 16 + 1)
  })

  it('throws when the auth tag is tampered with', async () => {
    const key = await getOrCreateKey()
    const blob = encryptBlob('important', key)
    // Flip one bit in the auth tag region (bytes 16..31).
    const tampered = Buffer.from(blob)
    tampered[20] = tampered[20] ^ 0xff
    expect(() => decryptBlob(tampered, key)).toThrow()
  })

  it('throws when decrypted with the wrong key', async () => {
    const blob = encryptBlob('secret', await getOrCreateKey())
    const wrongKey = Buffer.alloc(32, 1)
    expect(() => decryptBlob(blob, wrongKey)).toThrow()
  })

  it('handles unicode + multi-byte content correctly', async () => {
    const key = await getOrCreateKey()
    const plaintext = '🔐 secret · 日本語 · café'
    expect(decryptBlob(encryptBlob(plaintext, key), key)).toBe(plaintext)
  })
})

describe('getOrCreateKey — validation', () => {
  it('throws when the persisted key blob is malformed (wrong hex length)', async () => {
    // Pre-create a bogus key blob via the same SAFE: wrapping the mock uses,
    // but with non-hex content. Reading should refuse rather than silently
    // returning an invalid-length Buffer.
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(join(TMP_VAULT_DIR, 'key.enc'), Buffer.from('SAFE:not-hex-at-all', 'utf8'))
    await expect(getOrCreateKey()).rejects.toThrow(/corrupted/)
  })

  it('throws when the persisted key is short hex (decoded byte length wrong)', async () => {
    const fs = require('node:fs') as typeof import('node:fs')
    // 16 hex chars = 8 bytes, far short of 32 — caught by the hex-length regex.
    fs.writeFileSync(join(TMP_VAULT_DIR, 'key.enc'), Buffer.from('SAFE:abcdef0123456789', 'utf8'))
    await expect(getOrCreateKey()).rejects.toThrow(/corrupted/)
  })
})

describe('readEncryptedJson / writeEncryptedJson', () => {
  it('returns null when the file does not exist', async () => {
    const key = await getOrCreateKey()
    expect(readEncryptedJson('does-not-exist', key)).toBeNull()
  })

  it('round-trips a JSON object', async () => {
    const key = await getOrCreateKey()
    const value = { foo: 'bar', n: 42, nested: { a: [1, 2, 3] } }
    writeEncryptedJson('test', value, key)
    expect(readEncryptedJson('test', key)).toEqual(value)
  })

  it('overwrites on re-write', async () => {
    const key = await getOrCreateKey()
    writeEncryptedJson('test', { v: 1 }, key)
    writeEncryptedJson('test', { v: 2 }, key)
    expect(readEncryptedJson<{ v: number }>('test', key)?.v).toBe(2)
  })

  it('throws on tampered file rather than silently returning null', async () => {
    const key = await getOrCreateKey()
    writeEncryptedJson('test', { v: 1 }, key)
    // Corrupt the file.
    const path = join(TMP_VAULT_DIR, 'test.enc')
    const blob = readFileSync(path)
    blob[20] = blob[20] ^ 0xff
    require('node:fs').writeFileSync(path, blob)
    expect(() => readEncryptedJson('test', key)).toThrow()
  })

  it('rejects names containing path separators or traversal', async () => {
    const key = await getOrCreateKey()
    for (const bad of ['../escape', 'sub/dir', 'foo bar', '..', '']) {
      expect(() => readEncryptedJson(bad, key)).toThrow(/Invalid vault name/)
      expect(() => writeEncryptedJson(bad, { v: 1 }, key)).toThrow(/Invalid vault name/)
    }
  })

  it('rejects the reserved name "key" (which would clobber the master)', async () => {
    const key = await getOrCreateKey()
    expect(() => writeEncryptedJson('key', { v: 1 }, key)).toThrow(/reserved/)
    expect(() => readEncryptedJson('key', key)).toThrow(/reserved/)
  })

  it('atomic write: leaves no .tmp behind on success', async () => {
    const key = await getOrCreateKey()
    writeEncryptedJson('atomic-ok', { v: 1 }, key)
    expect(require('node:fs').existsSync(join(TMP_VAULT_DIR, 'atomic-ok.enc.tmp'))).toBe(false)
    expect(require('node:fs').existsSync(join(TMP_VAULT_DIR, 'atomic-ok.enc'))).toBe(true)
  })
})

describe('getOrCreateKey — async safeStorage semantics', () => {
  const keyPath = (): string => join(TMP_VAULT_DIR, 'key.enc')
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)

  it('reads a key.enc written by the old sync encryptString API unchanged', async () => {
    // The pre-migration sync API produced the same OS-keyed ciphertext the
    // async decrypt accepts — modelled here by the shared SAFE: format.
    writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_A}`, 'utf8'))
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_A)
    expect(readFileSync(keyPath(), 'utf8')).toBe(`SAFE:${HEX_A}`)
  })

  it('concurrent first calls share ONE generated key (no clobbered key.enc)', async () => {
    const keys = await Promise.all([getOrCreateKey(), getOrCreateKey(), getOrCreateKey()])
    expect(keys[0].equals(keys[1]) && keys[1].equals(keys[2])).toBe(true)
    expect(readFileSync(keyPath(), 'utf8')).toBe(`SAFE:${keys[0].toString('hex')}`)
  })

  it('refuses (and writes nothing) when async encryption is unavailable', async () => {
    ss.available = false
    await expect(getOrCreateKey()).rejects.toThrow(/safeStorage unavailable/)
    expect(existsSync(keyPath())).toBe(false)
  })

  it('re-encrypts key.enc in place when safeStorage reports shouldReEncrypt', async () => {
    writeFileSync(keyPath(), Buffer.from(`OLD:${HEX_A}`, 'utf8'))
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_A)
    expect(readFileSync(keyPath(), 'utf8')).toBe(`SAFE:${HEX_A}`)
    expect(existsSync(`${keyPath()}.tmp`)).toBe(false)
  })

  it('does not fail closed when shouldReEncrypt stays true on every read', async () => {
    writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_A}`, 'utf8'))
    ss.alwaysReEncrypt = true
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_A)
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_A)
  })

  it('a re-encrypt never renames over a key.enc a restore wrote meanwhile', async () => {
    writeFileSync(keyPath(), Buffer.from(`OLD:${HEX_A}`, 'utf8'))
    ss.onEncrypt = () => {
      ss.onEncrypt = null // the restore lands while the re-encrypt is awaiting
      writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_B}`, 'utf8'))
    }
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_B)
    expect(readFileSync(keyPath(), 'utf8')).toBe(`SAFE:${HEX_B}`)
  })

  it('returns the NEW key if key.enc is replaced while a decrypt is in flight', async () => {
    writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_A}`, 'utf8'))
    ss.onDecrypt = () => {
      ss.onDecrypt = null // swap once, like a restore landing mid-read
      writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_B}`, 'utf8'))
    }
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_B)
  })

  it('never overwrites a key.enc that appears while a new key is being wrapped', async () => {
    ss.onEncrypt = () => {
      ss.onEncrypt = null
      writeFileSync(keyPath(), Buffer.from(`SAFE:${HEX_A}`, 'utf8'))
    }
    expect((await getOrCreateKey()).toString('hex')).toBe(HEX_A)
    expect(readFileSync(keyPath(), 'utf8')).toBe(`SAFE:${HEX_A}`)
  })
})
