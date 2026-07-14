/**
 * Retirement of the vault split's `.migrated.enc` backups — in-memory FS +
 * real `runOnceGated` over a real `app_settings` table, mirroring the
 * migration test's harness. The invariants: never runs before the migration
 * gate exists (and doesn't consume its own gate while waiting), deletes every
 * category backup exactly once, and is a no-op forever after.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory `.vault/` directory.
const fakeFs: Record<string, Buffer> = {}
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p in fakeFs,
  rmSync: (p: string) => {
    if (!(p in fakeFs)) throw new Error(`ENOENT ${p}`)
    delete fakeFs[p]
  }
}))

vi.mock('../paths', () => ({ VAULT_DIR: '/tmp/compass-vault-test' }))

import {
  MIGRATED_BLOBS_RETIRE_KEY,
  retireMigratedVaultBlobsIfNeeded
} from './vault-blob-retirement'

let sqlite: Database.Database

const BACKUP = (cat: string): string => `/tmp/compass-vault-test/${cat}.migrated.enc`

function setMigrationGate(): void {
  sqlite
    .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('vaultLifeRecordsMigrated', new Date().toISOString(), Date.now())
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);')
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
})
afterEach(() => sqlite.close())

describe('retireMigratedVaultBlobsIfNeeded', () => {
  it('waits for the migration gate without consuming its own', () => {
    fakeFs[BACKUP('financial')] = Buffer.from('enc')
    expect(retireMigratedVaultBlobsIfNeeded(sqlite)).toEqual({ ran: false })
    expect(BACKUP('financial') in fakeFs).toBe(true)
    // Once the migration commits, the next boot retires.
    setMigrationGate()
    expect(retireMigratedVaultBlobsIfNeeded(sqlite)).toEqual({ ran: true, removed: 1 })
    expect(BACKUP('financial') in fakeFs).toBe(false)
  })

  it('deletes every category backup and is a no-op afterwards', () => {
    setMigrationGate()
    for (const cat of ['financial', 'identity', 'medical', 'legal', 'foreign-accounts']) {
      fakeFs[BACKUP(cat)] = Buffer.from('enc')
    }
    expect(retireMigratedVaultBlobsIfNeeded(sqlite)).toEqual({ ran: true, removed: 5 })
    expect(Object.keys(fakeFs)).toHaveLength(0)
    const gate = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(MIGRATED_BLOBS_RETIRE_KEY)
    expect(gate).toBeTruthy()
    expect(retireMigratedVaultBlobsIfNeeded(sqlite)).toEqual({ ran: false })
  })

  it('a migrated store with no backups still consumes the gate cleanly', () => {
    setMigrationGate()
    expect(retireMigratedVaultBlobsIfNeeded(sqlite)).toEqual({ ran: true, removed: 0 })
  })
})
