#!/usr/bin/env tsx
/**
 * Standalone migration runner. Mirrors the migrate() call inside initDb().
 *
 * Run:
 *   npm run db:migrate              # apply pending migrations
 *   npm run db:migrate -- --check   # exit non-zero if any pending
 *   npm run db:migrate -- --reset --yes  # drop DB and re-migrate (DESTRUCTIVE)
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { DATA_DIR } from '../paths'
import { reconcileMigrationState } from './reconcile'
import * as schema from './schema'

const MIGRATIONS_FOLDER = join(__dirname, 'migrations')
export const DB_PATH = join(DATA_DIR, 'compass.db')

export function countPendingMigrations(dbPath: string = DB_PATH): number {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
  if (!existsSync(dbPath)) return files.length

  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const applied = new Set<string>()
    try {
      const rows = sqlite.prepare('SELECT hash FROM "__drizzle_migrations"').all() as {
        hash: string
      }[]
      for (const r of rows) applied.add(r.hash)
    } catch {
      return files.length
    }
    return files.filter((f) => !applied.has(f.hash)).length
  } finally {
    sqlite.close()
  }
}

export function runMigrations(dbPath: string = DB_PATH): { applied: number } {
  mkdirSync(dirname(dbPath), { recursive: true })
  const before = countPendingMigrations(dbPath)

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })

  // Match the reconcile-then-migrate sequence used by initDb() so legacy DBs
  // patched up by ensureNewTables() in earlier app versions can still migrate.
  reconcileMigrationState(sqlite, MIGRATIONS_FOLDER)
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  sqlite.close()

  return { applied: before }
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2))

  if (flags.has('--check')) {
    const n = countPendingMigrations()
    if (n > 0) {
      console.error(`✖ ${n} pending migration(s)`)
      process.exit(1)
    }
    console.log('✓ schema up to date')
    return
  }

  if (flags.has('--reset')) {
    if (!flags.has('--yes')) {
      console.error('Refusing to reset without --yes. This is destructive.')
      process.exit(1)
    }
    if (existsSync(DB_PATH)) {
      rmSync(DB_PATH)
      console.log(`Removed ${DB_PATH}`)
    }
  }

  const { applied } = runMigrations()
  const remaining = countPendingMigrations()
  console.log(`Applied ${applied} migration(s). ${remaining} pending.`)
}

// Only run when executed directly (tsx electron/db/migrate.ts), not when imported by tests.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
