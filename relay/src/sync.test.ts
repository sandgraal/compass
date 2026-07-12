/**
 * Device-sync mailbox (Phase 4b) — exercised through `handleRelayRequest` so
 * bearer auth + routing are covered, with an in-memory store. `FsSyncStore`'s
 * atomic write + previous-generation rotation gets its own temp-dir test.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_QUOTA, InMemoryMeteringStore } from './metering.js'
import { type RelayConfig, type RelayRequest, handleRelayRequest } from './server.js'
import { FsSyncStore, type SyncStore, handleSyncRequest } from './sync.js'

class MemStore implements SyncStore {
  map = new Map<string, Buffer>()
  get(key: string): Buffer | null {
    return this.map.get(key) ?? null
  }
  put(key: string, data: Buffer): void {
    this.map.set(key, data)
  }
}

const GID = 'a'.repeat(32)

function cfg(store: SyncStore | null): RelayConfig {
  return {
    env: {},
    store: new InMemoryMeteringStore(),
    quota: DEFAULT_QUOTA,
    clientTokens: new Set(['tok-1']),
    now: () => Date.parse('2026-07-11T12:00:00Z'),
    sync: store ? { store, maxBlobBytes: 1024 } : undefined
  }
}

function req(method: string, path: string, body: string | null = null): RelayRequest {
  return { method, path, query: '', headers: { authorization: 'Bearer tok-1' }, body }
}

function putEnvelope(blob: Buffer, exportedAt = '2026-07-11T11:00:00Z'): string {
  return JSON.stringify({ blob: blob.toString('base64'), exportedAt, deviceId: 'dev-1' })
}

describe('relay /sync routing', () => {
  it('404s when sync is not enabled', async () => {
    const r = await handleRelayRequest(req('GET', `/sync/meta/${GID}`), cfg(null))
    expect(r.status).toBe(404)
    expect(r.body).toMatch(/not enabled/i)
  })

  it('still requires a bearer token', async () => {
    const r = await handleRelayRequest(
      { method: 'GET', path: `/sync/meta/${GID}`, query: '', headers: {}, body: null },
      cfg(new MemStore())
    )
    expect(r.status).toBe(401)
  })

  it('rejects a malformed group id', async () => {
    const r = await handleRelayRequest(req('GET', '/sync/blob/NOT-HEX!'), cfg(new MemStore()))
    expect(r.status).toBe(400)
  })
})

describe('PUT + GET round-trip', () => {
  it('stores a blob and returns it with its meta', async () => {
    const store = new MemStore()
    const c = cfg(store)
    const blob = Buffer.from('ciphertext-bytes')

    const put = await handleRelayRequest(req('PUT', `/sync/blob/${GID}`, putEnvelope(blob)), c)
    expect(put.status).toBe(200)
    expect(JSON.parse(put.body)).toEqual({ ok: true, bytes: blob.length })

    const meta = await handleRelayRequest(req('GET', `/sync/meta/${GID}`), c)
    expect(meta.status).toBe(200)
    expect(JSON.parse(meta.body)).toMatchObject({
      exportedAt: '2026-07-11T11:00:00Z',
      deviceId: 'dev-1',
      bytes: blob.length,
      updatedAt: '2026-07-11T12:00:00.000Z' // server clock (injected now)
    })

    const get = await handleRelayRequest(req('GET', `/sync/blob/${GID}`), c)
    expect(get.status).toBe(200)
    const parsed = JSON.parse(get.body) as { blob: string; meta: { deviceId: string } }
    expect(Buffer.from(parsed.blob, 'base64')).toEqual(blob)
    expect(parsed.meta.deviceId).toBe('dev-1')
  })

  it('404s a group with no snapshot', async () => {
    const r = await handleRelayRequest(req('GET', `/sync/blob/${GID}`), cfg(new MemStore()))
    expect(r.status).toBe(404)
  })

  it('rejects an over-size blob with 413', async () => {
    const r = await handleRelayRequest(
      req('PUT', `/sync/blob/${GID}`, putEnvelope(Buffer.alloc(2048))),
      cfg(new MemStore())
    )
    expect(r.status).toBe(413)
  })

  it('rejects bad envelopes with 400', async () => {
    const c = cfg(new MemStore())
    for (const body of [
      'not-json',
      JSON.stringify({ exportedAt: '2026-01-01T00:00:00Z', deviceId: 'd' }), // no blob
      JSON.stringify({ blob: 'aGk=', exportedAt: 'yesterday-ish', deviceId: 'd' }), // bad date
      JSON.stringify({ blob: 'aGk=', exportedAt: '2026-01-01T00:00:00Z' }) // no deviceId
    ]) {
      const r = await handleRelayRequest(req('PUT', `/sync/blob/${GID}`, body), c)
      expect(r.status, body).toBe(400)
    }
  })

  it('405s an unsupported method', () => {
    const r = handleSyncRequest(req('DELETE', `/sync/blob/${GID}`), {
      store: new MemStore(),
      maxBlobBytes: 1024
    })
    expect(r.status).toBe(405)
  })
})

describe('FsSyncStore', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  it('keeps one previous blob generation on overwrite', () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-sync-'))
    const store = new FsSyncStore(dir)
    store.put(`${GID}.blob`, Buffer.from('gen-1'))
    store.put(`${GID}.blob`, Buffer.from('gen-2'))
    expect(store.get(`${GID}.blob`)?.toString()).toBe('gen-2')
    expect(readFileSync(join(dir, `${GID}.prev`)).toString()).toBe('gen-1')
  })
})
