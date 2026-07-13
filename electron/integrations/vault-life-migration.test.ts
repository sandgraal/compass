/**
 * Tests for the one-shot vault → life-records migration (the vault split).
 *
 * In-memory FS + stub crypto (a Vitest worker has no Keychain), real
 * in-memory SQLite for true onConflictDoNothing semantics, real
 * `runOnceGated` over a real `app_settings` table so the gate/crash-retry
 * behavior is the production one.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// In-memory `.vault/` directory.
const fakeFs: Record<string, Buffer> = {}
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p in fakeFs,
  readFileSync: (p: string) => {
    const v = fakeFs[p]
    if (!v) throw new Error(`ENOENT ${p}`)
    return v
  },
  renameSync: (from: string, to: string) => {
    const v = fakeFs[from]
    if (!v) throw new Error(`ENOENT ${from}`)
    fakeFs[to] = v
    delete fakeFs[from]
  }
}))

// Stub crypto: blobs are `enc:` + JSON; the secrets map is a plain object store.
const jsonBlobs: Record<string, unknown> = {}
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => Buffer.from('stub-key'),
  decryptBlob: (blob: Buffer) => blob.toString('utf8').replace(/^enc:/, ''),
  readEncryptedJson: (name: string) => jsonBlobs[name] ?? null,
  writeEncryptedJson: (name: string, data: unknown) => {
    jsonBlobs[name] = JSON.parse(JSON.stringify(data))
  }
}))

vi.mock('../paths', () => ({ VAULT_DIR: '/tmp/compass-vault-test' }))

const afterDomainWriteMock = vi.fn()
vi.mock('../ipc/storehouse-sync', () => ({
  afterDomainWrite: afterDomainWriteMock
}))

const VAULT_FILE = (cat: string): string => `/tmp/compass-vault-test/${cat}.enc`
function seedBlob(category: string, entries: unknown[]): void {
  fakeFs[VAULT_FILE(category)] = Buffer.from(`enc:${JSON.stringify(entries)}`, 'utf8')
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE life_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      title TEXT NOT NULL, fields TEXT, notes TEXT, has_secrets INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
  `)
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  for (const k of Object.keys(jsonBlobs)) delete jsonBlobs[k]
  afterDomainWriteMock.mockClear()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

async function run() {
  const { runVaultLifeMigrationIfNeeded } = await import('./vault-life-migration')
  return runVaultLifeMigrationIfNeeded(sqlite)
}

type Row = {
  external_id: string
  category: string
  title: string
  fields: string
  notes: string | null
  has_secrets: number
  source: string
}
const allRows = (): Row[] =>
  sqlite.prepare('SELECT * FROM life_records ORDER BY external_id').all() as Row[]

describe('runVaultLifeMigrationIfNeeded', () => {
  it('is a clean no-op on an empty vault (this user), and gates', async () => {
    const first = await run()
    expect(first).toMatchObject({ ran: true, migrated: 0, categoriesProcessed: 0 })
    expect(await run()).toEqual({ ran: false })
    expect(afterDomainWriteMock).not.toHaveBeenCalled()
  })

  it('splits every category blob into rows + a secrets map, then retires the blobs', async () => {
    seedBlob('financial', [
      {
        id: 'f1',
        institution: 'USAA',
        accountType: 'Checking',
        accountNumber: '123456789',
        notes: 'primary',
        createdAt: 1700000000000,
        updatedAt: 1700000000000
      },
      {
        id: 'f2',
        institution: 'Amex',
        accountType: 'Credit Card',
        accountNumber: '••••1003',
        _autoSeeded: true
      }
    ])
    seedBlob('legal', [{ id: 'l1', documentType: 'Will', parties: 'Chris' }])
    seedBlob('identity', [
      { id: 'i1', documentType: 'Passport', number: 'X1234567', _history: [{ number: 'OLD' }] }
    ])

    const res = await run()
    expect(res).toMatchObject({
      ran: true,
      migrated: 4,
      secretsKept: 2, // f1 accountNumber + i1 number (f2's masked stub is NOT a secret)
      categoriesProcessed: 3
    })

    const rows = allRows()
    expect(rows.map((r) => r.external_id)).toEqual(['vault:f1', 'vault:f2', 'vault:i1', 'vault:l1'])
    expect(rows.every((r) => r.source === 'vault-migration')).toBe(true)

    const f1 = rows.find((r) => r.external_id === 'vault:f1') as Row
    expect(f1.title).toBe('USAA')
    expect(f1.notes).toBe('primary')
    expect(f1.has_secrets).toBe(1)
    expect(f1.fields).not.toContain('123456789') // secret never reaches the DB

    const f2 = rows.find((r) => r.external_id === 'vault:f2') as Row
    expect(JSON.parse(f2.fields)).toMatchObject({ lastFour: '1003' })
    expect(f2.has_secrets).toBe(0)

    const l1 = rows.find((r) => r.external_id === 'vault:l1') as Row
    expect(l1.has_secrets).toBe(0)

    // Secrets keyed by ROW id.
    const idOf = (ext: string): number =>
      (
        sqlite.prepare('SELECT id FROM life_records WHERE external_id = ?').get(ext) as {
          id: number
        }
      ).id
    expect(jsonBlobs['record-secrets']).toEqual({
      [String(idOf('vault:f1'))]: { accountNumber: '123456789' },
      [String(idOf('vault:i1'))]: { number: 'X1234567' }
    })

    // Blobs retired — invisible to every `<category>.enc` reader, backup kept.
    expect(fakeFs[VAULT_FILE('financial')]).toBeUndefined()
    expect(fakeFs['/tmp/compass-vault-test/financial.migrated.enc']).toBeDefined()
    expect(fakeFs['/tmp/compass-vault-test/legal.migrated.enc']).toBeDefined()
    expect(afterDomainWriteMock).toHaveBeenCalled()

    // Gated: a second boot does nothing.
    expect(await run()).toEqual({ ran: false })
  })

  it('retries safely after a crash BEFORE the gate was written (no duplicates)', async () => {
    seedBlob('financial', [
      { id: 'f1', institution: 'USAA', accountType: 'Checking', accountNumber: '123456789' }
    ])
    await run()
    // Simulate "crashed before the gate write": clear the gate, restore the blob
    // (rename happened, but a crash between insert and rename is the worst case —
    // model it by putting the source blob back).
    sqlite.prepare('DELETE FROM app_settings').run()
    fakeFs[VAULT_FILE('financial')] = fakeFs['/tmp/compass-vault-test/financial.migrated.enc']

    const again = await run()
    expect(again).toMatchObject({ ran: true, migrated: 0 }) // conflict-skipped, not duplicated
    expect(allRows()).toHaveLength(1)
    // Secrets map still intact (merge is idempotent; existing values win).
    expect(Object.keys(jsonBlobs['record-secrets'] as object)).toHaveLength(1)
  })

  it('skips a corrupt blob without failing the whole pass', async () => {
    fakeFs[VAULT_FILE('medical')] = Buffer.from('enc:not-json', 'utf8')
    seedBlob('legal', [{ id: 'l1', documentType: 'Deed' }])
    const res = await run()
    expect(res).toMatchObject({ ran: true, migrated: 1, categoriesProcessed: 2 })
    expect(allRows()).toHaveLength(1)
    // The corrupt blob is still retired (it was processed — as empty).
    expect(fakeFs['/tmp/compass-vault-test/medical.migrated.enc']).toBeDefined()
  })
})
