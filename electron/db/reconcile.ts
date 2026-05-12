/**
 * Pre-migration reconciliation helpers shared by `client.ts` (the Electron app
 * path) and `migrate.ts` (the standalone CLI runner).
 *
 * These run BEFORE `migrate()` to make the recorded `__drizzle_migrations`
 * state consistent with the migration files on disk. Without these, legacy
 * databases that were patched up by `ensureNewTables()` in earlier app
 * versions will fail to migrate because their `__drizzle_migrations` table
 * disagrees with the journal hashes.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const PREVIOUS_MIGRATION_TAG = '0001_small_blob'
const INSTITUTION_MIGRATION_TAG = '0002_zippy_sauron'

type MigrationJournal = {
  entries: Array<{
    tag: string
    when: number
  }>
}

/**
 * Run all pre-migrate reconciliation steps. Idempotent — safe to call on a
 * fresh DB or one that's already up to date.
 */
export function reconcileMigrationState(sqlite: Database.Database, migrationsFolder: string): void {
  normalizeRecordedMigrationTimestamps(sqlite, migrationsFolder)
  reconcileBackfilledInstitutionMigration(sqlite, migrationsFolder)
}

function normalizeRecordedMigrationTimestamps(
  sqlite: Database.Database,
  migrationsFolder: string
): void {
  const migrations = readMigrationFiles({ migrationsFolder })

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `)

  const updateMigrationTimestamp = sqlite.prepare(`
    UPDATE __drizzle_migrations
    SET created_at = ?
    WHERE hash = ?
      AND COALESCE(created_at, -1) <> ?
  `)

  for (const migration of migrations) {
    updateMigrationTimestamp.run(migration.folderMillis, migration.hash, migration.folderMillis)
  }
}

function reconcileBackfilledInstitutionMigration(
  sqlite: Database.Database,
  migrationsFolder: string
): void {
  if (!hasTable(sqlite, '__drizzle_migrations')) return
  if (!hasColumn(sqlite, 'finance_accounts', 'institution')) return

  const previousMigration = getMigrationMetadata(migrationsFolder, PREVIOUS_MIGRATION_TAG)
  const institutionMigration = getMigrationMetadata(migrationsFolder, INSTITUTION_MIGRATION_TAG)
  if (!previousMigration || !institutionMigration) return

  const hasPreviousMigration = sqlite
    .prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1')
    .get(previousMigration.hash)
  if (!hasPreviousMigration) return

  const hasInstitutionMigration = sqlite
    .prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1')
    .get(institutionMigration.hash)
  if (hasInstitutionMigration) return

  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(institutionMigration.hash, institutionMigration.when)
}

function hasTable(sqlite: Database.Database, table: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table)
  return Boolean(row)
}

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  const quotedTable = quoteSqliteIdentifier(table)
  const columns = sqlite.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{
    name: string
  }>
  return columns.some((entry) => entry.name === column)
}

function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function getMigrationMetadata(
  migrationsFolder: string,
  tag: string
): { hash: string; when: number } | null {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as MigrationJournal
  const entry = journal.entries.find((migration) => migration.tag === tag)
  if (!entry) return null

  const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8')
  return {
    hash: createHash('sha256').update(sql).digest('hex'),
    when: entry.when
  }
}
