import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FATCA_THRESHOLD_DEFAULT_USD,
  FBAR_THRESHOLD_USD,
  buildExpatTaxSummary,
  buildFatcaByYear,
  buildFbarByYear,
  buildForeignTaxCredit,
  getFatcaThreshold
} from './finance-expat'

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
      rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      is_debt INTEGER DEFAULT 0, balance REAL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD', is_foreign INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL, balance REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', tax_tag TEXT NOT NULL DEFAULT 'tax:none'
    );
  `)
  return sqlite
}

function addAccount(
  sqlite: Database.Database,
  a: { name: string; currency?: string; isForeign?: boolean; isDebt?: boolean; balance?: number }
): number {
  const info = sqlite
    .prepare(
      'INSERT INTO finance_accounts (name, currency, is_foreign, is_debt, balance) VALUES (?, ?, ?, ?, ?)'
    )
    .run(a.name, a.currency ?? 'USD', a.isForeign ? 1 : 0, a.isDebt ? 1 : 0, a.balance ?? 0)
  return Number(info.lastInsertRowid)
}

function addSnap(
  sqlite: Database.Database,
  accountId: number,
  dateIso: string,
  balance: number
): void {
  const ts = new Date(`${dateIso}T12:00:00`).getTime()
  sqlite
    .prepare(
      'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (?, ?, ?)'
    )
    .run(accountId, ts, balance)
}

function addRate(sqlite: Database.Database, date: string, quote: string, rate: number): void {
  sqlite
    .prepare("INSERT INTO fx_rates (date, base, quote, rate) VALUES (?, 'USD', ?, ?)")
    .run(date, quote, rate)
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('buildFbarByYear', () => {
  it('takes each foreign account max during the year, converted at the year-end rate', () => {
    const id = addAccount(sqlite, { name: 'BAC CR', currency: 'CRC', isForeign: true })
    addRate(sqlite, '2024-12-31', 'CRC', 500) // year-end rate
    addSnap(sqlite, id, '2024-03-01', 5_000_000) // ₡5M
    addSnap(sqlite, id, '2024-08-01', 9_000_000) // ₡9M = the max
    addSnap(sqlite, id, '2024-11-01', 7_000_000)

    const fbar = buildFbarByYear(
      sqlite,
      'USD',
      [{ date: '2024-12-31', base: 'USD', quote: 'CRC', rate: 500 }],
      2025
    )
    const y2024 = fbar.find((y) => y.year === 2024)
    expect(y2024?.accounts[0].maxNative).toBe(9_000_000)
    expect(y2024?.accounts[0].maxBaseUsd).toBe(18_000) // ₡9M / 500
    expect(y2024?.aggregateMaxUsd).toBe(18_000)
    expect(y2024?.exceedsThreshold).toBe(true) // > $10k
  })

  it('flags below-threshold years and excludes domestic + debt accounts', () => {
    const foreign = addAccount(sqlite, { name: 'CR Savings', currency: 'CRC', isForeign: true })
    addAccount(sqlite, { name: 'US Checking', currency: 'USD', isForeign: false, balance: 999_999 })
    addAccount(sqlite, { name: 'CR Card', currency: 'CRC', isForeign: true, isDebt: true })
    addRate(sqlite, '2024-12-31', 'CRC', 500)
    addSnap(sqlite, foreign, '2024-06-01', 2_500_000) // ₡2.5M = $5,000

    const fbar = buildFbarByYear(
      sqlite,
      'USD',
      [{ date: '2024-12-31', base: 'USD', quote: 'CRC', rate: 500 }],
      2025
    )
    const y2024 = fbar.find((y) => y.year === 2024)
    expect(y2024?.accounts).toHaveLength(1) // only the foreign non-debt account
    expect(y2024?.aggregateMaxUsd).toBe(5_000)
    expect(y2024?.exceedsThreshold).toBe(false) // < $10k
  })

  it("seeds the current year from each account's live balance", () => {
    // No snapshots at all, but a live balance — should still surface this year.
    const id = addAccount(sqlite, {
      name: 'New CR Acct',
      currency: 'USD',
      isForeign: true,
      balance: 12_000
    })
    const fbar = buildFbarByYear(sqlite, 'USD', [], 2025)
    const y = fbar.find((r) => r.year === 2025)
    expect(y?.accounts[0].maxBaseUsd).toBe(12_000)
    expect(y?.exceedsThreshold).toBe(true)
    void id
  })

  it('counts foreign balances with no FX rate as unconverted', () => {
    const id = addAccount(sqlite, { name: 'CR', currency: 'CRC', isForeign: true })
    addSnap(sqlite, id, '2024-06-01', 5_000_000) // no CRC rate on file
    const fbar = buildFbarByYear(sqlite, 'USD', [], 2025)
    const y = fbar.find((r) => r.year === 2024)
    expect(y?.unconvertedCount).toBe(1)
    expect(y?.accounts[0].maxBaseUsd).toBeNull()
    expect(y?.aggregateMaxUsd).toBe(0)
  })

  it('returns [] when there are no foreign accounts', () => {
    addAccount(sqlite, { name: 'US', currency: 'USD', isForeign: false, balance: 50_000 })
    expect(buildFbarByYear(sqlite, 'USD', [], 2025)).toEqual([])
  })
})

describe('buildFatcaByYear', () => {
  it('flags the aggregate against the (higher) FATCA threshold', () => {
    const fbar = [
      {
        year: 2024,
        accounts: [],
        aggregateMaxUsd: 40_000,
        exceedsThreshold: true,
        unconvertedCount: 0
      },
      {
        year: 2025,
        accounts: [],
        aggregateMaxUsd: 80_000,
        exceedsThreshold: true,
        unconvertedCount: 0
      }
    ]
    const fatca = buildFatcaByYear(fbar, 50_000)
    expect(fatca[0]).toMatchObject({ year: 2024, exceedsThreshold: false }) // 40k < 50k
    expect(fatca[1]).toMatchObject({ year: 2025, exceedsThreshold: true }) // 80k > 50k
  })
})

describe('buildForeignTaxCredit', () => {
  it('sums tax:foreign-tax rows by year, converted to base, as positive magnitudes', () => {
    // ₡600,000 CR property tax at ₡500 = $1,200.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, currency, tax_tag) VALUES ('2024-02-01', -600000, 'CRC', 'tax:foreign-tax')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, currency, tax_tag) VALUES ('2024-09-01', -500, 'USD', 'tax:foreign-tax')"
      )
      .run()
    // Unrelated row ignored.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, currency, tax_tag) VALUES ('2024-03-01', -99, 'USD', 'tax:none')"
      )
      .run()

    const ftc = buildForeignTaxCredit(sqlite, 'USD', [
      { date: '2024-01-01', base: 'USD', quote: 'CRC', rate: 500 }
    ])
    expect(ftc).toEqual([{ year: 2024, foreignTaxPaidUsd: 1_700 }]) // 1200 + 500
  })
})

describe('getFatcaThreshold + buildExpatTaxSummary', () => {
  it('defaults the FATCA threshold and reflects a configured override', () => {
    expect(getFatcaThreshold(sqlite)).toBe(FATCA_THRESHOLD_DEFAULT_USD)
    sqlite
      .prepare("INSERT INTO app_settings (key, value) VALUES ('fatcaThresholdUsd', '200000')")
      .run()
    expect(getFatcaThreshold(sqlite)).toBe(200_000)
  })

  it('assembles FBAR + FATCA + FTC + hasForeignAccounts', () => {
    const id = addAccount(sqlite, { name: 'CR', currency: 'CRC', isForeign: true })
    addRate(sqlite, '2024-12-31', 'CRC', 500)
    addSnap(sqlite, id, '2024-07-01', 9_000_000) // $18k

    const summary = buildExpatTaxSummary(sqlite, 2025)
    expect(summary.reportingCurrency).toBe('USD')
    expect(summary.fbarThreshold).toBe(FBAR_THRESHOLD_USD)
    expect(summary.hasForeignAccounts).toBe(true)
    expect(summary.fbar.find((y) => y.year === 2024)?.exceedsThreshold).toBe(true)
    expect(summary.fatca.find((y) => y.year === 2024)?.exceedsThreshold).toBe(false) // 18k < 50k
  })

  it('always reports in USD even when the net-worth base currency is non-USD', () => {
    // FBAR/FATCA are USD filings; a EUR net-worth base must NOT change the figures
    // (regression for the threshold-currency-mismatch bug).
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES ('baseCurrency', 'EUR')").run()
    const id = addAccount(sqlite, { name: 'CR', currency: 'CRC', isForeign: true })
    addRate(sqlite, '2024-12-31', 'CRC', 500) // USD↔CRC only
    addSnap(sqlite, id, '2024-07-01', 9_000_000)

    const summary = buildExpatTaxSummary(sqlite, 2025)
    expect(summary.reportingCurrency).toBe('USD')
    // ₡9M valued in USD (÷500) = $18,000 — NOT routed through EUR.
    expect(summary.fbar.find((y) => y.year === 2024)?.aggregateMaxUsd).toBe(18_000)
  })
})
