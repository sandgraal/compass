/**
 * Snapshot decrypt core (Phase 4c) — the mobile side of Compass device sync.
 *
 * Pure TypeScript over audited pure-JS crypto (@noble/hashes + @noble/ciphers)
 * so it runs in Expo Go with zero native modules. This file MUST stay
 * byte-compatible with the desktop implementations:
 *
 *  - bundle layout + KDF → `electron/ipc/backup.ts` (COMPASSB header, scrypt
 *    N=2^15/r=8/p=1, AES-256-GCM with the tag stored in the header)
 *  - group id            → `electron/integrations/device-sync.ts` syncGroupId
 *                          (SLOW scrypt over a fixed public context — see the
 *                          security note there; the id is URL-visible)
 *
 * The root repo pins that compatibility in
 * `electron/ipc/backup-mobile-compat.test.ts`, which encrypts with the real
 * desktop code and decrypts with THIS file.
 *
 * No React/React-Native imports here — keep it importable from node tests.
 */

import { gcm } from '@noble/ciphers/aes.js'
import { scrypt } from '@noble/hashes/scrypt.js'

const MAGIC = 'COMPASSB' // 8 bytes
const VERSION = 0x02
const SALT_SIZE = 16
const IV_SIZE = 16
const TAG_SIZE = 16
const HEADER_SIZE = MAGIC.length + 1 + SALT_SIZE + IV_SIZE + TAG_SIZE

const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 }

/** The subset of the desktop Bundle the viewer renders. `allTables` is the v3
 *  comprehensive capture; v2 bundles (legacy curated `tables`) also decrypt —
 *  selectors fall back where sensible. */
export interface SnapshotBundle {
  version: 2 | 3
  exportedAt: string
  appVersion: string
  allTables?: Record<string, Record<string, unknown>[]>
  tables?: Record<string, unknown[]>
  knowledge?: Record<string, string>
}

/** Same derivation as desktop `syncGroupId` — deliberately SLOW (scrypt at the
 *  blob-KDF cost) because the id appears in URLs. ~1–2s of pure-JS scrypt on a
 *  phone is a one-time cost at setup. */
export function deriveGroupId(passphrase: string): string {
  const out = scrypt(passphrase, 'compass-device-sync-groupid-v1', {
    ...SCRYPT_PARAMS,
    dkLen: 16
  })
  return toHex(out)
}

/** Decrypt a `.compass-backup` / sync snapshot blob into its JSON bundle. */
export function decryptSnapshot(blob: Uint8Array, passphrase: string): SnapshotBundle {
  if (blob.length <= HEADER_SIZE) throw new Error('Not a Compass snapshot (too short)')
  const magic = asciiSlice(blob, 0, MAGIC.length)
  if (magic !== MAGIC) throw new Error('Not a Compass snapshot')
  const version = blob[MAGIC.length]
  if (version !== VERSION) throw new Error(`Unsupported snapshot version ${version}`)

  let off = MAGIC.length + 1
  const salt = blob.slice(off, off + SALT_SIZE)
  off += SALT_SIZE
  const iv = blob.slice(off, off + IV_SIZE)
  off += IV_SIZE
  const tag = blob.slice(off, off + TAG_SIZE)
  off += TAG_SIZE
  const ciphertext = blob.slice(off)

  const key = scrypt(passphrase, salt, { ...SCRYPT_PARAMS, dkLen: 32 })
  // noble's GCM expects ciphertext||tag; the desktop layout stores the tag in
  // the header, so re-append it.
  const joined = new Uint8Array(ciphertext.length + tag.length)
  joined.set(ciphertext, 0)
  joined.set(tag, ciphertext.length)
  let plaintext: Uint8Array
  try {
    plaintext = gcm(key, iv).decrypt(joined)
  } catch {
    throw new Error('Wrong passphrase or corrupted snapshot')
  }
  const parsed = JSON.parse(utf8Decode(plaintext)) as SnapshotBundle
  if (!parsed || typeof parsed !== 'object' || typeof parsed.exportedAt !== 'string') {
    throw new Error('Snapshot payload structure is invalid')
  }
  return parsed
}

// ── tiny codecs (no Buffer on React Native) ──────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromBase64(b64: string): Uint8Array {
  // atob exists in RN (Hermes) and modern node; fall back to Buffer in node.
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(globalThis.Buffer.from(b64, 'base64'))
}

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i])
  return out
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
