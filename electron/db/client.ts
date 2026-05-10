import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { DATA_DIR } from '../paths'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle> | null = null
const MIGRATIONS_FOLDER = join(__dirname, 'migrations')
const PREVIOUS_MIGRATION_TAG = '0001_small_blob'
const INSTITUTION_MIGRATION_TAG = '0002_zippy_sauron'

type MigrationJournal = {
  entries: Array<{
    tag: string
    when: number
  }>
}

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.')
  return _db as ReturnType<typeof drizzle<typeof schema>>
}

export async function initDb(): Promise<void> {
  const dbPath = join(DATA_DIR, 'compass.db')
  const sqlite = new Database(dbPath)

  // WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })

  // Run migrations
  try {
    normalizeRecordedMigrationTimestamps(sqlite, MIGRATIONS_FOLDER)
    reconcileBackfilledInstitutionMigration(sqlite)
    migrate(_db as ReturnType<typeof drizzle>, {
      migrationsFolder: MIGRATIONS_FOLDER
    })
  } catch {
    // Migrations folder may not exist yet; create schema directly on first run
    createTablesIfNeeded(sqlite)
  }
  // Always ensure new tables exist for existing DBs that pre-date migrations
  ensureNewTables(sqlite)
}

function ensureNewTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0, balance REAL DEFAULT 0, apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0, credit_limit REAL, institution TEXT NOT NULL DEFAULT '',
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, description TEXT NOT NULL, account_id INTEGER REFERENCES finance_accounts(id),
      category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
      source_file TEXT, ingested_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS budget_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, subcategory TEXT,
      monthly_amount REAL NOT NULL DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, category TEXT NOT NULL,
      subcategory TEXT, priority INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS knowledge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER
    );
  `)

  // Backfill new columns on pre-existing tables (safe no-op when columns already exist).
  const addedSyncInterval = ensureColumn(
    sqlite,
    'integrations',
    'sync_interval_minutes',
    'INTEGER NOT NULL DEFAULT 15'
  )
  ensureColumn(sqlite, 'finance_accounts', 'institution', "TEXT NOT NULL DEFAULT ''")
  if (addedSyncInterval) {
    // One-time migration: seed per-integration intervals from the legacy global setting so users
    // who tuned `syncInterval` keep their preference on existing connected integrations.
    try {
      const legacy = sqlite
        .prepare("SELECT value FROM app_settings WHERE key = 'syncInterval'")
        .get() as { value?: string } | undefined
      const parsed = Number.parseInt(legacy?.value ?? '15', 10)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1440 && parsed !== 15) {
        sqlite.prepare('UPDATE integrations SET sync_interval_minutes = ?').run(parsed)
      }
    } catch {
      /* app_settings might not exist on a pristine DB — ignore */
    }
  }
}

function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  ddl: string
): boolean {
  const quotedTable = quoteSqliteIdentifier(table)
  const quotedColumn = quoteSqliteIdentifier(column)
  const cols = sqlite.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return false
  sqlite.exec(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${ddl}`)
  return true
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

function reconcileBackfilledInstitutionMigration(sqlite: Database.Database): void {
  if (!hasTable(sqlite, '__drizzle_migrations')) return
  if (!hasColumn(sqlite, 'finance_accounts', 'institution')) return

  const previousMigration = getMigrationMetadata(PREVIOUS_MIGRATION_TAG)
  const institutionMigration = getMigrationMetadata(INSTITUTION_MIGRATION_TAG)
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

function getMigrationMetadata(tag: string): { hash: string; when: number } | null {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
  ) as MigrationJournal
  const entry = journal.entries.find((migration) => migration.tag === tag)
  if (!entry) return null

  const sql = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8')
  return {
    hash: createHash('sha256').update(sql).digest('hex'),
    when: entry.when
  }
}

function createTablesIfNeeded(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER REFERENCES integrations(id),
      synced_at INTEGER NOT NULL,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      checked INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal',
      sort_order INTEGER DEFAULT 0,
      due_date TEXT,
      source TEXT DEFAULT 'manual',
      source_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS checklist_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL UNIQUE,
      content_md TEXT NOT NULL DEFAULT '',
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      description TEXT,
      html_link TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS github_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      repo TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      body TEXT,
      labels TEXT,
      due_date TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS gmail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      action_summary TEXT,
      snippet TEXT,
      received_at INTEGER,
      snoozed_until TEXT,
      done INTEGER DEFAULT 0,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS drive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mime_type TEXT,
      url TEXT,
      summary TEXT,
      last_modified INTEGER,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0,
      auto_updated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      account_id INTEGER REFERENCES finance_accounts(id),
      category TEXT DEFAULT 'Uncategorized',
      subcategory TEXT,
      notes TEXT,
      source_file TEXT,
      ingested_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS budget_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      subcategory TEXT,
      monthly_amount REAL NOT NULL DEFAULT 0,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT DEFAULT '#6272f1',
      active INTEGER DEFAULT 1,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER REFERENCES habits(id),
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      path, title, content,
      content='knowledge_files',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS knowledge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER
    );
  `)
}
