/**
 * Tests for the Google OAuth credentials IPC layer
 * (`auth:set-google-credentials` + `auth:has-google-credentials`).
 *
 * Scope: just validation + encrypted-store round-trip. The OAuth dance
 * itself (`auth:connect-google`) is out of scope here — it opens a real
 * BrowserWindow + HTTP server and is exercised by integration in real
 * Electron, not Vitest.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreEnvVar } from '../test/env'

const encryptStringMock = vi.fn<(s: string) => Buffer>((s) => Buffer.from(`enc:${s}`, 'utf8'))
const decryptStringMock = vi.fn<(b: Buffer) => string>((b) =>
  b.toString('utf8').replace(/^enc:/, '')
)

// In-memory file system. Keyed by absolute path.
const fakeFs: Record<string, Buffer> = {}
const writeFileSyncMock = vi.fn<(p: string, data: Buffer) => void>((p, data) => {
  fakeFs[p] = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
})
const readFileSyncMock = vi.fn<(p: string) => Buffer>((p) => {
  const v = fakeFs[p]
  if (!v) throw new Error(`ENOENT ${p}`)
  return v
})
const existsSyncMock = vi.fn<(p: string) => boolean>((p) => p in fakeFs)
const unlinkSyncMock = vi.fn<(p: string) => void>((p) => {
  delete fakeFs[p]
})
const mkdirSyncMock = vi.fn()

vi.mock('electron', () => ({
  safeStorage: { encryptString: encryptStringMock, decryptString: decryptStringMock },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/compass-google-test' }
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  unlinkSync: unlinkSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('../db/client', () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => {} }) }) }),
    update: () => ({ set: () => ({ where: () => ({ run: () => {} }) }) })
  })
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-google-test-data' }))

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

// Capture initial env values so tests that mutate them can restore reliably.
// Without this, the "configured=false" case below would leak any pre-existing
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET into later tests when Vitest reuses
// the worker.
const originalEnv = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  encryptStringMock.mockClear()
  writeFileSyncMock.mockClear()
})
afterEach(() => {
  // Restore env to its pre-test state — see comment on originalEnv above.
  restoreEnvVar('GOOGLE_CLIENT_ID', originalEnv.clientId)
  restoreEnvVar('GOOGLE_CLIENT_SECRET', originalEnv.clientSecret)
  vi.unstubAllGlobals()
})

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./auth')
  mod.registerAuthHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

const validId = '123456789012-abcdef.apps.googleusercontent.com'
const validSecret = 'GOCSPX-abcdefghij1234567890'

describe('auth:set-google-credentials', () => {
  it('rejects non-string Client ID', async () => {
    const h = await registerAndGet('auth:set-google-credentials')
    const res = (await h({}, 12345, validSecret)) as { error?: string }
    expect(res.error).toMatch(/must be strings/i)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed Client ID', async () => {
    const h = await registerAndGet('auth:set-google-credentials')
    const res = (await h({}, 'not-a-google-client-id', validSecret)) as { error?: string }
    expect(res.error).toMatch(/Client ID looks wrong/i)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a too-short Client Secret', async () => {
    const h = await registerAndGet('auth:set-google-credentials')
    const res = (await h({}, validId, 'short')) as { error?: string }
    expect(res.error).toMatch(/too short/i)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('happy path: validates, encrypts, writes to disk', async () => {
    const h = await registerAndGet('auth:set-google-credentials')
    const res = (await h({}, validId, validSecret)) as { success?: boolean }

    expect(res.success).toBe(true)
    expect(encryptStringMock).toHaveBeenCalledOnce()
    const written = JSON.parse(encryptStringMock.mock.calls[0][0])
    expect(written).toEqual({ clientId: validId, clientSecret: validSecret })

    // Confirm the file landed where the storage helper expects it.
    expect(writeFileSyncMock).toHaveBeenCalledOnce()
    expect(writeFileSyncMock.mock.calls[0][0]).toMatch(/compass_oauth_creds_google\.enc$/)
  })

  it('trims whitespace around both values before validation', async () => {
    const h = await registerAndGet('auth:set-google-credentials')
    const res = (await h({}, `  ${validId}\n`, `\t${validSecret}  `)) as { success?: boolean }
    expect(res.success).toBe(true)
    const written = JSON.parse(encryptStringMock.mock.calls[0][0])
    expect(written.clientId).toBe(validId)
    expect(written.clientSecret).toBe(validSecret)
  })
})

describe('auth:has-google-credentials', () => {
  it('returns configured=false when neither stored nor in env', async () => {
    process.env.GOOGLE_CLIENT_ID = ''
    process.env.GOOGLE_CLIENT_SECRET = ''
    const h = await registerAndGet('auth:has-google-credentials')
    const res = (await h({})) as { configured: boolean }
    expect(res.configured).toBe(false)
  })

  it('returns configured=true after storing credentials', async () => {
    const set = await registerAndGet('auth:set-google-credentials')
    await set({}, validId, validSecret)
    const has = await registerAndGet('auth:has-google-credentials')
    const res = (await has({})) as { configured: boolean }
    expect(res.configured).toBe(true)
  })

  it('returns configured=true when env-var fallback is set', async () => {
    // afterEach restores both env vars, so no inline cleanup needed.
    process.env.GOOGLE_CLIENT_ID = validId
    process.env.GOOGLE_CLIENT_SECRET = validSecret
    const h = await registerAndGet('auth:has-google-credentials')
    const res = (await h({})) as { configured: boolean }
    expect(res.configured).toBe(true)
  })
})

describe('auth:clear-google-credentials', () => {
  it('removes the encrypted file', async () => {
    const set = await registerAndGet('auth:set-google-credentials')
    await set({}, validId, validSecret)
    expect(Object.keys(fakeFs).some((k) => k.includes('compass_oauth_creds_google.enc'))).toBe(true)

    const clear = await registerAndGet('auth:clear-google-credentials')
    const res = (await clear({})) as { success: boolean }
    expect(res.success).toBe(true)
    expect(Object.keys(fakeFs).some((k) => k.includes('compass_oauth_creds_google.enc'))).toBe(
      false
    )
  })
})
