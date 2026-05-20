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
 *
 * The 1Password import handler is intentionally NOT tested here — it's
 * dialog-driven and the parser path is exercised separately.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory FS, keyed by absolute path. Returned `Buffer` instances are
// the same shape `fs` produces in production code.
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

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
  }
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
