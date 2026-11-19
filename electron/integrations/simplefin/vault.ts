/**
 * Encrypted SimpleFIN credential storage (Phase 4.7 — vault layer).
 *
 * SimpleFIN's long-lived secret is the **Access URL** — a string of the form
 * `https://<user>:<pass>@bridge.simplefin.org/simplefin` whose userinfo IS the
 * HTTP Basic credential used to read the user's financial data. It is the
 * SimpleFIN equivalent of a Plaid `access_token` and MUST be treated with the
 * same care: encrypted on disk, never logged, never passed to the renderer.
 *
 * All Access URLs live in a single blob at `.vault/simplefin.enc`:
 *
 *     { "accessUrls": { "<connectionId>": "<accessUrl>" } }
 *
 * Encrypted via the shared `crypto-vault` layer (AES-256-GCM, master key in OS
 * Keychain via safeStorage). The blob is read fresh on every call — no
 * in-memory caching — mirroring the Plaid vault so a corrupted file fails
 * loudly on the next read rather than silently sticking to a stale copy.
 *
 * Only the main process touches this module.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getOrCreateKey, readEncryptedJson, writeEncryptedJson } from '../../lib/crypto-vault'
import { VAULT_DIR } from '../../paths'

type SimplefinVaultShape = {
  accessUrls: Record<string, string>
}

const VAULT_NAME = 'simplefin'
const EMPTY_VAULT: SimplefinVaultShape = { accessUrls: {} }

// Mutators await the key ONCE, then read → modify → write synchronously (no
// await in between), so concurrent callers can't drop each other's writes.
function readVault(key: Buffer): SimplefinVaultShape {
  const data = readEncryptedJson<SimplefinVaultShape>(VAULT_NAME, key)
  if (!data) return { accessUrls: {} }
  // Defensive merge in case an older version of the blob has fewer fields.
  return { accessUrls: { ...EMPTY_VAULT.accessUrls, ...data.accessUrls } }
}

function writeVault(data: SimplefinVaultShape, key: Buffer): void {
  writeEncryptedJson(VAULT_NAME, data, key)
}

/**
 * Validate that a string is a usable SimpleFIN Access URL: parseable, https,
 * and carrying embedded `user:pass@` userinfo. Returns the parsed URL on
 * success; throws (loudly) otherwise so a malformed claim never gets stored
 * and then mysteriously fails at sync time. Exported for the client + tests.
 */
export function assertValidAccessUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('SimpleFIN access URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('SimpleFIN access URL must be https')
  }
  if (parsed.username.length === 0) {
    throw new Error('SimpleFIN access URL is missing embedded credentials')
  }
  return parsed
}

/**
 * Returns the Access URL for the given connection id, or null if none is
 * stored (either never claimed or the user disconnected it).
 */
export async function getAccessUrl(connectionId: string): Promise<string | null> {
  if (typeof connectionId !== 'string' || connectionId.length === 0) return null
  return readVault(await getOrCreateKey()).accessUrls[connectionId] ?? null
}

export async function setAccessUrl(connectionId: string, url: string): Promise<void> {
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new Error('SimpleFIN connectionId must be a non-empty string')
  }
  assertValidAccessUrl(url) // throws on https/userinfo violations
  const key = await getOrCreateKey()
  const vault = readVault(key)
  vault.accessUrls[connectionId] = url
  writeVault(vault, key)
}

export async function removeAccessUrl(connectionId: string): Promise<void> {
  const key = await getOrCreateKey()
  const vault = readVault(key)
  if (vault.accessUrls[connectionId] !== undefined) {
    delete vault.accessUrls[connectionId]
    writeVault(vault, key)
  }
}

/**
 * Returns the list of connection ids that have an Access URL stored. Safe to
 * expose to the renderer — does NOT leak the URLs (which embed credentials)
 * themselves. Used by the Integrations card to show connection status.
 */
export async function listConnectionIds(): Promise<string[]> {
  return Object.keys(readVault(await getOrCreateKey()).accessUrls).sort()
}

/**
 * Wipe the SimpleFIN vault entirely. Overwrites with an encrypted-empty form
 * (rather than `unlink`) so on-disk observers can't tell "wiped" from "never
 * used". No-op if no blob exists yet. Mirrors `clearPlaidVault`.
 */
export async function clearSimplefinVault(): Promise<void> {
  const path = join(VAULT_DIR, `${VAULT_NAME}.enc`)
  if (!existsSync(path)) return
  writeVault(EMPTY_VAULT, await getOrCreateKey())
}
