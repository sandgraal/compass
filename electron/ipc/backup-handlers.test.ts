/**
 * Tests for the backup IPC handlers + the collect/restore round-trip in
 * `electron/ipc/backup.ts` (Phase 0.7 coverage backfill).
 *
 * The existing `backup.test.ts` covers the pure crypto layer (encrypt/decrypt,
 * header/version/tamper validation, path-safety helpers) against a hand-rolled
 * bundle. This file covers the parts that touch real data + plumbing:
 *
 *   - collectBundle → applyRestore round-trip: seed a full (migrated) DB +
 *     knowledge/vault files, capture a bundle, mutate state, then restore and
 *     assert the DB rows, knowledge markdown, vault blobs, and rewrapped
 *     key.enc all come back.
 *   - backup:create handler → passphrase guard (<8 chars), user-canceled
 *     dialog, and the success path (encrypted file written + stats).
 *   - backup:restore handler → passphrase guard (empty), canceled dialog, and
 *     the success path reading back a file create just wrote (end-to-end).
 *
 * Strategy: a REAL in-memory SQLite built from the project's actual Drizzle
 * migrations (so collectBundle's 20 selects + applyRestore's truncate/insert
 * run against the true schema); real temp dirs for knowledge + vault; only
 * electron (app/dialog/safeStorage) and the vault master-key helper are mocked.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

// Unique temp root per worker (portable + parallel-safe), shared with the
// ../paths mock via vi.hoisted.
const { TEST_ROOT, KB_DIR, VAULT_DIR_PATH, DOWNLOADS_DIR } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-backup-test-'))
  return {
    TEST_ROOT: root,
    KB_DIR: path.join(root, 'kb'),
    VAULT_DIR_PATH: path.join(root, 'vault'),
    DOWNLOADS_DIR: path.join(root, 'downloads')
  }
})

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

vi.mock('../paths', () => ({
  KNOWLEDGE_DIR: KB_DIR,
  VAULT_DIR: VAULT_DIR_PATH,
  DATA_DIR: TEST_ROOT
}))

// Master key: fixed 32 bytes → valid 64-char hex (decryptBundle validates this).
const getOrCreateKeyMock = vi.fn<() => Buffer>(() => Buffer.alloc(32, 7))
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => getOrCreateKeyMock()
}))

// electron: app version/paths, dialog (per-test settable), safeStorage rewrap.
const showSaveDialogMock = vi.fn()
const showOpenDialogMock = vi.fn()
const isEncryptionAvailableMock = vi.fn(() => true)
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => DOWNLOADS_DIR },
  dialog: {
    showSaveDialog: (...a: unknown[]) => showSaveDialogMock(...a),
    showOpenDialog: (...a: unknown[]) => showOpenDialogMock(...a)
  },
  safeStorage: {
    isEncryptionAvailable: () => isEncryptionAvailableMock(),
    encryptString: (s: string) => Buffer.from(`wrap:${s}`, 'utf8')
  }
}))

const MIGRATIONS_FOLDER = join(__dirname, '..', 'db', 'migrations')

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./backup')
  mod.registerBackupHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

async function internal() {
  return (await import('./backup'))._internal
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  // Build the FULL schema from the real migrations so collectBundle's 20
  // table selects + applyRestore's truncate/insert run against true DDL.
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER })

  for (const k of Object.keys(handlers)) delete handlers[k]
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(KB_DIR, { recursive: true })
  mkdirSync(VAULT_DIR_PATH, { recursive: true })
  mkdirSync(DOWNLOADS_DIR, { recursive: true })
  getOrCreateKeyMock.mockReturnValue(Buffer.alloc(32, 7))
  isEncryptionAvailableMock.mockReturnValue(true)
})

afterEach(() => {
  sqlite.close()
  rmSync(TEST_ROOT, { recursive: true, force: true })
  vi.clearAllMocks()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedBaseline(): void {
  sqlite.prepare("INSERT INTO integrations (service, status) VALUES ('google', 'connected')").run()
  sqlite
    .prepare(
      "INSERT INTO finance_transactions (hash, date, amount, description) VALUES ('h1', '2026-05-01', -12.5, 'Coffee')"
    )
    .run()
  sqlite.prepare("INSERT INTO habits (name) VALUES ('Drink water')").run()
  writeFileSync(join(KB_DIR, 'note.md'), '# Note\n\nOriginal content.\n')
  writeFileSync(join(VAULT_DIR_PATH, 'financial.enc'), Buffer.from([1, 2, 3, 4]))
  // key.enc must be excluded from the bundle — seed it to prove that.
  writeFileSync(join(VAULT_DIR_PATH, 'key.enc'), Buffer.from([9, 9, 9]))
}

// ── collectBundle → applyRestore round-trip ──────────────────────────────────

describe('collectBundle → applyRestore round-trip', () => {
  it('captures DB + knowledge + vault (excluding key.enc) into a bundle', async () => {
    seedBaseline()
    const { collectBundle } = await internal()
    const bundle = collectBundle()

    expect(bundle.version).toBe(2)
    expect(bundle.appVersion).toBe('9.9.9')
    expect(bundle.masterKeyHex).toBe(Buffer.alloc(32, 7).toString('hex'))
    expect(bundle.tables.integrations).toHaveLength(1)
    expect(bundle.tables.financeTransactions).toHaveLength(1)
    expect(bundle.knowledge['note.md']).toContain('Original content')
    // Vault blobs are carried base64; key.enc is deliberately excluded.
    expect(bundle.vault['financial.enc']).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'))
    expect(bundle.vault['key.enc']).toBeUndefined()
  })

  it('restores DB rows, knowledge markdown, vault blobs, and rewraps key.enc', async () => {
    seedBaseline()
    const { collectBundle, applyRestore } = await internal()
    const bundle = collectBundle()

    // Mutate live state so a successful restore is observable.
    sqlite.prepare('DELETE FROM integrations').run()
    sqlite.prepare('DELETE FROM finance_transactions').run()
    writeFileSync(join(KB_DIR, 'note.md'), '# Note\n\nCLOBBERED.\n')
    rmSync(join(VAULT_DIR_PATH, 'financial.enc'), { force: true })

    const stats = applyRestore(bundle)

    expect(stats.rows).toBeGreaterThanOrEqual(3) // integration + txn + habit
    expect(stats.vaultFiles).toBe(1)
    expect(stats.knowledgeFiles).toBe(1)

    // DB restored
    const intg = sqlite.prepare('SELECT service FROM integrations').all() as Array<{
      service: string
    }>
    expect(intg).toEqual([{ service: 'google' }])
    // knowledge restored
    expect(readFileSync(join(KB_DIR, 'note.md'), 'utf8')).toContain('Original content')
    // vault blob restored + fresh key.enc rewrapped via safeStorage mock
    expect(existsSync(join(VAULT_DIR_PATH, 'financial.enc'))).toBe(true)
    expect(readFileSync(join(VAULT_DIR_PATH, 'key.enc')).toString('utf8')).toBe(
      `wrap:${bundle.masterKeyHex}`
    )
  })

  it('skips unsafe vault filenames and path-traversal knowledge keys on restore', async () => {
    seedBaseline()
    const { collectBundle, applyRestore } = await internal()
    const bundle = collectBundle()
    // Inject hostile entries the staging filters must drop.
    bundle.vault['../escape.enc'] = Buffer.from([0]).toString('base64')
    bundle.knowledge['../../etc/passwd.md'] = 'nope'

    const stats = applyRestore(bundle)
    // Only the one legit vault blob + one legit md survive.
    expect(stats.vaultFiles).toBe(1)
    expect(stats.knowledgeFiles).toBe(1)
    expect(existsSync(join(TEST_ROOT, 'escape.enc'))).toBe(false)
  })

  it('rolls back (throws) when safeStorage is unavailable, after DB commit', async () => {
    seedBaseline()
    const { collectBundle, applyRestore } = await internal()
    const bundle = collectBundle()
    isEncryptionAvailableMock.mockReturnValue(false)
    expect(() => applyRestore(bundle)).toThrow(/safeStorage unavailable/i)
  })
})

// ── backup:create handler ────────────────────────────────────────────────────

describe('backup:create handler', () => {
  it('rejects a passphrase shorter than 8 characters before opening any dialog', async () => {
    const h = await registerAndGet('backup:create')
    expect(await invoke(h, 'short')).toEqual({
      success: false,
      error: 'Passphrase must be at least 8 characters'
    })
    expect(showSaveDialogMock).not.toHaveBeenCalled()
  })

  it('returns canceled when the user dismisses the save dialog', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined })
    const h = await registerAndGet('backup:create')
    expect(await invoke(h, 'long-enough-pass')).toEqual({ success: false, canceled: true })
  })

  it('writes an encrypted bundle and returns stats on success', async () => {
    seedBaseline()
    const outPath = join(DOWNLOADS_DIR, 'backup.compass-backup')
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: outPath })
    const h = await registerAndGet('backup:create')
    const res = (await invoke(h, 'long-enough-pass')) as {
      success: boolean
      path: string
      size: number
      stats: { tables: number; knowledgeFiles: number; vaultFiles: number }
    }
    expect(res.success).toBe(true)
    expect(res.path).toBe(outPath)
    expect(res.size).toBeGreaterThan(0)
    expect(res.stats.tables).toBe(20)
    expect(res.stats.knowledgeFiles).toBe(1)
    expect(res.stats.vaultFiles).toBe(1)
    // File actually exists with the v2 magic header.
    expect(existsSync(outPath)).toBe(true)
    expect(readFileSync(outPath).subarray(0, 8).toString('utf8')).toBe('COMPASSB')
  })
})

// ── backup:restore handler ───────────────────────────────────────────────────

describe('backup:restore handler', () => {
  it('rejects an empty passphrase before opening any dialog', async () => {
    const h = await registerAndGet('backup:restore')
    expect(await invoke(h, '')).toEqual({ success: false, error: 'Passphrase is required' })
    expect(showOpenDialogMock).not.toHaveBeenCalled()
  })

  it('returns canceled when the user dismisses the open dialog', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    const h = await registerAndGet('backup:restore')
    expect(await invoke(h, 'any-pass')).toEqual({ success: false, canceled: true })
  })

  it('surfaces a wrong-passphrase error from the decrypt step', async () => {
    seedBaseline()
    // Create a real backup with one passphrase…
    const outPath = join(DOWNLOADS_DIR, 'backup.compass-backup')
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: outPath })
    await invoke(await registerAndGet('backup:create'), 'correct-pass-123')
    // …then try to restore it with another.
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [outPath] })
    const res = (await invoke(await registerAndGet('backup:restore'), 'wrong-pass-999')) as {
      success: boolean
      error: string
    }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/passphrase|corrupted/i)
  })

  it('restores end-to-end from a file backup:create just wrote', async () => {
    seedBaseline()
    const pass = 'round-trip-pass-1'
    const outPath = join(DOWNLOADS_DIR, 'backup.compass-backup')
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: outPath })
    await invoke(await registerAndGet('backup:create'), pass)

    // Clobber live state, then restore from the file.
    sqlite.prepare('DELETE FROM integrations').run()
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [outPath] })
    const res = (await invoke(await registerAndGet('backup:restore'), pass)) as {
      success: boolean
      appVersion: string
      stats: { rows: number }
    }
    expect(res.success).toBe(true)
    expect(res.appVersion).toBe('9.9.9')
    expect(res.stats.rows).toBeGreaterThanOrEqual(3)
    const intg = sqlite.prepare('SELECT service FROM integrations').all()
    expect(intg).toEqual([{ service: 'google' }])
  })
})
