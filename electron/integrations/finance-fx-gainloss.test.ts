/**
 * Tests for unrealized FX gain/loss (Phase 11.1 follow-up).
 *
 * Pure `computeFxGainLoss` covers the valuation math; `buildFxGainLossFromDb`
 * gets one in-memory integration test through the real net-worth snapshot.
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FxRate } from './finance-fx'
import { buildFxGainLossFromDb, computeFxGainLoss } from './finance-fx-gainloss'

// $1 = ₡500 at the Jan-1 baseline, ₡400 now → the colón STRENGTHENED, so a CRC
// asset is worth more USD (gain) and a CRC debt costs more USD to clear (loss).
const RATES: FxRate[] = [
  { date: '2026-01-01', base: 'USD', quote: 'CRC', rate: 500 },
  { date: '2026-06-01', base: 'USD', quote: 'CRC', rate: 400 }
]

describe('computeFxGainLoss', () => {
  it('values a foreign asset at the baseline vs latest rate and differences them', () => {
    const r = computeFxGainLoss({
      positions: [{ accountId: 1, name: 'CR Checking', currency: 'CRC', balance: 1_000_000 }],
      baseCurrency: 'USD',
      rates: RATES,
      baselineDate: '2026-01-01',
      asOfNow: '2026-06-15'
    })
    expect(r.positions).toHaveLength(1)
    expect(r.positions[0]).toMatchObject({
      baseValueThen: 2000, // ₡1,000,000 / 500
      baseValueNow: 2500, // ₡1,000,000 / 400
      gainLoss: 500
    })
    expect(r.totalGainLoss).toBe(500)
    expect(r.pricedCount).toBe(1)
  })

  it('signs a foreign debt the opposite way (a strengthening colón is a loss on debt)', () => {
    const r = computeFxGainLoss({
      positions: [{ accountId: 2, name: 'CR Mortgage', currency: 'CRC', balance: -2_000_000 }],
      baseCurrency: 'USD',
      rates: RATES,
      baselineDate: '2026-01-01',
      asOfNow: '2026-06-15'
    })
    expect(r.positions[0]).toMatchObject({
      baseValueThen: -4000,
      baseValueNow: -5000,
      gainLoss: -1000
    })
    expect(r.totalGainLoss).toBe(-1000)
  })

  it('nets asset + debt into a single total', () => {
    const r = computeFxGainLoss({
      positions: [
        { accountId: 1, name: 'CR Checking', currency: 'CRC', balance: 1_000_000 },
        { accountId: 2, name: 'CR Mortgage', currency: 'CRC', balance: -2_000_000 }
      ],
      baseCurrency: 'USD',
      rates: RATES,
      baselineDate: '2026-01-01',
      asOfNow: '2026-06-15'
    })
    expect(r.totalGainLoss).toBe(-500) // +500 asset, −1000 debt
    expect(r.pricedCount).toBe(2)
  })

  it('drops base-currency positions — they carry no FX risk', () => {
    const r = computeFxGainLoss({
      positions: [{ accountId: 3, name: 'US Checking', currency: 'USD', balance: 5000 }],
      baseCurrency: 'USD',
      rates: RATES,
      baselineDate: '2026-01-01'
    })
    expect(r.positions).toHaveLength(0)
    expect(r.totalGainLoss).toBe(0)
  })

  it('marks a position unpriced when no rate exists for its currency', () => {
    const r = computeFxGainLoss({
      positions: [{ accountId: 4, name: 'EU Savings', currency: 'EUR', balance: 1000 }],
      baseCurrency: 'USD',
      rates: RATES,
      baselineDate: '2026-01-01',
      asOfNow: '2026-06-15'
    })
    expect(r.positions[0].gainLoss).toBeNull()
    expect(r.pricedCount).toBe(0)
    expect(r.unpricedCount).toBe(1)
    expect(r.totalGainLoss).toBe(0)
  })

  it('is unpriced when a current rate exists but none on/before the baseline', () => {
    const r = computeFxGainLoss({
      positions: [{ accountId: 1, name: 'CR', currency: 'CRC', balance: 1_000_000 }],
      baseCurrency: 'USD',
      rates: [{ date: '2026-06-01', base: 'USD', quote: 'CRC', rate: 400 }], // June only
      baselineDate: '2026-01-01',
      asOfNow: '2026-06-15'
    })
    expect(r.positions[0].baseValueThen).toBeNull()
    expect(r.positions[0].baseValueNow).toBe(2500)
    expect(r.positions[0].gainLoss).toBeNull()
    expect(r.unpricedCount).toBe(1)
  })
})

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      asset_class TEXT NOT NULL DEFAULT 'spending'
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
      rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
  `)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

function addAccount(name: string, currency: string, opts: { isDebt?: boolean } = {}): number {
  return Number(
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, currency, is_debt, asset_class) VALUES (?, ?, ?, 'cash')"
      )
      .run(name, currency, opts.isDebt ? 1 : 0).lastInsertRowid
  )
}
function addSnapshot(accountId: number, balance: number, capturedAt: number): void {
  sqlite
    .prepare(
      "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, 'manual')"
    )
    .run(accountId, capturedAt, balance)
}
function addRate(date: string, rate: number): void {
  sqlite
    .prepare("INSERT INTO fx_rates (date, base, quote, rate) VALUES (?, 'USD', 'CRC', ?)")
    .run(date, rate)
}

describe('buildFxGainLossFromDb', () => {
  it('computes YTD FX gain/loss from live positions + rate history', () => {
    const id = addAccount('CR Checking', 'CRC')
    addSnapshot(id, 1_000_000, Date.UTC(2026, 5, 10))
    addRate('2026-01-01', 500)
    addRate('2026-06-01', 400)

    const r = buildFxGainLossFromDb(sqlite, { now: Date.UTC(2026, 5, 15) })

    expect(r.baseCurrency).toBe('USD')
    expect(r.baselineDate).toBe('2026-01-01')
    expect(r.positions).toHaveLength(1)
    expect(r.positions[0]).toMatchObject({
      currency: 'CRC',
      balance: 1_000_000,
      baseValueThen: 2000,
      baseValueNow: 2500,
      gainLoss: 500
    })
    expect(r.totalGainLoss).toBe(500)
  })

  it('excludes base-currency accounts from the FX view', () => {
    const id = addAccount('US Checking', 'USD')
    addSnapshot(id, 5000, Date.UTC(2026, 5, 10))
    const r = buildFxGainLossFromDb(sqlite, { now: Date.UTC(2026, 5, 15) })
    expect(r.positions).toHaveLength(0)
    expect(r.totalGainLoss).toBe(0)
  })
})
