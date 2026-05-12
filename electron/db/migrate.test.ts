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

  it('creates __drizzle_migrations dir entry when table is absent', () => {
    mkdirSync(tmpDb.replace('/compass.db', ''), { recursive: true })
    const sqlite = new Database(tmpDb)
    sqlite.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)')
    sqlite.close()

    const n = countPendingMigrations(tmpDb)
    expect(n).toBeGreaterThan(0)
  })
})
