/**
 * Tests for the `auth:connect-linear` IPC handler (Phase 7 Track B).
 * Same harness as auth-notion.test.ts: safeStorage + fs + DB stubbed so the
 * encrypt → write → row-upsert side-effects are observable without touching
 * the real keychain/filesystem/network.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const encryptStringMock = vi.fn<(s: string) => Buffer>((s) => Buffer.from(`encrypted:${s}`, 'utf8'))
const writeFileSyncMock = vi.fn<(path: string, data: Buffer) => void>()
const dbInsertSpy = vi.fn()

vi.mock('electron', () => ({
  safeStorage: { encryptString: encryptStringMock, decryptString: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/compass-auth-linear-test' }
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: writeFileSyncMock
}))

vi.mock('../db/client', () => ({
  getDb: () => ({
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: (cfg: { set: unknown }) => ({
          run: () => dbInsertSpy({ row, set: cfg.set })
        })
      })
    }),
    update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) })
  })
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-auth-linear-test-data' }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  for (const k of Object.keys(handlers)) delete handlers[k]
  encryptStringMock.mockClear()
  writeFileSyncMock.mockClear()
  dbInsertSpy.mockClear()
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function registerAndGetHandler(): Promise<Handler> {
  const mod = await import('./auth')
  mod.registerAuthHandlers(fakeIpcMain as IpcMain)
  const h = handlers['auth:connect-linear']
  if (!h) throw new Error('Handler not registered')
  return h
}

const VALID_KEY = `lin_api_${'a'.repeat(40)}`

describe('auth:connect-linear', () => {
  it('rejects non-strings and malformed keys without any network call', async () => {
    const h = await registerAndGetHandler()
    expect(await h({}, 42)).toMatchObject({ error: expect.stringContaining('string') })
    expect(await h({}, 'ghp_not_a_linear_key')).toMatchObject({
      error: expect.stringContaining("doesn't look like a Linear")
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a GraphQL error body as auth failure and stores nothing', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'authentication failed' }] }), {
        status: 200
      })
    )
    const h = await registerAndGetHandler()
    const r = await h({}, VALID_KEY)
    expect(r).toMatchObject({ error: expect.stringContaining('rejected') })
    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('on success: encrypts + persists the key and upserts the row connected', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: 'u1', name: 'Ada' } } }), { status: 200 })
    )
    const h = await registerAndGetHandler()
    const r = await h({}, ` ${VALID_KEY} `)
    expect(r).toEqual({ success: true, name: 'Ada' })

    const encrypted = encryptStringMock.mock.calls.map((c) => c[0]).join('')
    expect(encrypted).toContain(VALID_KEY)
    expect(writeFileSyncMock).toHaveBeenCalled()
    expect(dbInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ service: 'linear', status: 'connected' })
      })
    )
    // Personal API keys go in Authorization verbatim — NOT as a Bearer token.
    const [, init] = fetchMock.mock.calls[0]
    const auth = (init?.headers as Record<string, string>).Authorization
    expect(auth).toBe(VALID_KEY)
    expect(auth).not.toContain('Bearer')
  })
})
