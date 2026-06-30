/**
 * Tests for the brokerage-holdings importer (Phase 10.2 — FILE path).
 *
 * `parseHoldingsCsv` + `summarizeHoldings` are pure; `importHoldings` /
 * `getLatestHoldings` round-trip through an in-memory `records` table.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  getLatestHoldings,
  importHoldings,
  parseHoldingsCsv,
  summarizeHoldings
} from './finance-holdings'

describe('parseHoldingsCsv', () => {
  it('parses a standard positions export', () => {
    const headers = ['Symbol', 'Description', 'Quantity', 'Price', 'Market Value', 'Cost Basis']
    const rows = [
      ['AAPL', 'Apple Inc', '100', '$190.00', '$19,000.00', '$12,000.00'],
      ['VTI', 'Vanguard Total Mkt', '50', '$260.00', '$13,000.00', '$10,500.00']
    ]
    const out = parseHoldingsCsv(headers, rows)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      symbol: 'AAPL',
      description: 'Apple Inc',
      quantity: 100,
      price: 190,
      marketValue: 19000,
      costBasis: 12000,
      account: null
    })
  })

  it('matches alternate column names (ticker/shares/last/value)', () => {
    const headers = ['Ticker', 'Shares', 'Last', 'Value']
    const rows = [['MSFT', '10', '400', '4000']]
    const out = parseHoldingsCsv(headers, rows, { account: 'Roth IRA' })
    expect(out[0]).toMatchObject({
      symbol: 'MSFT',
      quantity: 10,
      price: 400,
      marketValue: 4000,
      account: 'Roth IRA'
    })
  })

  it('derives market value from quantity × price when the column is absent', () => {
    const headers = ['Symbol', 'Quantity', 'Price']
    const rows = [['TSLA', '3', '250.50']]
    expect(parseHoldingsCsv(headers, rows)[0].marketValue).toBe(751.5)
  })

  it('reads parenthesized values as negative (a short / loss column)', () => {
    const headers = ['Symbol', 'Quantity', 'Market Value', 'Cost Basis']
    const rows = [['SQQQ', '-10', '(500.00)', '600']]
    const out = parseHoldingsCsv(headers, rows)
    expect(out[0]).toMatchObject({ quantity: -10, marketValue: -500, costBasis: 600 })
  })

  it('skips total/summary rows and rows with nothing usable', () => {
    const headers = ['Symbol', 'Quantity', 'Market Value']
    const rows = [
      ['AAPL', '100', '19000'],
      ['Total', '', '19000'], // summary
      ['', '', ''], // blank
      ['CASH', '', ''] // no qty/value → skip
    ]
    expect(parseHoldingsCsv(headers, rows)).toHaveLength(1)
  })

  it('returns [] when the file is not a positions export (no symbol column)', () => {
    expect(parseHoldingsCsv(['Date', 'Amount', 'Description'], [['2026-01-01', '5', 'x']])).toEqual(
      []
    )
  })
})

describe('summarizeHoldings', () => {
  it('totals market value, cost basis, and unrealized gain', () => {
    const s = summarizeHoldings([
      {
        symbol: 'A',
        description: null,
        quantity: 1,
        price: null,
        marketValue: 19000,
        costBasis: 12000,
        account: null
      },
      {
        symbol: 'B',
        description: null,
        quantity: 1,
        price: null,
        marketValue: 13000,
        costBasis: 10000,
        account: null
      }
    ])
    expect(s).toEqual({
      count: 2,
      totalMarketValue: 32000,
      totalCostBasis: 22000,
      totalGain: 10000,
      totalGainPct: 45.45
    })
  })

  it('leaves gain null when no position carries a cost basis', () => {
    const s = summarizeHoldings([
      {
        symbol: 'A',
        description: null,
        quantity: 1,
        price: null,
        marketValue: 100,
        costBasis: null,
        account: null
      }
    ])
    expect(s).toMatchObject({
      totalMarketValue: 100,
      totalCostBasis: null,
      totalGain: null,
      totalGainPct: null
    })
  })
})

function makeDb(): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      occurred_at INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE,
      provenance TEXT,
      ingested_at INTEGER
    );
  `)
  return { db: drizzle(sqlite, { schema }), sqlite }
}

const SAMPLE = [
  {
    symbol: 'AAPL',
    description: 'Apple',
    quantity: 100,
    price: 190,
    marketValue: 19000,
    costBasis: 12000,
    account: null
  },
  {
    symbol: 'VTI',
    description: 'Vanguard',
    quantity: 50,
    price: 260,
    marketValue: 13000,
    costBasis: 10500,
    account: null
  }
]

describe('importHoldings + getLatestHoldings', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: Database.Database
  beforeEach(() => {
    ;({ db, sqlite } = makeDb())
  })

  it('persists a snapshot and reads it back with a summary', () => {
    const res = importHoldings(db, SAMPLE, '2026-06-30', 'schwab.csv')
    expect(res).toEqual({ imported: 2, duplicates: 0 })

    const latest = getLatestHoldings(sqlite)
    expect(latest.asOf).toBe('2026-06-30')
    expect(latest.holdings).toHaveLength(2)
    expect(latest.summary).toMatchObject({ count: 2, totalMarketValue: 32000, totalGain: 9500 })
  })

  it('dedups a re-import of the same as-of day', () => {
    importHoldings(db, SAMPLE, '2026-06-30', 'schwab.csv')
    const second = importHoldings(db, SAMPLE, '2026-06-30', 'schwab.csv')
    expect(second).toEqual({ imported: 0, duplicates: 2 })
    expect(getLatestHoldings(sqlite).holdings).toHaveLength(2)
  })

  it('returns only the most recent snapshot when several dates exist', () => {
    importHoldings(db, SAMPLE, '2026-05-31', 'may.csv')
    importHoldings(db, [SAMPLE[0]], '2026-06-30', 'june.csv') // June: just AAPL
    const latest = getLatestHoldings(sqlite)
    expect(latest.asOf).toBe('2026-06-30')
    expect(latest.holdings.map((h) => h.symbol)).toEqual(['AAPL'])
  })

  it('is empty when nothing has been imported', () => {
    const latest = getLatestHoldings(sqlite)
    expect(latest).toMatchObject({ asOf: null, holdings: [] })
    expect(latest.summary.count).toBe(0)
  })
})
