/**
 * Device sync (Phase 4b) — configure/push/check/pull against an in-memory
 * app_settings DB, an in-memory vault, a mocked backup façade, and an injected
 * fetch. Pins: groupId derivation (must match the mobile companion), the LWW
 * short-circuit, the destructive-pull flow, and that device-local identity
 * survives a pull (a restore replaces app_settings wholesale).
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getRawSqlite: () => sqlite }))

// In-memory vault: name → value (bypasses safeStorage/master-key entirely).
const vault = new Map<string, unknown>()
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => Buffer.alloc(32, 1),
  readEncryptedJson: (name: string) => vault.get(name) ?? null,
  writeEncryptedJson: (name: string, data: unknown) => {
    vault.set(name, data)
  }
}))

const buildSnapshotMock = vi.fn((_passphrase: string) => ({
  blob: Buffer.from('ciphertext'),
  exportedAt: '2026-07-11T10:00:00.000Z'
}))
const restoreSnapshotMock = vi.fn((_blob: Buffer, _passphrase: string) => ({
  rows: 42,
  vaultFiles: 1,
  knowledgeFiles: 2,
  documentFiles: 0
}))
vi.mock('../ipc/backup', () => ({
  buildEncryptedSnapshot: (p: string) => buildSnapshotMock(p),
  restoreEncryptedSnapshot: (b: Buffer, p: string) => restoreSnapshotMock(b, p)
}))

import {
  checkRemote,
  configureDeviceSync,
  disableDeviceSync,
  getDeviceSyncStatus,
  pullSnapshot,
  pushSnapshot,
  syncGroupId
} from './device-sync'

type FetchMock = ReturnType<typeof vi.fn>

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function setting(key: string): string | null {
  const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value?: string }
    | undefined
  return row?.value ?? null
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(
    'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)'
  )
  vault.clear()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('syncGroupId', () => {
  it('is a stable one-way 32-hex id (the mobile app must derive the identical value)', () => {
    const id = syncGroupId('correct horse battery staple')
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(syncGroupId('correct horse battery staple')).toBe(id)
    expect(syncGroupId('other-passphrase')).not.toBe(id)
  })
})

describe('configure / status / disable', () => {
  it('stores the passphrase in the vault and derives the group id', () => {
    expect(getDeviceSyncStatus().configured).toBe(false)
    const r = configureDeviceSync('sync-pass-123')
    expect(r.success).toBe(true)
    expect(getDeviceSyncStatus().configured).toBe(true)
    expect(setting('deviceSyncGroupId')).toBe(syncGroupId('sync-pass-123'))
    expect(setting('deviceSyncDeviceId')).toMatch(/[0-9a-f-]{36}/)
  })

  it('rejects passphrases under the 12-char floor (the group id faces URL-visible guessing)', () => {
    expect(configureDeviceSync('short').success).toBe(false)
    expect(configureDeviceSync('elevenchars').success).toBe(false) // 11 — old 8-char floor is NOT enough
    expect(configureDeviceSync('twelve-chars').success).toBe(true)
  })

  it('disable forgets the passphrase + group', () => {
    configureDeviceSync('sync-pass-123')
    disableDeviceSync()
    expect(getDeviceSyncStatus().configured).toBe(false)
    expect(setting('deviceSyncGroupId')).toBeNull()
  })
})

describe('pushSnapshot', () => {
  it('PUTs the encrypted snapshot envelope and records lastSeen', async () => {
    configureDeviceSync('sync-pass-123')
    const doFetch = vi.fn(async () => jsonResponse(200, { ok: true, bytes: 10 })) as FetchMock
    const r = await pushSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: true, exportedAt: '2026-07-11T10:00:00.000Z' })

    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://relay.compass.app/sync/blob/${syncGroupId('sync-pass-123')}`)
    expect(init.method).toBe('PUT')
    const envelope = JSON.parse(String(init.body)) as {
      blob: string
      exportedAt: string
      deviceId: string
    }
    expect(Buffer.from(envelope.blob, 'base64').toString()).toBe('ciphertext')
    expect(envelope.deviceId).toBe(setting('deviceSyncDeviceId'))
    expect(setting('deviceSyncLastSeenExportedAt')).toBe('2026-07-11T10:00:00.000Z')
  })

  it('fails cleanly when sync is not configured', async () => {
    const r = await pushSnapshot(vi.fn() as unknown as typeof fetch)
    expect(r).toMatchObject({ success: false })
  })

  it('surfaces a relay error body', async () => {
    configureDeviceSync('sync-pass-123')
    const doFetch = vi.fn(async () =>
      jsonResponse(413, { error: 'Snapshot exceeds the relay blob size limit' })
    )
    const r = await pushSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: false, error: /size limit/ })
  })
})

describe('checkRemote + pullSnapshot (LWW)', () => {
  const META = {
    exportedAt: '2026-07-11T11:00:00.000Z',
    deviceId: 'other-device',
    bytes: 10,
    updatedAt: '2026-07-11T11:00:05.000Z'
  }

  it('short-circuits when the remote snapshot is not newer', async () => {
    configureDeviceSync('sync-pass-123')
    sqlite
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 0)')
      .run('deviceSyncLastSeenExportedAt', '2026-07-11T12:00:00.000Z') // ahead of META
    const doFetch = vi.fn(async () => jsonResponse(200, META))
    const r = await pullSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toEqual({ success: true, upToDate: true })
    expect(restoreSnapshotMock).not.toHaveBeenCalled()
  })

  it('pulls + restores a newer snapshot, preserving device-local identity', async () => {
    configureDeviceSync('sync-pass-123')
    const myDeviceId = setting('deviceSyncDeviceId')
    sqlite
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 0)')
      .run('relayDeviceToken', 'my-bearer-token')

    const doFetch = vi.fn(async (url: string) =>
      url.includes('/sync/meta/')
        ? jsonResponse(200, META)
        : jsonResponse(200, { blob: Buffer.from('remote-cipher').toString('base64'), meta: META })
    )
    const r = await pullSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: true, upToDate: false, rows: 42 })
    expect(restoreSnapshotMock).toHaveBeenCalledTimes(1)
    // LWW bookkeeping + identity survival (a real restore would have replaced these).
    expect(setting('deviceSyncLastSeenExportedAt')).toBe(META.exportedAt)
    expect(setting('deviceSyncDeviceId')).toBe(myDeviceId)
    expect(setting('relayDeviceToken')).toBe('my-bearer-token')
  })

  it('explains an empty mailbox instead of erroring opaquely', async () => {
    configureDeviceSync('sync-pass-123')
    const doFetch = vi.fn(async () => jsonResponse(404, { error: 'No snapshot for this group' }))
    const r = await pullSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: false, error: /push from the other device/i })
  })

  it('checkRemote reports newer=true for a fresh device with an existing mailbox', async () => {
    configureDeviceSync('sync-pass-123')
    const doFetch = vi.fn(async () => jsonResponse(200, META))
    const r = await checkRemote(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: true, exists: true, newer: true })
  })

  it('refuses a blob response whose advertised size exceeds the client cap', async () => {
    configureDeviceSync('sync-pass-123')
    const doFetch = vi.fn(async (url: string) => {
      if (url.includes('/sync/meta/')) return jsonResponse(200, META)
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(2 * 1024 * 1024 * 1024) // 2 GB — over the 1 GB cap
        }
      })
    })
    const r = await pullSnapshot(doFetch as unknown as typeof fetch)
    expect(r).toMatchObject({ success: false, error: /too large/i })
    expect(restoreSnapshotMock).not.toHaveBeenCalled()
  })
})
