/**
 * Relay client (Phase 4c) — fetch the encrypted snapshot mailbox. Mirrors the
 * envelope contract of `relay/src/sync.ts`; the blob travels base64 inside a
 * JSON envelope and is decrypted on-device by `snapshot.ts`.
 */

import { fromBase64 } from './snapshot'

export interface RemoteMeta {
  exportedAt: string
  deviceId: string
  bytes: number
  updatedAt: string
}

/** Bound on the snapshot envelope we're willing to buffer on a phone. */
const MAX_BODY_BYTES = 256 * 1024 * 1024

function headers(deviceToken: string): Record<string, string> {
  return { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' }
}

const base = (relayUrl: string): string => relayUrl.replace(/\/+$/, '')

export async function fetchMeta(
  relayUrl: string,
  deviceToken: string,
  groupId: string
): Promise<RemoteMeta | null> {
  const res = await fetch(`${base(relayUrl)}/sync/meta/${groupId}`, {
    headers: headers(deviceToken)
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Relay responded ${res.status}`)
  const advertised = Number(res.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > 64 * 1024) {
    throw new Error('Relay returned an oversized meta response')
  }
  const text = await res.text()
  if (text.length > 64 * 1024) throw new Error('Relay returned an oversized meta response')
  return JSON.parse(text) as RemoteMeta

export async function fetchSnapshotBlob(
  relayUrl: string,
  deviceToken: string,
  groupId: string
): Promise<{ blob: Uint8Array; meta: RemoteMeta }> {
  const res = await fetch(`${base(relayUrl)}/sync/blob/${groupId}`, {
    headers: headers(deviceToken)
  })
  if (res.status === 404)
    throw new Error('No snapshot on the relay yet — push from your desktop first')
  if (!res.ok) throw new Error(`Relay responded ${res.status}`)
  const advertised = Number(res.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > MAX_BODY_BYTES) {
    throw new Error('Snapshot is too large for the mobile viewer')
  }
  const text = await res.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('Snapshot is too large for the mobile viewer')
  const parsed = JSON.parse(text) as { blob: string; meta: RemoteMeta }
  return { blob: fromBase64(parsed.blob), meta: parsed.meta }
}
