import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import { copyMigrationsToBuild } from './copy-migrations'

// The source migrations folder (drizzle.config.ts `out`). At runtime in the
// built app this same set is copied to out/main/migrations by the electron-vite
// plugin so `migrate()` resolves `join(__dirname, 'migrations')`.
const SOURCE = join(__dirname, 'migrations')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('copyMigrationsToBuild', () => {
  it('copies the runtime set (.sql + meta/_journal.json) and skips dev-only snapshots', () => {
    const dest = copyMigrationsToBuild(SOURCE, tmp('compass-bundle-'))

    const sqlFiles = readdirSync(dest).filter((f) => f.endsWith('.sql'))
    const sourceSql = readdirSync(SOURCE).filter((f) => f.endsWith('.sql'))
    expect(sqlFiles.sort()).toEqual(sourceSql.sort())
    expect(sqlFiles.length).toBeGreaterThan(0)

    // The journal the migrator/reconciler read must ship...
    expect(existsSync(join(dest, 'meta', '_journal.json'))).toBe(true)
    // ...but drizzle-kit's per-migration snapshots are generate-time only and
    // must NOT bloat the asar.
    const snapshots = readdirSync(join(dest, 'meta')).filter((f) => f.endsWith('_snapshot.json'))
    expect(snapshots).toEqual([])
  })

  it('produces a folder migrate() runs from — creates __drizzle_migrations (the production path)', () => {
    // This is the regression guard for the shipped bug: in a built app the only
    // migrations folder is the COPIED one. Prove that copy is self-sufficient —
    // migrate() must create the journal table AND the real tables (incl. the
    // Storehouse `records` table that previously lived only in migrations).
    const dest = copyMigrationsToBuild(SOURCE, tmp('compass-bundle-'))
    const dbPath = join(tmp('compass-bundle-db-'), 'compass.db')

    const sqlite = new Database(dbPath)
    try {
      migrate(drizzle(sqlite), { migrationsFolder: dest })

      const journal = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
        )
        .get()
      expect(journal).toBeDefined()

      const records = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'")
        .get()
      expect(records).toBeDefined()
    } finally {
      sqlite.close()
    }
  })
})
