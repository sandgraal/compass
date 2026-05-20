/**
 * Tests for the Vault IPC handlers (Phase 6.1 — IPC test backfill P0).
 *
 * The vault is the highest-stakes module in the codebase: a regression
 * here can leak credentials or destroy them. These tests use a fully
 * in-memory file system + a deterministic stub `crypto-vault` layer so
 * we can assert behavior without ever touching the real Keychain or
 * `.vault/` directory on disk.
 *
 * Coverage scope:
 *
 *   - Category validation (the security boundary that stops a hostile
 *     renderer from writing outside VAULT_DIR).
 *   - Round-trip add/get/update/delete.
 *   - Update history: snapshot of prior values, capped at 5.
 *   - `seedVaultFromDetectedAccounts` idempotency.
 *   - 1Password CSV import routing (canceled, empty, credit→financial,
 *     login→credentials). The internal CSV parser has its own coverage
 *     elsewhere, so the cases here focus on the handler's branching
 *     rather than parser edge cases.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory FS, keyed by absolute path. Returned `Buffer` instances are
// the same shape `fs` produces in production code.
const fakeFs: Record<string, Buffer> = {}
const writeFileSyncMock = vi.fn<(p: string, data: Buffer) => void>((p, data) => {
  fakeFs[p] = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
})
// Encoding-aware: vault.ts reads encrypted blobs with no encoding (Buffer)
// AND the 1Password CSV with 'utf-8' (string). Mirror both shapes here so
// every test path can use the same fakeFs.
const readFileSyncMock = vi.fn<(p: string, enc?: BufferEncoding) => Buffer | string>((p, enc) => {
  const v = fakeFs[p]
  if (!v) throw new Error(`ENOENT ${p}`)
  return enc ? v.toString(enc) : v
})
const existsSyncMock = vi.fn<(p: string) => boolean>((p) => p in fakeFs)

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock
}))

// Per-test-controllable dialog mock. Default is "canceled" so any test
// that hits a 1Password import path without setting it up gets the
// safe-by-default cancellation behavior.
const showOpenDialogMock = vi
  .fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>()
  .mockResolvedValue({ canceled: true, filePaths: [] })

vi.mock('electron', () => ({
  dialog: { showOpenDialog: showOpenDialogMock }
}))

// Deterministic stub crypto layer. The real one uses safeStorage + AES;
// here we just stamp a prefix so the round-trip is observable without
// the Keychain (which doesn't exist in a Vitest worker).
const STUB_KEY = Buffer.from('stub-key')
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => STUB_KEY,
  encryptBlob: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
  decryptBlob: (blob: Buffer) => blob.toString('utf8').replace(/^enc:/, '')
}))

vi.mock('../paths', () => ({ VAULT_DIR: '/tmp/compass-vault-test' }))

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

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  writeFileSyncMock.mockClear()
  readFileSyncMock.mockClear()
  existsSyncMock.mockClear()
  showOpenDialogMock.mockClear().mockResolvedValue({ canceled: true, filePaths: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

async function load(): Promise<typeof import('./vault')> {
  return import('./vault')
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await load()
  mod.registerVaultHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

/**
 * Invoke a handler the way Electron's `ipcMain.handle` does — wrapping
 * the listener's return (or thrown error) into a Promise. The vault
 * handlers are synchronous and `throw`, but real renderer callers only
 * ever see a rejected Promise. Mirror that here so the tests assert
 * the same surface the production renderer interacts with.
 */
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

const VAULT_FILE = (cat: string): string => `/tmp/compass-vault-test/${cat}.enc`

// Helper: pre-seed an encrypted file with a known list of entries.
function seedFile(category: string, entries: unknown[]): void {
  fakeFs[VAULT_FILE(category)] = Buffer.from(`enc:${JSON.stringify(entries)}`, 'utf8')
}

// ─── vault:get-categories ────────────────────────────────────────────────────

describe('vault:get-categories', () => {
  it('returns the static category list', async () => {
    const h = await registerAndGet('vault:get-categories')
    const out = (await h({})) as Array<{ id: string }>
    expect(out.length).toBeGreaterThanOrEqual(5)
    expect(out.map((c) => c.id)).toEqual(
      expect.arrayContaining(['financial', 'identity', 'credentials', 'medical', 'legal'])
    )
  })
})

// ─── vault:get-entries ───────────────────────────────────────────────────────

describe('vault:get-entries', () => {
  it('rejects an unknown category (path-traversal defense)', async () => {
    // Critical security test: a hostile renderer must not be able to
    // ask for `'../foo'` or `'key'` and read arbitrary files. The
    // category-allowlist check is the line of defense.
    const h = await registerAndGet('vault:get-entries')
    await expect(invoke(h, '../escape')).rejects.toThrow(/Unknown vault category/)
    await expect(invoke(h, 'key')).rejects.toThrow(/Unknown vault category/)
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns [] when the category file does not exist', async () => {
    const h = await registerAndGet('vault:get-entries')
    const out = (await h({}, 'financial')) as unknown[]
    expect(out).toEqual([])
  })

  it('returns decrypted entries when the file exists', async () => {
    seedFile('financial', [{ id: 'a', institution: 'Bank' }])
    const h = await registerAndGet('vault:get-entries')
    const out = (await h({}, 'financial')) as Array<{ institution: string }>
    expect(out).toHaveLength(1)
    expect(out[0].institution).toBe('Bank')
  })

  it('returns [] on a corrupted/undecryptable blob (does not throw)', async () => {
    // If decryptBlob throws (e.g. bad key, tampered ciphertext), the
    // handler swallows the error and returns []. Failing closed here
    // beats crashing the whole IPC — the user sees an "empty" vault
    // and can investigate, which is recoverable. Throwing would just
    // produce an unhandled rejection in the renderer with no UX.
    fakeFs[VAULT_FILE('financial')] = Buffer.from('not-json-after-prefix-strip', 'utf8')
    const h = await registerAndGet('vault:get-entries')
    const out = (await h({}, 'financial')) as unknown[]
    expect(out).toEqual([])
  })
})

// ─── vault:add-entry ─────────────────────────────────────────────────────────

describe('vault:add-entry', () => {
  it('persists the new entry with auto-assigned id + timestamps', async () => {
    const h = await registerAndGet('vault:add-entry')
    const out = (await h({}, 'financial', { institution: 'Chase' })) as {
      id: string
      institution: string
      createdAt: number
      updatedAt: number
    }
    expect(out.id).toMatch(/^[0-9a-f]{16}$/) // 8 random bytes = 16 hex
    expect(out.institution).toBe('Chase')
    expect(out.createdAt).toBeTypeOf('number')
    expect(out.updatedAt).toBeTypeOf('number')
    // File was written
    expect(writeFileSyncMock).toHaveBeenCalledOnce()
    const written = JSON.parse(
      writeFileSyncMock.mock.calls[0][1].toString('utf8').replace(/^enc:/, '')
    )
    expect(written).toHaveLength(1)
    expect(written[0].institution).toBe('Chase')
  })

  it('appends to an existing list rather than replacing', async () => {
    seedFile('financial', [{ id: 'pre', institution: 'WF' }])
    const h = await registerAndGet('vault:add-entry')
    await h({}, 'financial', { institution: 'Chase' })
    const written = JSON.parse(
      writeFileSyncMock.mock.calls[0][1].toString('utf8').replace(/^enc:/, '')
    )
    expect(written).toHaveLength(2)
    expect(written.map((e: { institution: string }) => e.institution)).toEqual(['WF', 'Chase'])
  })

  it('rejects an unknown category', async () => {
    const h = await registerAndGet('vault:add-entry')
    await expect(invoke(h, 'bogus', { x: 1 })).rejects.toThrow(/Unknown vault category/)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })
})

// ─── vault:update-entry ──────────────────────────────────────────────────────

describe('vault:update-entry', () => {
  it('updates fields and snapshots prior state into _history', async () => {
    seedFile('financial', [
      { id: 'a', institution: 'Chase', accountNumber: '1234', createdAt: 1, updatedAt: 2 }
    ])
    const h = await registerAndGet('vault:update-entry')
    const out = (await h({}, 'financial', 'a', { accountNumber: '5678' })) as {
      accountNumber: string
      _history: Array<{ accountNumber: string }>
    }
    expect(out.accountNumber).toBe('5678')
    expect(out._history).toHaveLength(1)
    expect(out._history[0].accountNumber).toBe('1234')
  })

  it('caps _history at the last 5 snapshots', async () => {
    seedFile('financial', [
      {
        id: 'a',
        institution: 'Chase',
        accountNumber: 'current',
        createdAt: 1,
        updatedAt: 2,
        _history: [
          { accountNumber: 'v5' },
          { accountNumber: 'v4' },
          { accountNumber: 'v3' },
          { accountNumber: 'v2' },
          { accountNumber: 'v1' }
        ]
      }
    ])
    const h = await registerAndGet('vault:update-entry')
    const out = (await h({}, 'financial', 'a', { accountNumber: 'newest' })) as {
      _history: Array<{ accountNumber: string }>
    }
    expect(out._history).toHaveLength(5)
    // Newest snapshot pushed to the front; oldest (v1) dropped.
    expect(out._history[0].accountNumber).toBe('current')
    expect(out._history.map((h) => h.accountNumber)).not.toContain('v1')
  })

  it('throws when the entry id is unknown', async () => {
    seedFile('financial', [{ id: 'a', institution: 'Chase' }])
    const h = await registerAndGet('vault:update-entry')
    await expect(invoke(h, 'financial', 'ghost', { x: 1 })).rejects.toThrow(/not found/)
  })

  it('rejects an unknown category', async () => {
    const h = await registerAndGet('vault:update-entry')
    await expect(invoke(h, 'bogus', 'a', { x: 1 })).rejects.toThrow(/Unknown vault category/)
  })
})

// ─── vault:delete-entry ──────────────────────────────────────────────────────

describe('vault:delete-entry', () => {
  it('removes the entry with the given id, leaves others intact', async () => {
    seedFile('financial', [
      { id: 'a', institution: 'A' },
      { id: 'b', institution: 'B' },
      { id: 'c', institution: 'C' }
    ])
    const h = await registerAndGet('vault:delete-entry')
    const out = (await h({}, 'financial', 'b')) as { success: boolean }
    expect(out.success).toBe(true)
    const written = JSON.parse(
      writeFileSyncMock.mock.calls[0][1].toString('utf8').replace(/^enc:/, '')
    )
    expect(written.map((e: { id: string }) => e.id)).toEqual(['a', 'c'])
  })

  it('is a no-op (still returns success) when the id is unknown', async () => {
    // Important for idempotency — clicking delete twice from the UI shouldn't
    // throw "not found" on the second click.
    seedFile('financial', [{ id: 'a' }])
    const h = await registerAndGet('vault:delete-entry')
    const out = (await h({}, 'financial', 'ghost')) as { success: boolean }
    expect(out.success).toBe(true)
  })

  it('rejects an unknown category', async () => {
    const h = await registerAndGet('vault:delete-entry')
    await expect(invoke(h, 'bogus', 'a')).rejects.toThrow(/Unknown vault category/)
  })
})

// ─── seedVaultFromDetectedAccounts ───────────────────────────────────────────

describe('seedVaultFromDetectedAccounts', () => {
  it('returns 0 when given an empty list (does not even read the vault)', async () => {
    const mod = await load()
    expect(mod.seedVaultFromDetectedAccounts([])).toBe(0)
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('creates one stub per new account', async () => {
    const mod = await load()
    const added = mod.seedVaultFromDetectedAccounts([
      {
        name: 'USAA Checking',
        institution: 'USAA',
        type: 'checking',
        sourceFile: 'usaa.csv'
      },
      {
        name: 'Amex Platinum',
        institution: 'American Express',
        type: 'credit',
        lastFour: '1003',
        sourceFile: 'amex.xlsx'
      }
    ])
    expect(added).toBe(2)
    expect(writeFileSyncMock).toHaveBeenCalledOnce()
    const written = JSON.parse(
      writeFileSyncMock.mock.calls[0][1].toString('utf8').replace(/^enc:/, '')
    )
    expect(written).toHaveLength(2)
  })

  it('is idempotent on the institution + type + lastFour signature', async () => {
    seedFile('financial', [
      {
        id: 'existing',
        institution: 'American Express',
        accountType: 'Credit Card',
        accountNumber: '****1003'
      }
    ])
    const mod = await load()
    const added = mod.seedVaultFromDetectedAccounts([
      {
        name: 'Amex Platinum',
        institution: 'American Express',
        type: 'credit',
        lastFour: '1003',
        sourceFile: 'amex.xlsx'
      }
    ])
    expect(added).toBe(0)
  })

  it('matches on the human name when no lastFour is available', async () => {
    seedFile('financial', [
      {
        id: 'existing',
        institution: 'USAA',
        accountType: 'Checking',
        notes: 'imported from USAA Checking — Aug 2025'
      }
    ])
    const mod = await load()
    const added = mod.seedVaultFromDetectedAccounts([
      {
        name: 'USAA Checking',
        institution: 'USAA',
        type: 'checking',
        sourceFile: 'usaa.csv'
      }
    ])
    expect(added).toBe(0)
  })
})

// ─── vault:import-1password-csv ──────────────────────────────────────────────

describe('vault:import-1password-csv', () => {
  it('returns { canceled: true } when the user cancels the dialog', async () => {
    // Default dialog mock is already canceled; just verify the early-return.
    const h = await registerAndGet('vault:import-1password-csv')
    const out = (await invoke(h)) as { success: boolean; canceled?: boolean }
    expect(out).toEqual({ success: false, canceled: true })
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns an error for an empty CSV', async () => {
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/import/empty.csv']
    })
    fakeFs['/import/empty.csv'] = Buffer.from('', 'utf8')
    const h = await registerAndGet('vault:import-1password-csv')
    const out = (await invoke(h)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/empty/i)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('routes credit-card rows to financial and login rows to credentials', async () => {
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/import/1p.csv']
    })
    // Two rows of distinct types — the handler's branching is the
    // contract this test pins down. The internal parser is tested
    // elsewhere; we hand it the exact field shape it produces.
    fakeFs['/import/1p.csv'] = Buffer.from(
      [
        'Type,Title,Username,Password,Url,Notes',
        'Login,GitHub,me@example.com,hunter2,https://github.com,my login',
        'Credit Card,Amex Platinum,,,,ending 1003'
      ].join('\n'),
      'utf8'
    )

    const h = await registerAndGet('vault:import-1password-csv')
    const out = (await invoke(h)) as { success: boolean; imported: number }

    expect(out).toEqual({ success: true, imported: 2 })

    // The handler writes BOTH category files (even if one ends up empty,
    // because it does the write unconditionally). Inspect both blobs.
    const writes = writeFileSyncMock.mock.calls
    const byPath = new Map<string, unknown[]>()
    for (const [p, data] of writes) {
      const decoded = (data as Buffer).toString('utf8').replace(/^enc:/, '')
      byPath.set(p as string, JSON.parse(decoded))
    }
    const credentials = byPath.get(VAULT_FILE('credentials')) as Array<{
      service: string
      username: string
      password: string
    }>
    const financial = byPath.get(VAULT_FILE('financial')) as Array<{
      institution: string
      accountType: string
    }>

    expect(credentials).toHaveLength(1)
    expect(credentials[0]).toMatchObject({
      service: 'GitHub',
      username: 'me@example.com',
      password: 'hunter2'
    })
    expect(financial).toHaveLength(1)
    expect(financial[0]).toMatchObject({
      institution: 'Amex Platinum',
      accountType: 'Credit Card'
    })
  })

  it('appends imported entries to existing vault contents (does not clobber)', async () => {
    // Pre-seed the user's existing credentials. After the import, the
    // pre-existing entry must still be there alongside the new one.
    seedFile('credentials', [{ id: 'pre', service: 'Existing' }])
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/import/1p.csv']
    })
    fakeFs['/import/1p.csv'] = Buffer.from(
      ['Type,Title,Username,Password', 'Login,NewSite,u,p'].join('\n'),
      'utf8'
    )

    const h = await registerAndGet('vault:import-1password-csv')
    await invoke(h)

    const credentialsWrite = writeFileSyncMock.mock.calls.find(
      ([p]) => p === VAULT_FILE('credentials')
    )
    expect(credentialsWrite).toBeDefined()
    const credentials = JSON.parse(
      (credentialsWrite![1] as Buffer).toString('utf8').replace(/^enc:/, '')
    ) as Array<{ id?: string; service?: string }>
    expect(credentials).toHaveLength(2)
    expect(credentials.find((e) => e.id === 'pre')).toBeDefined()
    expect(credentials.find((e) => e.service === 'NewSite')).toBeDefined()
  })
})
