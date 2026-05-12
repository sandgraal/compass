import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countPendingMigrations, runMigrations } from './migrate'

function makeTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'compass-migrate-test-'))
  return join(dir, 'compass.db')
}

function tableNames(dbPath: string): string[] {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    return (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
  } finally {
    sqlite.close()
  }
}

let tmpDb: string

beforeEach(() => {
  tmpDb = makeTmpDb()
})

afterEach(() => {
  // files cleaned up by OS tmpdir GC; no explicit cleanup needed
})

describe('runMigrations', () => {
  it('creates a fresh DB and applies all migrations', () => {
    expect(existsSync(tmpDb)).toBe(false)

    runMigrations(tmpDb)

    expect(existsSync(tmpDb)).toBe(true)
    const tables = tableNames(tmpDb)
    expect(tables).toContain('integrations')
    expect(tables).toContain('finance_accounts')
    expect(tables).toContain('finance_transactions')
    expect(tables).toContain('checklist_items')
  })

  it('is idempotent — running twice reports 0 applied the second time', () => {
    runMigrations(tmpDb)
    const before = countPendingMigrations(tmpDb)
    expect(before).toBe(0)

    runMigrations(tmpDb)
    expect(countPendingMigrations(tmpDb)).toBe(0)
  })

  it('returns the number of applied migrations on a fresh DB', () => {
    const { applied } = runMigrations(tmpDb)
    expect(applied).toBeGreaterThan(0)
  })

  it('reconciles a legacy DB whose institution column was backfilled by ensureNewTables', () => {
    // Simulate a legacy DB: all tables/columns exist (because ensureNewTables
    // added them in an earlier app version), but the 0002 migration hash was
    // never recorded in __drizzle_migrations. Without the reconciler,
    // `migrate()` would try to ALTER the institution column again and crash.
    runMigrations(tmpDb)
    const sqlite = new Database(tmpDb)
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const crypto = require('node:crypto') as typeof import('node:crypto')
      const sql0002 = fs.readFileSync(
        join(__dirname, 'migrations', '0002_zippy_sauron.sql'),
        'utf8'
      )
      const hash0002 = crypto.createHash('sha256').update(sql0002).digest('hex')
      const result = sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(hash0002)
      expect(result.changes).toBe(1)
    } finally {
      sqlite.close()
    }

    // Sanity: countPendingMigrations sees 0002 as pending.
    expect(countPendingMigrations(tmpDb)).toBe(1)

    // The standalone runner must reconcile the missing record before calling
    // migrate() — otherwise migrate() would try to re-add the institution
    // column and throw.
    expect(() => runMigrations(tmpDb)).not.toThrow()
    expect(countPendingMigrations(tmpDb)).toBe(0)
  })
})

describe('countPendingMigrations', () => {
  it('returns total migration count for a non-existent DB', () => {
    const nonExistent = join(mkdtempSync(join(tmpdir(), 'compass-nodb-')), 'compass.db')
    const n = countPendingMigrations(nonExistent)
    expect(n).toBeGreaterThan(0)
  })

  it('returns 0 after all migrations applied', () => {
    runMigrations(tmpDb)
    expect(countPendingMigrations(tmpDb)).toBe(0)
  })

  it('returns > 0 when a migration has been removed from __drizzle_migrations', () => {
    runMigrations(tmpDb)

    const sqlite = new Database(tmpDb)
    try {
      sqlite.prepare('DELETE FROM __drizzle_migrations LIMIT 1').run()
    } finally {
      sqlite.close()
    }

    expect(countPendingMigrations(tmpDb)).toBeGreaterThan(0)
  })

  it('returns total migration count when __drizzle_migrations is absent', () => {
    mkdirSync(tmpDb.replace('/compass.db', ''), { recursive: true })
    const sqlite = new Database(tmpDb)
    sqlite.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)')
    sqlite.close()

    const n = countPendingMigrations(tmpDb)
    expect(n).toBeGreaterThan(0)
  })
})
