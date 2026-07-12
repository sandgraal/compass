/**
 * Device-sync blob store (Phase 4b) — the ONE deliberate exception to the
 * relay's "stores no user data" charter, and a narrow one: it holds a single
 * passphrase-encrypted snapshot blob per sync group that the server CANNOT
 * read (AES-256-GCM, key derived on-device from a passphrase that never
 * leaves the clients). The relay is a ciphertext mailbox, not a data custodian.
 *
 * Opt-in: the whole module is inert unless `RELAY_SYNC_DIR` is set (see
 * index.ts). Auth rides the same bearer-token gate as the aggregator proxy.
 *
 * Model: snapshot + last-writer-wins. A sync GROUP is identified by a
 * client-derived id — scrypt(passphrase, fixed public context) hex — so
 * entering the same passphrase on two devices pairs them. The id appears in
 * URLs (the relay + intermediaries see it), which is why clients derive it
 * with a SLOW KDF at the same cost as the snapshot key: guessing a passphrase
 * from an observed groupId costs as much as attacking the blob itself.
 *
 * Note: any operator-allowlisted bearer token can read/write any groupId — a
 * structural property of passphrase pairing (two different device tokens must
 * reach the same group). Reads yield only ciphertext; writes are an
 * availability concern among the operator's own allowlisted devices.
 *
 * Endpoints (JSON envelopes; blobs travel base64 through the string pipeline):
 *   PUT /sync/blob/<groupId>   { blob, exportedAt, deviceId } → { ok, bytes }
 *   GET /sync/blob/<groupId>   → { blob, meta }
 *   GET /sync/meta/<groupId>   → meta               (cheap "is remote newer?")
 *
 * Durability: the filesystem store writes tmp→rename (atomic on POSIX) and
 * keeps ONE previous generation (`.prev`) as a manual recovery escape hatch.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RelayRequest, RelayResponse } from './server.js'

/** groupId shape — a client-side hash, never a user-chosen string. */
const GROUP_ID_RE = /^[a-f0-9]{16,64}$/

export interface SyncMeta {
  exportedAt: string // ISO timestamp of the snapshot INSIDE the blob (client-asserted)
  deviceId: string // opaque uuid of the pushing device (NOT its bearer token)
  bytes: number // decoded blob size
  updatedAt: string // ISO timestamp of the PUT (server clock)
}

/** Storage seam — filesystem in production, in-memory in tests. Keys are built
 *  internally from a regex-validated groupId + fixed suffixes; implementations
 *  never see user-controlled filenames. */
export interface SyncStore {
  get(key: string): Buffer | null
  put(key: string, data: Buffer): void
}

export type SyncConfig = {
  store: SyncStore
  /** Max DECODED blob size accepted on PUT. */
  maxBlobBytes: number
}

/** Filesystem store: tmp→rename atomic writes; `.blob` puts rotate the previous
 *  generation to `.prev` before replacing. */
export class FsSyncStore implements SyncStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  get(key: string): Buffer | null {
    try {
      return readFileSync(join(this.dir, key))
    } catch {
      return null
    }
  }
  put(key: string, data: Buffer): void {
    const full = join(this.dir, key)
    const tmp = `${full}.tmp`
    writeFileSync(tmp, data)
    if (key.endsWith('.blob') && this.get(key) !== null) {
      try {
        renameSync(full, `${full.slice(0, -'.blob'.length)}.prev`)
      } catch {
        /* best-effort generation keep — never blocks the new write */
      }
    }
    renameSync(tmp, full)
  }
}

function json(status: number, obj: unknown): RelayResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }
}

/** Handle a `/sync/…` request. Caller has already passed bearer auth. */
export function handleSyncRequest(
  req: RelayRequest,
  sync: SyncConfig,
  now: () => number = Date.now
): RelayResponse {
  const method = req.method.toUpperCase()
  const m = req.path.match(/^\/sync\/(blob|meta)\/([^/]+)$/)
  if (!m) return json(404, { error: 'Unknown sync endpoint' })
  const [, kind, groupId] = m
  if (!GROUP_ID_RE.test(groupId)) return json(400, { error: 'Invalid sync group id' })

  const blobKey = `${groupId}.blob`
  const metaKey = `${groupId}.meta`

  if (kind === 'meta' && method === 'GET') {
    const meta = sync.store.get(metaKey)
    if (!meta) return json(404, { error: 'No snapshot for this group' })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: meta.toString('utf8')
    }
  }

  if (kind === 'blob' && method === 'GET') {
    const blob = sync.store.get(blobKey)
    const meta = sync.store.get(metaKey)
    if (!blob || !meta) return json(404, { error: 'No snapshot for this group' })
    return json(200, { blob: blob.toString('base64'), meta: JSON.parse(meta.toString('utf8')) })
  }

  if (kind === 'blob' && method === 'PUT') {
    let envelope: { blob?: unknown; exportedAt?: unknown; deviceId?: unknown }
    try {
      envelope = JSON.parse(req.body ?? '')
    } catch {
      return json(400, { error: 'Body must be a JSON envelope' })
    }
    if (typeof envelope.blob !== 'string' || envelope.blob.length === 0) {
      return json(400, { error: 'Missing blob' })
    }
    if (typeof envelope.exportedAt !== 'string' || Number.isNaN(Date.parse(envelope.exportedAt))) {
      return json(400, { error: 'Missing or invalid exportedAt' })
    }
    if (typeof envelope.deviceId !== 'string' || envelope.deviceId.length > 64) {
      return json(400, { error: 'Missing or invalid deviceId' })
    }
    let decoded: Buffer
    try {
      decoded = Buffer.from(envelope.blob, 'base64')
    } catch {
      return json(400, { error: 'Blob is not valid base64' })
    }
    if (decoded.length === 0) return json(400, { error: 'Blob is empty' })
    if (decoded.length > sync.maxBlobBytes) {
      return json(413, { error: 'Snapshot exceeds the relay blob size limit' })
    }
    const meta: SyncMeta = {
      exportedAt: envelope.exportedAt,
      deviceId: envelope.deviceId,
      bytes: decoded.length,
      updatedAt: new Date(now()).toISOString()
    }
    // Blob first, meta second: a crash between the two leaves a newer blob with
    // older meta — clients compare meta.exportedAt, so worst case they re-pull.
    sync.store.put(blobKey, decoded)
    sync.store.put(metaKey, Buffer.from(JSON.stringify(meta), 'utf8'))
    return json(200, { ok: true, bytes: decoded.length })
  }

  return json(405, { error: 'Method not allowed' })
}
