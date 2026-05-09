import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
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
})
