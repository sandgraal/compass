/**
 * Tests for the Google token-refresh path in `electron/ipc/auth.ts`
 * (Phase 0.7 coverage buffer).
 *
 * `auth.test.ts` + the two sibling files cover token/credential persistence,
 * the connect-handler guards, and disconnect/status. The refresh logic —
 * `refreshGoogleToken` and `getValidGoogleToken` — was untested despite being
 * security-relevant (it's what keeps a connected Google account alive and is
 * called on every sync). This file locks it down:
 *
 *   - refreshGoogleToken → missing-refresh-token throw, missing-credentials
 *     throw, non-OK HTTP throw, and the success path (POSTs grant_type=
 *     refresh_token, merges the new access token back into the stored bundle,
 *     returns it)
 *   - getValidGoogleToken → not-connected throw, returns the cached token when
 *     it's comfortably before expiry, and refreshes when at/near expiry
 *
 * Strategy mirrors auth.test.ts: in-memory fake fs + reversible safeStorage so
 * the real saveToken/loadToken/setOAuthCredentials round-trip; global.fetch is
 * mocked for the refresh HTTP call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-auth-refresh-test' }))

async function authModule() {
  return import('./auth')
}

// Snapshot env so the encrypted-store path (not the .env fallback) is exercised
// deterministically, and nothing leaks between tests.
const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  vi.clearAllMocks()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

function mockFetchOnce(response: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: () => Promise.resolve(response.body ?? {}),
      text: () => Promise.resolve(response.text ?? '')
    })
  ) as unknown as typeof fetch
}

// ── refreshGoogleToken ───────────────────────────────────────────────────────

describe('refreshGoogleToken', () => {
  it('throws when no refresh token is stored', async () => {
    const { saveToken, refreshGoogleToken } = await authModule()
    saveToken('google', { access_token: 'only-access' }) // no refresh_token
    await expect(refreshGoogleToken()).rejects.toThrow(/No refresh token/i)
  })

  it('throws when Google credentials are not configured', async () => {
    const { saveToken, refreshGoogleToken } = await authModule()
    saveToken('google', { refresh_token: 'r1', access_token: 'a1' })
    // no setOAuthCredentials + env cleared → getOAuthCredentials returns null
    await expect(refreshGoogleToken()).rejects.toThrow(/credentials not configured/i)
  })

  it('throws with the HTTP status when the refresh call is rejected', async () => {
    const { saveToken, setOAuthCredentials, refreshGoogleToken } = await authModule()
    saveToken('google', { refresh_token: 'r1', access_token: 'a1' })
    setOAuthCredentials('google', { clientId: 'cid', clientSecret: 'csecret' })
    mockFetchOnce({ ok: false, status: 401, text: 'invalid_grant' })
    await expect(refreshGoogleToken()).rejects.toThrow(/401/)
  })

  it('refreshes, persists the merged bundle, and returns the new access token', async () => {
    const { saveToken, loadToken, setOAuthCredentials, refreshGoogleToken } = await authModule()
    saveToken('google', { refresh_token: 'r1', access_token: 'old-access' })
    setOAuthCredentials('google', { clientId: 'cid', clientSecret: 'csecret' })
    mockFetchOnce({ ok: true, body: { access_token: 'new-access', expires_in: 3600 } })

    const result = await refreshGoogleToken()
    expect(result).toBe('new-access')

    // Persisted: new access token, refresh_token preserved.
    const stored = loadToken('google') as { access_token: string; refresh_token: string }
    expect(stored.access_token).toBe('new-access')
    expect(stored.refresh_token).toBe('r1')

    // Called the Google token endpoint with a refresh_token grant.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('oauth2.googleapis.com/token')
    expect((init as { body: string }).body).toContain('grant_type=refresh_token')
  })
})

// ── getValidGoogleToken ──────────────────────────────────────────────────────

describe('getValidGoogleToken', () => {
  it('throws when Google is not connected', async () => {
    const { getValidGoogleToken } = await authModule()
    await expect(getValidGoogleToken()).rejects.toThrow(/not connected/i)
  })

  it('returns the cached access token when it is well before expiry', async () => {
    const { saveToken, getValidGoogleToken } = await authModule()
    saveToken('google', {
      access_token: 'cached-token',
      refresh_token: 'r1',
      expires_at: Date.now() + 60 * 60 * 1000 // 1h out → no refresh
    })
    global.fetch = vi.fn() as unknown as typeof fetch
    expect(await getValidGoogleToken()).toBe('cached-token')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refreshes when the token is at/near expiry', async () => {
    const { saveToken, setOAuthCredentials, getValidGoogleToken } = await authModule()
    saveToken('google', {
      access_token: 'stale-token',
      refresh_token: 'r1',
      expires_at: Date.now() + 60 * 1000 // 1 min out → inside the 5-min window
    })
    setOAuthCredentials('google', { clientId: 'cid', clientSecret: 'csecret' })
    mockFetchOnce({ ok: true, body: { access_token: 'fresh-token', expires_in: 3600 } })
    expect(await getValidGoogleToken()).toBe('fresh-token')
    expect(global.fetch).toHaveBeenCalledOnce()
  })
})
