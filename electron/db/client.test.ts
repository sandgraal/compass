import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreEnvVar } from '../test/env'

const originalHome = process.env.HOME
const MIGRATIONS_FOLDER = join(__dirname, 'migrations')

type MigrationJournal = {
  entries: Array<{
    tag: string
    when: number
  }>
}

type MigrationMetadata = {
  tag: string
  hash: string
  when: number
}

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

function readMigrationRows(dbPath: string): Array<{ hash: string; created_at: number | null }> {
  const sqlite = new Database(dbPath)
  try {
    return sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, hash')
      .all() as Array<{ hash: string; created_at: number | null }>
  } finally {
    sqlite.close()
  }
}

function migrationHash(tag: string): string {
  return createHash('sha256')
    .update(readFileSync(join(__dirname, 'migrations', `${tag}.sql`), 'utf8'))
    .digest('hex')
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

function readRecordedMigrations(
  dbPath: string
): Array<{ hash: string; created_at: number | null }> {
  const sqlite = new Database(dbPath)
  try {
    return sqlite
      .prepare(
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY COALESCE(created_at, 0) ASC'
      )
      .all() as Array<{ hash: string; created_at: number | null }>
  } finally {
    sqlite.close()
  }
}

function readMigrationMetadata(): MigrationMetadata[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
  ) as MigrationJournal

  return journal.entries.map((entry) => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')
    return {
      tag: entry.tag,
      hash: createHash('sha256').update(sql).digest('hex'),
      when: entry.when
    }
  })
}

async function loadClientForHome(home: string): Promise<typeof import('./client')> {
  process.env.HOME = home
  vi.resetModules()
  return import('./client')
}

afterEach(() => {
  restoreEnvVar('HOME', originalHome)
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
    const migrations = readMigrationMetadata()
    const institutionMigrationIndex = migrations.findIndex(
      (migration) => migration.tag === '0002_zippy_sauron'
    )
    if (institutionMigrationIndex < 1) {
      throw new Error('Expected migrations through 0002_zippy_sauron to exist')
    }
    const appliedMigrations = migrations.slice(0, institutionMigrationIndex + 1)
    const migrationBeforeInstitution = appliedMigrations[appliedMigrations.length - 2]
    const institutionMigration = appliedMigrations[appliedMigrations.length - 1]
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
      const insertMigration = sqlite.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
      )
      for (const migration of appliedMigrations) {
        const createdAt =
          migration.tag === institutionMigration.tag
            ? migrationBeforeInstitution.when - 1
            : migration.when
        insertMigration.run(migration.hash, createdAt)
      }
    } finally {
      sqlite.close()
    }

    const { initDb } = await loadClientForHome(home)
    await initDb()

    const recordedMigrations = readRecordedMigrations(dbPath)
    // The pre-seeded applied migrations should have their timestamps
    // normalized back to the journal's `when`. Any later migrations
    // (added after this test was written) get applied during initDb()
    // but are unrelated to this test's invariant.
    for (const migration of appliedMigrations) {
      const recorded = recordedMigrations.find((row) => row.hash === migration.hash)
      expect(recorded).toBeDefined()
      expect(recorded?.created_at).toBe(migration.when)
    }
  })

  it('records the institution migration when the column was already backfilled', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })
    const { initDb } = await loadClientForHome(home)

    await initDb()

    const originalMigrationRows = readMigrationRows(dbPath)
    const institutionHash = migrationHash('0002_zippy_sauron')
    const sqlite = new Database(dbPath)
    try {
      sqlite.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(institutionHash)
    } finally {
      sqlite.close()
    }

    await initDb()

    expect(readMigrationRows(dbPath)).toEqual(originalMigrationRows)
    expectInstitutionColumn(dbPath)
  })
})

describe('initDb multi-currency schema (Phase 11.1)', () => {
  function tableColumns(dbPath: string, table: string): string[] {
    const sqlite = new Database(dbPath)
    try {
      return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    } finally {
      sqlite.close()
    }
  }
  function tableExists(dbPath: string, table: string): boolean {
    const sqlite = new Database(dbPath)
    try {
      return !!sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table)
    } finally {
      sqlite.close()
    }
  }

  it('adds currency columns + fx_rates on a fresh database (migration path)', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })
    const { initDb } = await loadClientForHome(home)
    await initDb()

    expect(tableColumns(dbPath, 'finance_accounts')).toContain('currency')
    expect(tableColumns(dbPath, 'finance_transactions')).toContain('currency')
    expect(tableColumns(dbPath, 'finance_accounts')).toContain('is_foreign') // Phase 11.2
    expect(tableExists(dbPath, 'fx_rates')).toBe(true)
    expect(tableExists(dbPath, 'travel_segments')).toBe(true) // Phase 11.5
    expect(tableExists(dbPath, 'financial_goals')).toBe(true) // Phase 11.6

    const sqlite = new Database(dbPath)
    try {
      sqlite.prepare("INSERT INTO finance_accounts (name, type) VALUES ('A', 'checking')").run()
      const row = sqlite
        .prepare("SELECT currency FROM finance_accounts WHERE name = 'A'")
        .get() as { currency: string }
      expect(row.currency).toBe('USD')
      // The (date, base, quote) UNIQUE key is in place on both schema paths.
      sqlite
        .prepare(
          "INSERT INTO fx_rates (date, base, quote, rate) VALUES ('2026-06-27','USD','CRC',500)"
        )
        .run()
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO fx_rates (date, base, quote, rate) VALUES ('2026-06-27','USD','CRC',512)"
          )
          .run()
      ).toThrow()
    } finally {
      sqlite.close()
    }
  })

  it('backfills currency + fx_rates onto a pre-existing finance schema (fallback path)', async () => {
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
          updated_at INTEGER
        );
        CREATE TABLE finance_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hash TEXT NOT NULL UNIQUE,
          date TEXT NOT NULL,
          amount REAL NOT NULL,
          description TEXT NOT NULL,
          notes TEXT
        );
      `)
    } finally {
      sqlite.close()
    }

    const { initDb } = await loadClientForHome(home)
    await initDb()

    expect(tableColumns(dbPath, 'finance_accounts')).toContain('currency')
    expect(tableColumns(dbPath, 'finance_transactions')).toContain('currency')
    expect(tableColumns(dbPath, 'finance_accounts')).toContain('is_foreign') // Phase 11.2
    expect(tableExists(dbPath, 'fx_rates')).toBe(true)
    expect(tableExists(dbPath, 'travel_segments')).toBe(true) // Phase 11.5
    expect(tableExists(dbPath, 'financial_goals')).toBe(true) // Phase 11.6
  })

  it('backfills is_foreign=true for non-USD accounts on a pre-existing table (fallback)', async () => {
    const home = makeTempHome()
    const dbPath = dbPathForHome(home)
    mkdirSync(dirname(dbPath), { recursive: true })

    // Pre-create a legacy finance_accounts that already has `currency` (Phase
    // 11.1) but no `is_foreign` — the state of a DB upgraded to 11.1 then 11.2.
    const seed = new Database(dbPath)
    try {
      seed.exec(`
        CREATE TABLE integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'disconnected', sync_interval_minutes INTEGER NOT NULL DEFAULT 15
        );
        CREATE TABLE finance_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'credit', is_debt INTEGER DEFAULT 0, balance REAL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD', updated_at INTEGER
        );
      `)
      seed.prepare("INSERT INTO finance_accounts (name, currency) VALUES ('CR', 'CRC')").run()
      seed.prepare("INSERT INTO finance_accounts (name, currency) VALUES ('US', 'USD')").run()
    } finally {
      seed.close()
    }

    const { initDb } = await loadClientForHome(home)
    await initDb()

    const sqlite = new Database(dbPath)
    try {
      const rows = sqlite
        .prepare('SELECT currency, is_foreign FROM finance_accounts ORDER BY name')
        .all() as Array<{ currency: string; is_foreign: number }>
      expect(rows).toEqual([
        { currency: 'CRC', is_foreign: 1 }, // backfilled foreign
        { currency: 'USD', is_foreign: 0 } // domestic stays false
      ])
    } finally {
      sqlite.close()
    }
  })
})
