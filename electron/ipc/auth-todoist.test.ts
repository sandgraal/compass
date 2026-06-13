/**
 * Tests for the `auth:connect-todoist` IPC handler (Phase 7 Track B).
 * Same harness as auth-linear.test.ts: safeStorage + fs + DB stubbed so the
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
  app: { getPath: () => '/tmp/compass-auth-todoist-test' }
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

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-auth-todoist-test-data' }))

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
  const h = handlers['auth:connect-todoist']
  if (!h) throw new Error('Handler not registered')
  return h
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef01234567'

describe('auth:connect-todoist', () => {
  it('rejects non-strings and malformed tokens without any network call', async () => {
    const h = await registerAndGetHandler()
    expect(await h({}, 42)).toMatchObject({ error: expect.stringContaining('string') })
    expect(await h({}, 'short')).toMatchObject({
      error: expect.stringContaining("doesn't look like a Todoist")
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 401 as auth failure and stores nothing', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 401 }))
    const h = await registerAndGetHandler()
    const r = await h({}, VALID_TOKEN)
    expect(r).toMatchObject({ error: expect.stringContaining('rejected') })
    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('on success: encrypts + persists the token (Bearer) and upserts the row connected', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }))
    const h = await registerAndGetHandler()
    const r = await h({}, ` ${VALID_TOKEN} `)
    expect(r).toEqual({ success: true })

    const encrypted = encryptStringMock.mock.calls.map((c) => c[0]).join('')
    expect(encrypted).toContain(VALID_TOKEN)
    expect(writeFileSyncMock).toHaveBeenCalled()
    expect(dbInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ service: 'todoist', status: 'connected' })
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_TOKEN}`)
  })
})
