/**
 * Device sync (Phase 4b) — E2E-encrypted snapshot sync between Compass installs,
 * via the relay's ciphertext mailbox (`relay/src/sync.ts`).
 *
 * Model: **snapshot + last-writer-wins.** A push uploads the SAME passphrase-
 * encrypted `.compass-backup` bundle the backup feature produces (comprehensive
 * v3 capture — see `electron/ipc/backup.ts`); a pull fully replaces local state
 * with the newest remote snapshot. If both devices changed between syncs, the
 * older side's changes are lost — like a file synced through a cloud folder.
 * Real per-table merge is the explicitly-deferred v2.
 *
 * Pairing = a shared **sync passphrase**: the sync group id is a SLOW (scrypt)
 * one-way derivation of it (same passphrase on two devices → same mailbox), and
 * the snapshot key is derived separately with a per-blob random salt, so the
 * relay (which sees only groupId + ciphertext) can decrypt nothing. The id IS
 * exposed in URLs, so its derivation deliberately costs as much per guess as
 * attacking the blob — see `syncGroupId`. The passphrase is stored locally in
 * `.vault/device-sync.enc` (AES-256-GCM under the safeStorage-wrapped master
 * key — same trust model as the BYO assistant keys) so pushes don't prompt.
 *
 * Device-LOCAL identity (`relayDeviceToken`, `deviceSyncDeviceId`) deliberately
 * SURVIVES a pull: a restore replaces app_settings wholesale with the pusher's,
 * so we capture ours before and re-write after — two paired devices must not
 * collapse into one identity.
 */

import { randomUUID, scryptSync } from 'node:crypto'
import { getRawSqlite } from '../db/client'
import { buildEncryptedSnapshot, restoreEncryptedSnapshot } from '../ipc/backup'
import { getOrCreateKey, readEncryptedJson, writeEncryptedJson } from '../lib/crypto-vault'
import { DEFAULT_RELAY_URL, getOrCreateDeviceToken } from './relay-client'

const VAULT_NAME = 'device-sync'
const GROUP_ID_SETTING = 'deviceSyncGroupId'
const DEVICE_ID_SETTING = 'deviceSyncDeviceId'
const LAST_SEEN_SETTING = 'deviceSyncLastSeenExportedAt'

/** Client-side bound on a pulled snapshot response. The relay caps PUTs, but
 *  `relayUrl` is user-configurable — a malicious/misconfigured relay must not
 *  be able to OOM the main process with an unbounded GET body. */
const MAX_PULL_BODY_BYTES = 1024 * 1024 * 1024 // 1 GB (envelope incl. base64 overhead)
/** Bound on the small JSON responses (meta / error bodies) from the relay. */
const MAX_SMALL_BODY_BYTES = 64 * 1024

/** Read a small JSON body from an untrusted relay response, refusing anything
 *  oversized (content-length precheck + post-read length check). */
async function readSmallJson(res: Response): Promise<unknown | null> {
  const advertised = Number(res.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > MAX_SMALL_BODY_BYTES) return null
  const text = await res.text()
  if (text.length > MAX_SMALL_BODY_BYTES) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export interface SyncRemoteMeta {
  exportedAt: string
  deviceId: string
  bytes: number
  updatedAt: string
}

/**
 * The sync group id: a SLOW one-way derivation of the passphrase. Entering the
 * same passphrase on another device derives the same mailbox.
 *
 * SECURITY: this id is effectively public — it appears in URLs, so the relay
 * operator and network intermediaries see it. It is therefore derived with
 * scrypt at the SAME cost parameters as the snapshot key (N=2^15, r=8, p=1),
 * using a fixed public context string as the salt (fixed = required for
 * deterministic pairing; the snapshot key uses a different derivation with a
 * random per-blob salt). Result: brute-forcing the passphrase from an observed
 * groupId costs the same scrypt work per guess as attacking the blob itself —
 * a fast hash here would have handed attackers a cheap oracle that bypassed
 * the KDF entirely. Pick a strong passphrase regardless (12-char minimum is
 * enforced; length beats cleverness).
 *
 * MUST stay byte-identical to the mobile companion's implementation.
 */
export function syncGroupId(passphrase: string): string {
  return scryptSync(passphrase, 'compass-device-sync-groupid-v1', 16, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  }).toString('hex')
}

// ── settings helpers (raw sqlite — app_settings) ─────────────────────────────

function readSetting(key: string): string | null {
  try {
    const row = getRawSqlite().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string): void {
  getRawSqlite()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now())
}

function deleteSetting(key: string): void {
  try {
    getRawSqlite().prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  } catch {
    /* absent table/row — nothing to delete */
  }
}

function relayUrl(): string {
  return (readSetting('relayUrl')?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, '')
}

function deviceId(): string {
  const existing = readSetting(DEVICE_ID_SETTING)
  if (existing?.trim()) return existing
  const id = randomUUID()
  writeSetting(DEVICE_ID_SETTING, id)
  return id
}

function readPassphrase(): string | null {
  try {
    const rec = readEncryptedJson<{ passphrase?: string }>(VAULT_NAME, getOrCreateKey())
    return rec?.passphrase?.trim() || null
  } catch {
    return null
  }
}

// ── public surface ────────────────────────────────────────────────────────────

export function configureDeviceSync(passphrase: string): { success: boolean; error?: string } {
  // 12-char floor (vs the backup's 8): the group id derived from this
  // passphrase is visible in URLs, so it faces an offline-guessing surface a
  // local backup file never does. Length is the defense that scales.
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    return { success: false, error: 'Sync passphrase must be at least 12 characters' }
  }
  writeEncryptedJson(VAULT_NAME, { passphrase }, getOrCreateKey())
  writeSetting(GROUP_ID_SETTING, syncGroupId(passphrase))
  deviceId() // ensure a stable local identity exists before the first push/pull
  return { success: true }
}

export function disableDeviceSync(): { success: boolean } {
  writeEncryptedJson(VAULT_NAME, {}, getOrCreateKey())
  deleteSetting(GROUP_ID_SETTING)
  deleteSetting(LAST_SEEN_SETTING)
  return { success: true }
}

export function getDeviceSyncStatus(): {
  configured: boolean
  relayUrl: string
  lastSeenExportedAt: string | null
} {
  return {
    configured: readPassphrase() != null,
    relayUrl: relayUrl(),
    lastSeenExportedAt: readSetting(LAST_SEEN_SETTING)
  }
}

type FetchLike = typeof fetch

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${getOrCreateDeviceToken(getRawSqlite())}`,
    'content-type': 'application/json'
  }
}

/** GET the remote meta + whether it's newer than what this device last saw. */
export async function checkRemote(
  doFetch: FetchLike = fetch
): Promise<
  | { success: true; exists: boolean; meta: SyncRemoteMeta | null; newer: boolean }
  | { success: false; error: string }
> {
  const passphrase = readPassphrase()
  if (!passphrase) return { success: false, error: 'Device sync is not configured' }
  try {
    const res = await doFetch(`${relayUrl()}/sync/meta/${syncGroupId(passphrase)}`, {
      headers: authHeaders()
    })
    if (res.status === 404) return { success: true, exists: false, meta: null, newer: false }
    if (!res.ok) return { success: false, error: `Relay responded ${res.status}` }
    const meta = (await readSmallJson(res)) as SyncRemoteMeta | null
    if (!meta || typeof meta.exportedAt !== 'string') {
      return { success: false, error: 'Relay returned an invalid sync meta' }
    }
    const lastSeen = readSetting(LAST_SEEN_SETTING)
    const newer = !lastSeen || Date.parse(meta.exportedAt) > Date.parse(lastSeen)
    return { success: true, exists: true, meta, newer }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Build + upload a fresh encrypted snapshot (last writer wins). */
export async function pushSnapshot(
  doFetch: FetchLike = fetch
): Promise<
  { success: true; exportedAt: string; bytes: number } | { success: false; error: string }
> {
  const passphrase = readPassphrase()
  if (!passphrase) return { success: false, error: 'Device sync is not configured' }
  try {
    const { blob, exportedAt } = buildEncryptedSnapshot(passphrase)
    const res = await doFetch(`${relayUrl()}/sync/blob/${syncGroupId(passphrase)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ blob: blob.toString('base64'), exportedAt, deviceId: deviceId() })
    })
    if (!res.ok) {
      const detail = (await readSmallJson(res).catch(() => null)) as { error?: string } | null
      return { success: false, error: detail?.error ?? `Relay responded ${res.status}` }
    }
    writeSetting(LAST_SEEN_SETTING, exportedAt)
    return { success: true, exportedAt, bytes: blob.length }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Download the newest remote snapshot and FULLY REPLACE local state with it.
 * Destructive by design (LWW) — callers must confirm with the user first.
 */
export async function pullSnapshot(
  doFetch: FetchLike = fetch
): Promise<
  | { success: true; upToDate: true }
  | { success: true; upToDate: false; exportedAt: string; rows: number }
  | { success: false; error: string }
> {
  const passphrase = readPassphrase()
  if (!passphrase) return { success: false, error: 'Device sync is not configured' }
  const check = await checkRemote(doFetch)
  if (!check.success) return check
  if (!check.exists)
    return {
      success: false,
      error: 'No snapshot on the relay yet — push from the other device first'
    }
  if (!check.newer) return { success: true, upToDate: true }
  try {
    const res = await doFetch(`${relayUrl()}/sync/blob/${syncGroupId(passphrase)}`, {
      headers: authHeaders()
    })
    if (!res.ok) return { success: false, error: `Relay responded ${res.status}` }
    // Bound the response before buffering (when the relay advertises a length)
    // and again after parsing — the envelope string itself is the second check.
    const advertised = Number(res.headers.get('content-length'))
    if (Number.isFinite(advertised) && advertised > MAX_PULL_BODY_BYTES) {
      return { success: false, error: 'Snapshot response is too large to pull safely' }
    }
    const text = await res.text()
    if (text.length > MAX_PULL_BODY_BYTES) {
      return { success: false, error: 'Snapshot response is too large to pull safely' }
    }
    const parsed = JSON.parse(text) as { blob: string; meta: SyncRemoteMeta }
    // Capture device-LOCAL identity before the restore replaces app_settings.
    const localToken = readSetting('relayDeviceToken')
    const localDeviceId = readSetting(DEVICE_ID_SETTING)
    const stats = restoreEncryptedSnapshot(Buffer.from(parsed.blob, 'base64'), passphrase)
    if (localToken) writeSetting('relayDeviceToken', localToken)
    if (localDeviceId) writeSetting(DEVICE_ID_SETTING, localDeviceId)
    writeSetting(LAST_SEEN_SETTING, parsed.meta.exportedAt)
    return { success: true, upToDate: false, exportedAt: parsed.meta.exportedAt, rows: stats.rows }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
