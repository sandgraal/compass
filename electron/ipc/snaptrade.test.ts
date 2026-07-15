/**
 * Tests for the SnapTrade IPC layer, focused on `snaptrade:disconnect`.
 *
 * The bug this guards against: SnapTrade stores its BYO partner credentials
 * (clientId/consumerKey) in the SAME encrypted token blob as the
 * connection-derived userId/userSecret. Falling through to the generic
 * `auth:disconnect` would wipe the whole blob, forcing the user to
 * re-enter their partner credentials on every reconnect — unlike Plaid,
 * which keeps dev keys and per-item tokens in separate stores.
 * `snaptrade:disconnect` must drop only userId/userSecret.
 *
 * Same fixture shape as auth.test.ts: real in-memory SQLite for the
 * `integrations` row, in-memory fake fs + reversible safeStorage so
 * saveToken/loadToken round-trip for real.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

const encryptStringMock = vi.fn<(s: string) => Buffer>((s) => Buffer.from(`enc:${s}`, 'utf8'))
const decryptStringMock = vi.fn<(b: Buffer) => string>((b) => {
  const s = b.toString('utf8')
  if (!s.startsWith('enc:')) throw new Error('bad blob')
  return s.replace(/^enc:/, '')
})

const fakeFs: Record<string, Buffer> = {}
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p in fakeFs,
  mkdirSync: vi.fn(),
  readFileSync: (p: string) => {
    const v = fakeFs[p]
    if (!v) throw new Error(`ENOENT ${p}`)
    return v
  },
  unlinkSync: (p: string) => {
    delete fakeFs[p]
  },
  writeFileSync: (p: string, data: Buffer | string) => {
    fakeFs[p] = Buffer.isBuffer(data) ? data : Buffer.from(data)
  }
}))

vi.mock('electron', () => ({
  safeStorage: { encryptString: encryptStringMock, decryptString: decryptStringMock },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-snaptrade-test-data' }))

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./snaptrade')
  mod.registerSnaptradeHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  vi.clearAllMocks()
})

afterEach(() => {
  sqlite.close()
})

describe('snaptrade:disconnect', () => {
  it('preserves clientId/consumerKey but drops userId/userSecret', async () => {
    const { setSnaptradeByoCreds } = await import('../integrations/snaptrade')
    setSnaptradeByoCreds('my-client-id', 'my-consumer-key')

    // Simulate a completed connection by writing userId/userSecret directly
    // via the same saveToken path setSnaptradeByoCreds uses internally.
    const { saveToken, loadToken } = await import('./auth')
    saveToken('snaptrade', {
      ...(loadToken('snaptrade') as object),
      userId: 'compass-abc123',
      userSecret: 'shh-per-user-secret'
    })
    sqlite
      .prepare(
        "INSERT INTO integrations (service, status, last_synced_at) VALUES ('snaptrade', 'connected', 999)"
      )
      .run()

    const h = await registerAndGet('snaptrade:disconnect')
    expect(await invoke(h)).toEqual({ success: true })

    const tok = loadToken('snaptrade') as {
      clientId?: string
      consumerKey?: string
      userId?: string
      userSecret?: string
    }
    expect(tok.clientId).toBe('my-client-id')
    expect(tok.consumerKey).toBe('my-consumer-key')
    expect(tok.userId).toBeUndefined()
    expect(tok.userSecret).toBeUndefined()

    const row = sqlite
      .prepare('SELECT status, last_synced_at AS lastSyncedAt FROM integrations WHERE service = ?')
      .get('snaptrade') as { status: string; lastSyncedAt: number | null }
    expect(row).toEqual({ status: 'disconnected', lastSyncedAt: null })
  })

  it('is a no-op on credentials when nothing was ever connected', async () => {
    const h = await registerAndGet('snaptrade:disconnect')
    expect(await invoke(h)).toEqual({ success: true })

    const { loadToken } = await import('./auth')
    expect(loadToken('snaptrade')).toEqual({ clientId: undefined, consumerKey: undefined })
  })
})
