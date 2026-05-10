import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalHome = process.env.HOME

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'compass-db-test-'))
}

function dbPathForHome(home: string): string {
  return join(home, 'Library', 'Application Support', 'Compass', '.data', 'compass.db')
}

function readFinanceAccountColumns(dbPath: string): Array<{
  name: string
  notnull: number
  dflt_value: string | null
}> {
  const sqlite = new Database(dbPath)
  try {
    return sqlite.prepare('PRAGMA table_info(finance_accounts)').all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
  } finally {
    sqlite.close()
  }
}

function expectInstitutionColumn(dbPath: string): void {
  const columns = readFinanceAccountColumns(dbPath)
  const institution = columns.find((column) => column.name === 'institution')

  expect(institution).toBeDefined()
  expect(institution?.notnull).toBe(1)
  expect(institution?.dflt_value).toBe("''")

  const sqlite = new Database(dbPath)
  try {
    sqlite
      .prepare("INSERT INTO finance_accounts (name, type) VALUES ('Test Account', 'credit')")
      .run()
    const row = sqlite
      .prepare("SELECT institution FROM finance_accounts WHERE name = 'Test Account'")
      .get() as { institution: string }
    expect(row.institution).toBe('')
  } finally {
    sqlite.close()
  }
}

function readRecordedMigrations(dbPath: string): Array<{ hash: string; created_at: number | null }> {
  const sqlite = new Database(dbPath)
  try {
    return sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY COALESCE(created_at, 0) ASC')
      .all() as Array<{ hash: string; created_at: number | null }>
  } finally {
    sqlite.close()
  }
}

async function loadClientForHome(home: string): Promise<typeof import('./client')> {
  process.env.HOME = home
  vi.resetModules()
  return import('./client')
}

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome
  else process.env.HOME = undefined
  vi.resetModules()
})

describe('initDb finance_accounts institution column', () => {
  it('creates the institution column on a fresh database', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })
    const { initDb } = await loadClientForHome(home)

    await initDb()

    expectInstitutionColumn(dbPath)
  })

  it('backfills the institution column on an existing finance_accounts table', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })

    const sqlite = new Database(dbPath)
    try {
      sqlite.exec(`
        CREATE TABLE integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          service TEXT NOT NULL UNIQUE,
          connected_at INTEGER,
          last_synced_at INTEGER,
          status TEXT NOT NULL DEFAULT 'disconnected',
          scopes TEXT,
          error_message TEXT,
          sync_interval_minutes INTEGER NOT NULL DEFAULT 15
        );

        CREATE TABLE finance_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'credit',
          is_debt INTEGER DEFAULT 0,
          balance REAL DEFAULT 0,
          apr REAL DEFAULT 0,
          min_payment REAL DEFAULT 0,
          credit_limit REAL,
          updated_at INTEGER
        );
      `)
    } finally {
      sqlite.close()
    }

    const { initDb } = await loadClientForHome(home)
    await initDb()

    expectInstitutionColumn(dbPath)
  })

  it('normalizes stale recorded migration timestamps before rerunning migrations', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    const migrations = readMigrationFiles({ migrationsFolder: join(__dirname, 'migrations') })
    const secondMigration = migrations[1]
    const institutionMigration = migrations[2]
    if (!secondMigration || !institutionMigration) {
      throw new Error('Expected seeded migrations to exist')
    }
    mkdirSync(dirname(dbPath), { recursive: true })

    const sqlite = new Database(dbPath)
    try {
      sqlite.exec(`
        CREATE TABLE integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          service TEXT NOT NULL UNIQUE,
          connected_at INTEGER,
          last_synced_at INTEGER,
          status TEXT NOT NULL DEFAULT 'disconnected',
          scopes TEXT,
          error_message TEXT,
          sync_interval_minutes INTEGER NOT NULL DEFAULT 15
        );

        CREATE TABLE finance_accounts (
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

        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hash TEXT NOT NULL,
          created_at NUMERIC
        );
      `)
      sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?), (?, ?)')
        .run(
          secondMigration.hash,
          secondMigration.folderMillis,
          institutionMigration.hash,
          1778283523634
        )
    } finally {
      sqlite.close()
    }

    const { initDb } = await loadClientForHome(home)
    await initDb()

    const recordedMigrations = readRecordedMigrations(dbPath)
    expect(recordedMigrations).toEqual([
      { hash: secondMigration.hash, created_at: secondMigration.folderMillis },
      { hash: institutionMigration.hash, created_at: institutionMigration.folderMillis }
    ])
  })
})
