/**
 * Tests for the `auth:connect-github-pat` IPC handler.
 *
 * Scope is intentionally narrow: just the new PAT handler, not the rest of
 * `electron/ipc/auth.ts` (which is in the Phase 6 IPC-test-backfill queue).
 *
 * We stub safeStorage + fs + the DB layer so the handler's stateful
 * side-effects (encrypt → write → DB insert) are observable without touching
 * the user's real keychain or filesystem.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const encryptStringMock = vi.fn<(s: string) => Buffer>((s) => Buffer.from(`encrypted:${s}`, 'utf8'))
const decryptStringMock = vi.fn<(b: Buffer) => string>((b) =>
  b.toString('utf8').replace(/^encrypted:/, '')
)
const writeFileSyncMock = vi.fn<(path: string, data: Buffer) => void>()
const mkdirSyncMock = vi.fn()
const existsSyncMock = vi.fn<() => boolean>(() => false)

// Capture the row inserted into `integrations` so we can assert against it.
const dbInsertSpy = vi.fn()
const dbUpdateSpy = vi.fn()

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: encryptStringMock,
    decryptString: decryptStringMock
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/compass-auth-test' }
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
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
    update: () => ({
      set: (s: unknown) => ({
        where: () => ({
          run: () => dbUpdateSpy(s)
        })
      })
    })
  })
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-auth-test-data' }))

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
  const h = handlers['auth:connect-github-pat']
  if (!h) throw new Error('Handler not registered')
  return h
}

describe('auth:connect-github-pat', () => {
  it('rejects non-string input', async () => {
    const h = await registerAndGetHandler()
    const res = (await h({}, 12345)) as { error?: string }
    expect(res.error).toMatch(/must be a string/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed tokens before hitting the network', async () => {
    const h = await registerAndGetHandler()
    const res = (await h({}, 'not-a-real-pat')) as { error?: string }
    expect(res.error).toMatch(/Personal Access Token/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the validation error for a 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }))
    const h = await registerAndGetHandler()
    const res = (await h({}, `ghp_${'a'.repeat(36)}`)) as { error?: string }
    expect(res.error).toMatch(/rejected by GitHub.*401/)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('happy path: validates, stores, inserts integration row, returns login', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'octocat' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:project, read:user' }
      })
    )
    const h = await registerAndGetHandler()
    const token = `ghp_${'b'.repeat(40)}`
    const res = (await h({}, token)) as { success?: boolean; login?: string; error?: string }

    expect(res.error).toBeUndefined()
    expect(res.success).toBe(true)
    expect(res.login).toBe('octocat')

    // Token written to disk encrypted, with the right payload shape.
    expect(encryptStringMock).toHaveBeenCalledOnce()
    const persisted = JSON.parse(encryptStringMock.mock.calls[0][0])
    expect(persisted).toEqual({
      access_token: token,
      auth_method: 'pat',
      login: 'octocat'
    })

    // Integration row inserted with the granted scopes.
    expect(dbInsertSpy).toHaveBeenCalledOnce()
    const inserted = dbInsertSpy.mock.calls[0][0] as {
      row: { service: string; status: string; scopes: string }
    }
    expect(inserted.row.service).toBe('github')
    expect(inserted.row.status).toBe('connected')
    expect(JSON.parse(inserted.row.scopes)).toEqual(['repo', 'read:project', 'read:user'])
  })

  it('fine-grained PAT (no x-oauth-scopes header) falls back to fine-grained sentinel', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'fg-user' }), { status: 200 })
    )
    const h = await registerAndGetHandler()
    const token = `github_pat_${'c'.repeat(60)}`
    const res = (await h({}, token)) as { success?: boolean }
    expect(res.success).toBe(true)

    const inserted = dbInsertSpy.mock.calls[0][0] as {
      row: { scopes: string }
    }
    expect(JSON.parse(inserted.row.scopes)).toEqual(['fine-grained'])
  })

  it('trims whitespace and accepts tokens with surrounding spaces', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'spacy' }), { status: 200 })
    )
    const h = await registerAndGetHandler()
    const token = `ghp_${'d'.repeat(36)}`
    const res = (await h({}, `   ${token}   \n`)) as { success?: boolean }
    expect(res.success).toBe(true)
    // The PAT sent in the Authorization header should be trimmed, not padded.
    const fetchCall = fetchMock.mock.calls[0]
    const headers = (fetchCall[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe(`Bearer ${token}`)
  })
})
