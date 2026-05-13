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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { VAULT_DIR } from '../paths'

const ALGORITHM = 'aes-256-gcm'
const KEY_SIZE = 32 // 256 bits
const IV_SIZE = 16
const TAG_SIZE = 16

/**
 * Return the master AES key. On first use a new key is generated and
 * persisted at `.vault/key.enc` (encrypted via safeStorage). On every
 * subsequent call the existing key is decrypted and returned.
 */
export function getOrCreateKey(): Buffer {
  const keyPath = join(VAULT_DIR, 'key.enc')
  if (existsSync(keyPath)) {
    const encrypted = readFileSync(keyPath)
    const decrypted = safeStorage.decryptString(encrypted)
    return Buffer.from(decrypted, 'hex')
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

/** Inverse of `encryptBlob`. Throws if the auth tag fails (tampered blob). */
export function decryptBlob(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_SIZE)
  const authTag = blob.subarray(IV_SIZE, IV_SIZE + TAG_SIZE)
  const ciphertext = blob.subarray(IV_SIZE + TAG_SIZE)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

/**
 * Read and decrypt a JSON-encoded blob at `.vault/<name>.enc`. Returns
 * `null` when the file doesn't exist (caller decides what default makes
 * sense). Throws on tamper / wrong-key — that's a hard failure, not a
 * "treat as empty" case.
 */
export function readEncryptedJson<T>(name: string, key: Buffer): T | null {
  const path = join(VAULT_DIR, `${name}.enc`)
  if (!existsSync(path)) return null
  const blob = readFileSync(path)
  const json = decryptBlob(blob, key)
  return JSON.parse(json) as T
}

/** Stringify, encrypt, and atomically write to `.vault/<name>.enc`. */
export function writeEncryptedJson<T>(name: string, data: T, key: Buffer): void {
  const path = join(VAULT_DIR, `${name}.enc`)
  const blob = encryptBlob(JSON.stringify(data), key)
  writeFileSync(path, blob)
}
