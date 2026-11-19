/**
 * Tests for the `auth.ts` persistence helpers + the DB/pure IPC handlers
 * (Phase 6.1 — P0).
 *
 * Complements the two existing focused files (auth-google-creds.test.ts,
 * auth-github-pat.test.ts). Scope here:
 *
 *   - Token persistence: saveToken / loadToken / deleteToken — encrypted
 *     round-trip, null on absent, null on corrupt/undecryptable blob.
 *   - OAuth credential store: setOAuthCredentials / getOAuthCredentials /
 *     hasOAuthCredentials / deleteOAuthCredentials — round-trip, the
 *     env-var fallback, the placeholder rejection, and delete.
 *   - auth:disconnect  → deletes the token file + flips the integration row
 *                        to 'disconnected' with lastSyncedAt cleared.
 *   - auth:get-status  → returns integration rows.
 *   - auth:get-redirect-uris → the fixed loopback callback URIs.
 *   - auth:connect-google / auth:connect-github → the credential/env GUARD
 *     CLAUSES only: each returns a plain { error } before opening any window
 *     when creds are missing or placeholders. The guards are pure; the rest
 *     of the dance is out of scope (see below).
 *
 * Out of scope (as in the sibling files): the OAuth dances PAST the guard
 * (auth:connect-google / auth:connect-github happy path) open a real
 * BrowserWindow + HTTP server and are exercised by integration in real
 * Electron — these tests never reach waitForOAuthCode.
 *
 * The DB is a real in-memory SQLite (so disconnect/get-status exercise true
 * SQL); fs + safeStorage are in-memory fakes.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

// safeStorage — reversible "encryption" so round-trips are assertable.
const encryptStringMock = vi.fn<(s: string) => Buffer>((s) => Buffer.from(`enc:${s}`, 'utf8'))
const decryptStringMock = vi.fn<(b: Buffer) => string>((b) => {
  const s = b.toString('utf8')
  if (!s.startsWith('enc:')) throw new Error('bad blob')
  return s.replace(/^enc:/, '')
})

// Flip to false to model a host where the OS keychain/keyring is unusable.
const safeStorageAvailable = vi.hoisted(() => ({ value: true }))

// In-memory fs keyed by absolute path.
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
  safeStorage: {
    isAsyncEncryptionAvailable: async () => safeStorageAvailable.value,
    encryptStringAsync: async (s: string) => encryptStringMock(s),
    decryptStringAsync: async (b: Buffer) => ({
      result: decryptStringMock(b),
      shouldReEncrypt: false
    })
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../paths', () => ({ DATA_DIR: '/tmp/compass-auth-test-data' }))

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

async function authModule() {
  return import('./auth')
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await authModule()
  mod.registerAuthHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

const DATA_DIR = '/tmp/compass-auth-test-data'

beforeEach(async () => {
  safeStorageAvailable.value = true
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

afterEach(async () => {
  sqlite.close()
})

// ── token persistence ────────────────────────────────────────────────────────

describe('token persistence', () => {
  it('saveToken then loadToken round-trips the object through encryption', async () => {
    const { saveToken, loadToken } = await authModule()
    await saveToken('google', { access_token: 'abc', expiry: 123 })
    expect(encryptStringMock).toHaveBeenCalledTimes(1)
    expect(fakeFs[`${DATA_DIR}/compass_token_google.enc`]).toBeDefined()
    expect(await loadToken('google')).toEqual({ access_token: 'abc', expiry: 123 })
  })

  it('saveToken refuses (and writes nothing) when safeStorage is unavailable', async () => {
    const { saveToken } = await authModule()
    safeStorageAvailable.value = false
    await expect(saveToken('google', { access_token: 'abc' })).rejects.toThrow(
      /safeStorage unavailable/
    )
    expect(encryptStringMock).not.toHaveBeenCalled()
    expect(fakeFs[`${DATA_DIR}/compass_token_google.enc`]).toBeUndefined()
  })

  it('concurrent updateToken calls on one service both land (no lost update)', async () => {
    const { saveToken, updateToken, loadToken } = await authModule()
    await saveToken('knot', { a: 1 })
    await Promise.all([
      updateToken('knot', (cur) => ({ ...cur, b: 2 })),
      updateToken('knot', (cur) => ({ ...cur, c: 3 }))
    ])
    expect(await loadToken('knot')).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('deleteToken issued during an in-flight save is applied after it (no resurrection)', async () => {
    const { saveToken, deleteToken, loadToken } = await authModule()
    const save = saveToken('google', { access_token: 'late' })
    const del = deleteToken('google')
    await Promise.all([save, del])
    expect(await loadToken('google')).toBeNull()
  })

  it('updateToken refuses to rebuild an existing but undecryptable token from scratch', async () => {
    const { updateToken } = await authModule()
    const path = `${DATA_DIR}/compass_token_snaptrade.enc`
    fakeFs[path] = Buffer.from('corrupt-blob', 'utf8')
    await expect(updateToken('snaptrade', (cur) => ({ ...cur, userId: 'u' }))).rejects.toThrow()
    expect(fakeFs[path].toString('utf8')).toBe('corrupt-blob')
  })

  it('updateToken writes nothing when the update returns null (e.g. token deleted meanwhile)', async () => {
    const { updateToken, loadToken } = await authModule()
    await updateToken('google', (cur) => (cur ? { ...cur, access_token: 'x' } : null))
    expect(await loadToken('google')).toBeNull()
    expect(encryptStringMock).not.toHaveBeenCalled()
  })

  it('a failed write does not wedge the queue for later writes', async () => {
    const { saveToken, loadToken } = await authModule()
    safeStorageAvailable.value = false
    await expect(saveToken('google', { t: 1 })).rejects.toThrow()
    safeStorageAvailable.value = true
    await saveToken('google', { t: 2 })
    expect(await loadToken('google')).toEqual({ t: 2 })
  })

  it('loadToken returns null when the file is absent', async () => {
    const { loadToken } = await authModule()
    expect(await loadToken('github')).toBeNull()
  })

  it('loadToken returns null (not throw) when the blob cannot be decrypted', async () => {
    const { loadToken } = await authModule()
    // Write a blob that decryptString will reject.
    fakeFs[`${DATA_DIR}/compass_token_google.enc`] = Buffer.from('not-encrypted', 'utf8')
    expect(await loadToken('google')).toBeNull()
  })

  it('deleteToken removes the file and is a no-op when already absent', async () => {
    const { saveToken, deleteToken, loadToken } = await authModule()
    await saveToken('google', { t: 1 })
    await deleteToken('google')
    expect(await loadToken('google')).toBeNull()
    await expect(deleteToken('google')).resolves.not.toThrow()
  })

  it('googleGrantedScopes reads the stored token scope; hasGoogleScope checks membership', async () => {
    const { saveToken, googleGrantedScopes, hasGoogleScope } = await authModule()
    await saveToken('google', {
      access_token: 'abc',
      scope:
        'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly'
    })
    expect(await googleGrantedScopes()).toEqual(['contacts.readonly', 'contacts.other.readonly'])
    expect(await hasGoogleScope('contacts.other.readonly')).toBe(true)
    expect(await hasGoogleScope('directory.readonly')).toBe(false)
  })

  it('googleGrantedScopes is empty when disconnected or the token has no scope', async () => {
    const { saveToken, googleGrantedScopes } = await authModule()
    expect(await googleGrantedScopes()).toEqual([]) // no token
    await saveToken('google', { access_token: 'abc' }) // legacy token, no scope field
    expect(await googleGrantedScopes()).toEqual([])
  })
})

// ── OAuth credential store ───────────────────────────────────────────────────

describe('OAuth credential store', () => {
  const ENV_ID = 'GOOGLE_CLIENT_ID'
  const ENV_SECRET = 'GOOGLE_CLIENT_SECRET'
  let savedId: string | undefined
  let savedSecret: string | undefined

  beforeEach(async () => {
    savedId = process.env[ENV_ID]
    savedSecret = process.env[ENV_SECRET]
    process.env[ENV_ID] = ''
    process.env[ENV_SECRET] = ''
  })
  afterEach(async () => {
    if (savedId === undefined) delete process.env[ENV_ID]
    else process.env[ENV_ID] = savedId
    if (savedSecret === undefined) delete process.env[ENV_SECRET]
    else process.env[ENV_SECRET] = savedSecret
  })

  it('setOAuthCredentials refuses (and writes nothing) when safeStorage is unavailable', async () => {
    const { setOAuthCredentials } = await authModule()
    safeStorageAvailable.value = false
    await expect(
      setOAuthCredentials('google', { clientId: 'id-1', clientSecret: 'secret-1' })
    ).rejects.toThrow(/safeStorage unavailable/)
    expect(Object.keys(fakeFs).some((k) => k.includes('compass_oauth_creds_google'))).toBe(false)
  })

  it('set then get round-trips credentials from the encrypted store', async () => {
    const { setOAuthCredentials, getOAuthCredentials, hasOAuthCredentials } = await authModule()
    await setOAuthCredentials('google', { clientId: 'id-1', clientSecret: 'secret-1' })
    expect(await getOAuthCredentials('google')).toEqual({
      clientId: 'id-1',
      clientSecret: 'secret-1'
    })
    expect(await hasOAuthCredentials('google')).toBe(true)
  })

  it('falls back to env vars when no encrypted store exists', async () => {
    const { getOAuthCredentials } = await authModule()
    process.env[ENV_ID] = 'env-id'
    process.env[ENV_SECRET] = 'env-secret'
    expect(await getOAuthCredentials('google')).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret'
    })
  })

  it('rejects the placeholder env client id', async () => {
    const { getOAuthCredentials, hasOAuthCredentials } = await authModule()
    process.env[ENV_ID] = 'your_google_client_id_here'
    process.env[ENV_SECRET] = 'env-secret'
    expect(await getOAuthCredentials('google')).toBeNull()
    expect(await hasOAuthCredentials('google')).toBe(false)
  })

  it('returns null when neither store nor env is configured', async () => {
    const { getOAuthCredentials } = await authModule()
    expect(await getOAuthCredentials('google')).toBeNull()
  })

  it('deleteOAuthCredentials clears the encrypted store (then falls through to env)', async () => {
    const { setOAuthCredentials, deleteOAuthCredentials, getOAuthCredentials } = await authModule()
    await setOAuthCredentials('google', { clientId: 'id-1', clientSecret: 'secret-1' })
    await deleteOAuthCredentials('google')
    expect(await getOAuthCredentials('google')).toBeNull()
  })
})

// ── auth:disconnect ──────────────────────────────────────────────────────────

describe('auth:disconnect', () => {
  it('deletes the token file and flips the integration row to disconnected', async () => {
    const { saveToken } = await authModule()
    await saveToken('google', { access_token: 'abc' })
    sqlite
      .prepare(
        "INSERT INTO integrations (service, status, last_synced_at) VALUES ('google', 'connected', 999)"
      )
      .run()

    const h = await registerAndGet('auth:disconnect')
    expect(await invoke(h, 'google')).toEqual({ success: true })

    expect(fakeFs[`${DATA_DIR}/compass_token_google.enc`]).toBeUndefined()
    const row = sqlite
      .prepare('SELECT status, last_synced_at AS lastSyncedAt FROM integrations WHERE service = ?')
      .get('google') as { status: string; lastSyncedAt: number | null }
    expect(row).toEqual({ status: 'disconnected', lastSyncedAt: null })
  })
})

// ── auth:get-status ──────────────────────────────────────────────────────────

describe('auth:get-status', () => {
  it('returns all integration rows', async () => {
    sqlite
      .prepare("INSERT INTO integrations (service, status) VALUES ('google', 'connected')")
      .run()
    sqlite
      .prepare("INSERT INTO integrations (service, status) VALUES ('github', 'disconnected')")
      .run()
    const h = await registerAndGet('auth:get-status')
    const rows = (await invoke(h)) as Array<{ service: string; status: string }>
    expect(rows.map((r) => `${r.service}:${r.status}`).sort()).toEqual([
      'github:disconnected',
      'google:connected'
    ])
  })
})

// ── auth:get-redirect-uris ───────────────────────────────────────────────────

describe('auth:get-redirect-uris', () => {
  it('returns the fixed loopback callback URIs', async () => {
    const h = await registerAndGet('auth:get-redirect-uris')
    expect(await invoke(h)).toEqual({
      google: 'http://localhost:4242/oauth/google/callback',
      github: 'http://localhost:4242/oauth/github/callback'
    })
  })
})

// ── connect-handler guard clauses ─────────────────────────────────────────────
//
// The full OAuth dances (auth:connect-google / auth:connect-github) open a real
// BrowserWindow + loopback HTTP server, so the happy path stays an integration
// concern. But each handler runs a pure credential/env guard FIRST and returns
// a plain { error } object before any of that — those branches are pure and
// worth locking down so a regression can't silently strand the connect button.
// Every test here asserts an early return; none reaches waitForOAuthCode.

describe('auth:connect guard clauses', () => {
  // These handlers read process.env directly (github) or via getOAuthCredentials'
  // env fallback (google). Snapshot + restore the four relevant vars so the host
  // environment can't make these flaky, and so we never accidentally supply a
  // full valid credential pair (which would launch the real OAuth window).
  const ENV_KEYS = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET'
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('auth:connect-google returns an error when no credentials are configured', async () => {
    // fakeFs is empty (no encrypted creds) and env is cleared → getOAuthCredentials → null
    const h = await registerAndGet('auth:connect-google')
    const result = (await invoke(h)) as { error?: string; success?: boolean }
    expect(result.success).toBeUndefined()
    expect(result.error).toMatch(/credentials not configured/i)
  })

  it('auth:connect-github errors when GITHUB_CLIENT_ID is missing', async () => {
    const h = await registerAndGet('auth:connect-github')
    const result = (await invoke(h)) as { error?: string }
    expect(result.error).toMatch(/GITHUB_CLIENT_ID not configured/)
  })

  it('auth:connect-github rejects the placeholder client id', async () => {
    process.env.GITHUB_CLIENT_ID = 'your_github_client_id_here'
    process.env.GITHUB_CLIENT_SECRET = 'real-secret'
    const h = await registerAndGet('auth:connect-github')
    const result = (await invoke(h)) as { error?: string }
    expect(result.error).toMatch(/GITHUB_CLIENT_ID not configured/)
  })

  it('auth:connect-github errors when the secret is missing even with a valid client id', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv1.realclientid'
    // GITHUB_CLIENT_SECRET intentionally unset
    const h = await registerAndGet('auth:connect-github')
    const result = (await invoke(h)) as { error?: string }
    expect(result.error).toMatch(/GITHUB_CLIENT_SECRET not configured/)
  })

  it('auth:connect-github rejects the placeholder secret', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv1.realclientid'
    process.env.GITHUB_CLIENT_SECRET = 'your_github_client_secret_here'
    const h = await registerAndGet('auth:connect-github')
    const result = (await invoke(h)) as { error?: string }
    expect(result.error).toMatch(/GITHUB_CLIENT_SECRET not configured/)
  })
})
