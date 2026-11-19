/**
 * Encrypted Plaid credential storage (Phase 4.6 — vault layer).
 *
 * Everything Plaid-secret lives in a single blob at `.vault/plaid.enc`:
 *
 *     {
 *       "secrets":      { "<env>": "<plaid_secret>" },
 *       "accessTokens": { "<plaid_item_id>": "<access_token>" }
 *     }
 *
 * Encrypted via the shared `crypto-vault` layer (AES-256-GCM, master
 * key in OS Keychain via safeStorage). The blob is read fresh on every
 * call — no in-memory caching — so token rotation can never expose a
 * stale value, and a corrupted file fails loudly on the next read
 * rather than silently sticking to the cached copy.
 *
 * The Plaid `access_token` for an Item is the credential that lets us
 * call `/transactions/sync` etc. — it MUST stay encrypted on disk and
 * MUST NEVER be passed to the renderer. Only the main process touches
 * this module.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getOrCreateKey, readEncryptedJson, writeEncryptedJson } from '../../lib/crypto-vault'
import { VAULT_DIR } from '../../paths'

export type PlaidEnv = 'sandbox' | 'development' | 'production'

type PlaidVaultShape = {
  secrets: Partial<Record<PlaidEnv, string>>
  accessTokens: Record<string, string>
}

const VAULT_NAME = 'plaid'
const EMPTY_VAULT: PlaidVaultShape = { secrets: {}, accessTokens: {} }

// Every exported mutator awaits the key ONCE, then does its whole
// read → modify → write synchronously. No await may sit between readVault and
// writeVault, or two concurrent callers would both read the old blob and the
// second write would drop the first one's change.
function readVault(key: Buffer): PlaidVaultShape {
  const data = readEncryptedJson<PlaidVaultShape>(VAULT_NAME, key)
  if (!data) return { secrets: {}, accessTokens: {} }
  // Defensive merge in case an older version of the blob has fewer fields.
  return {
    secrets: { ...EMPTY_VAULT.secrets, ...data.secrets },
    accessTokens: { ...EMPTY_VAULT.accessTokens, ...data.accessTokens }
  }
}

function writeVault(data: PlaidVaultShape, key: Buffer): void {
  writeEncryptedJson(VAULT_NAME, data, key)
}

// ─── Plaid API secrets (per-env) ─────────────────────────────────────────────

/**
 * Returns the Plaid API secret for the given environment, or null when
 * none has been stored yet. The caller should treat null as "Plaid is
 * not configured" and surface a setup prompt rather than calling the
 * SDK with an empty string.
 */
export async function getPlaidSecret(env: PlaidEnv): Promise<string | null> {
  return readVault(await getOrCreateKey()).secrets[env] ?? null
}

export async function setPlaidSecret(env: PlaidEnv, secret: string): Promise<void> {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Plaid secret must be a non-empty string')
  }
  const key = await getOrCreateKey()
  const vault = readVault(key)
  vault.secrets[env] = secret
  writeVault(vault, key)
}

/** Remove the secret for a given environment. No-op if absent. */
export async function removePlaidSecret(env: PlaidEnv): Promise<void> {
  const key = await getOrCreateKey()
  const vault = readVault(key)
  if (vault.secrets[env] !== undefined) {
    delete vault.secrets[env]
    writeVault(vault, key)
  }
}

// ─── Plaid access tokens (per-Item) ──────────────────────────────────────────

/**
 * Returns the access token for the given Plaid Item id, or null if
 * we have no token stored for that Item (either it was never connected
 * or the user disconnected it).
 */
export async function getAccessToken(itemId: string): Promise<string | null> {
  if (typeof itemId !== 'string' || itemId.length === 0) return null
  return readVault(await getOrCreateKey()).accessTokens[itemId] ?? null
}

export async function setAccessToken(itemId: string, token: string): Promise<void> {
  if (typeof itemId !== 'string' || itemId.length === 0) {
    throw new Error('Plaid itemId must be a non-empty string')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Plaid access_token must be a non-empty string')
  }
  const key = await getOrCreateKey()
  const vault = readVault(key)
  vault.accessTokens[itemId] = token
  writeVault(vault, key)
}

export async function removeAccessToken(itemId: string): Promise<void> {
  const key = await getOrCreateKey()
  const vault = readVault(key)
  if (vault.accessTokens[itemId] !== undefined) {
    delete vault.accessTokens[itemId]
    writeVault(vault, key)
  }
}

/**
 * Returns the list of Plaid Item ids that have an access token stored.
 * Safe to expose to the renderer — does NOT leak the tokens themselves.
 * Used by the Integrations card to show connection status.
 */
export async function listItemIds(): Promise<string[]> {
  return Object.keys(readVault(await getOrCreateKey()).accessTokens).sort()
}

/**
 * Wipe the Plaid vault entirely. Used on user-initiated "disconnect
 * everything" or when the encrypted file is corrupt. We overwrite the
 * blob with an encrypted-empty form (rather than `unlink`) so on-disk
 * observers can't tell "wiped" from "never used". A no-op if no blob
 * exists yet.
 *
 * Uses the shared `writeEncryptedJson` so any future improvements
 * there (atomic write, audit log, etc.) apply here too.
 */
export async function clearPlaidVault(): Promise<void> {
  const path = join(VAULT_DIR, `${VAULT_NAME}.enc`)
  if (!existsSync(path)) return
  writeVault(EMPTY_VAULT, await getOrCreateKey())
}
