/**
 * Encrypted-blob primitives shared by every on-disk vault file in
 * `.vault/`. Extracted from `electron/ipc/vault.ts` so the Plaid token
 * vault can reuse the exact same master-key + AES-256-GCM layout
 * without duplicating crypto code.
 *
 * Layout of an encrypted blob on disk:
 *
 *     [IV (16 bytes)] [authTag (16 bytes)] [ciphertext (variable)]
 *
 * The master AES key lives at `.vault/key.enc`. Its plaintext form
 * never touches disk: the hex-encoded key is encrypted via Electron's
 * `safeStorage` (which uses the OS Keychain on macOS) and the encrypted
 * blob is what gets persisted. First call to `getOrCreateKey()` after
 * a fresh install generates a new key and writes it; subsequent calls
 * decrypt the existing one.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { VAULT_DIR } from '../paths'

const ALGORITHM = 'aes-256-gcm'
const KEY_SIZE = 32 // 256 bits
const IV_SIZE = 16
const TAG_SIZE = 16

/**
 * Names allowed in `readEncryptedJson` / `writeEncryptedJson`. The only
 * caller pattern is `vault('plaid')`, `vault('financial')`, etc. — simple
 * alphanumeric tokens — so this regex rejects path traversal (`../`),
 * directory separators, and the reserved `key` name (which would clobber
 * the master-key blob).
 */
const SAFE_VAULT_NAME = /^[A-Za-z0-9_-]{1,64}$/

function assertSafeVaultName(name: string): void {
  if (!SAFE_VAULT_NAME.test(name)) {
    throw new Error(`Invalid vault name: ${name}`)
  }
  if (name === 'key') {
    throw new Error('Vault name "key" is reserved for the master key')
  }
}

/**
 * Return the master AES key. On first use a new key is generated and
 * persisted at `.vault/key.enc` (encrypted via safeStorage). On every
 * subsequent call the existing key is decrypted and returned.
 *
 * Throws if `safeStorage` isn't available on the host (would mean the
 * persisted blob is unreadable) or if the decrypted material doesn't
 * round-trip into a 32-byte buffer (corrupted file or wrong format).
 */
export function getOrCreateKey(): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage is not available — cannot read/write the vault master key. ' +
        'On macOS this means Keychain access is broken; check OS state.'
    )
  }

  const keyPath = join(VAULT_DIR, 'key.enc')
  if (existsSync(keyPath)) {
    const encrypted = readFileSync(keyPath)
    const decrypted = safeStorage.decryptString(encrypted)
    // The persisted form is a 64-char hex string. Reject anything else
    // loudly — a malformed key would produce subtle downstream crypto
    // errors (e.g. "invalid key length") that are hard to diagnose.
    if (!/^[0-9a-fA-F]{64}$/.test(decrypted)) {
      throw new Error(
        `Vault master key is corrupted (expected 64 hex chars, got ${decrypted.length})`
      )
    }
    const key = Buffer.from(decrypted, 'hex')
    if (key.length !== KEY_SIZE) {
      throw new Error(`Vault master key has wrong byte length: ${key.length}`)
    }
    return key
  }

  const key = randomBytes(KEY_SIZE)
  const encryptedKey = safeStorage.encryptString(key.toString('hex'))
  writeFileSync(keyPath, encryptedKey)
  return key
}

/** AES-256-GCM encrypt with a fresh random IV. Returns the blob layout above. */
export function encryptBlob(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_SIZE)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext])
}

/**
 * Inverse of `encryptBlob`. Throws if the auth tag fails (tampered blob).
 *
 * The plaintext is reassembled by concatenating buffers BEFORE
 * `toString('utf8')` — so a multi-byte codepoint that straddles the
 * `update` / `final` boundary survives intact. Doing `update(...) +
 * final('utf8')` would have implicitly stringified the update output
 * with the default encoding and potentially split the codepoint.
 */
export function decryptBlob(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_SIZE)
  const authTag = blob.subarray(IV_SIZE, IV_SIZE + TAG_SIZE)
  const ciphertext = blob.subarray(IV_SIZE + TAG_SIZE)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Read and decrypt a JSON-encoded blob at `.vault/<name>.enc`. Returns
 * `null` when the file doesn't exist (caller decides what default makes
 * sense). Throws on tamper / wrong-key — that's a hard failure, not a
 * "treat as empty" case. Also throws if `name` contains path traversal
 * or directory separators.
 */
export function readEncryptedJson<T>(name: string, key: Buffer): T | null {
  assertSafeVaultName(name)
  const path = join(VAULT_DIR, `${name}.enc`)
  if (!existsSync(path)) return null
  const blob = readFileSync(path)
  const json = decryptBlob(blob, key)
  return JSON.parse(json) as T
}

/**
 * Stringify, encrypt, and write to `.vault/<name>.enc`. Atomic: the
 * encrypted bytes go to a sibling `.tmp` file first and are then renamed
 * over the target. A crash mid-write leaves the previous good blob
 * intact (modulo filesystem semantics — rename is atomic on macOS/APFS
 * and on Linux).
 */
export function writeEncryptedJson<T>(name: string, data: T, key: Buffer): void {
  assertSafeVaultName(name)
  const path = join(VAULT_DIR, `${name}.enc`)
  const tmpPath = `${path}.tmp`
  const blob = encryptBlob(JSON.stringify(data), key)
  writeFileSync(tmpPath, blob)
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    // Best-effort cleanup of the temp file on rename failure.
    try {
      unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}
