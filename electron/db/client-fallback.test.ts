import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreEnvVar } from '../test/env'

// Simulate the PACKAGED app: the drizzle migrations folder is NOT bundled in the
// asar, so `migrate()` throws and initDb falls back to the manual CREATE TABLE path.
// Regression guard for the production bug where `records` / `snapshot_facts` (which
// previously lived ONLY in migrations) were never created — breaking every Drop Zone
// import with "no such table: records".
vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: () => {
    throw new Error('ENOENT: no migrations folder (simulated production build)')
  }
}))

const originalHome = process.env.HOME

function dbPathForHome(home: string): string {
  return join(home, 'Library', 'Application Support', 'Compass', '.data', 'compass.db')
}

afterEach(() => {
  restoreEnvVar('HOME', originalHome)
  vi.resetModules()
})

describe('initDb fallback when migrations are not bundled', () => {
  it('still creates records + snapshot_facts (and a working dedup index)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'compass-fallback-'))
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })
    process.env.HOME = home
    vi.resetModules()
    const { initDb } = await import('./client')
    await initDb()

    const sqlite = new Database(dbPath)
    try {
      const tables = (
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('records','snapshot_facts')"
          )
          .all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort()
      expect(tables).toEqual(['records', 'snapshot_facts'])

      // The dedup UNIQUE index must exist (insertRecords relies on ON CONFLICT DO NOTHING).
      sqlite
        .prepare(
          'INSERT INTO records (source,type,title,dedup_hash) VALUES (?,?,?,?) ON CONFLICT DO NOTHING'
        )
        .run('google', 'watch', 'x', 'h1')
      const second = sqlite
        .prepare(
          'INSERT INTO records (source,type,title,dedup_hash) VALUES (?,?,?,?) ON CONFLICT DO NOTHING'
        )
        .run('google', 'watch', 'x', 'h1')
      expect(second.changes).toBe(0) // deduped
    } finally {
      sqlite.close()
    }
  })
})
