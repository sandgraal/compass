/**
 * Merchant ↔ transaction matching — real in-memory SQLite for the backfill
 * (idempotency, batching, junk descriptions) plus the pure match-key parser.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureNormalizedMerchants,
  matchKeyForPlace,
  matchKeyForSubscription
} from './merchant-match'
import { normalizeMerchant } from './normalize'

let sqlite: Database.Database

const DDL = `CREATE TABLE finance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  normalized_merchant TEXT
);`

function insertTxn(desc: string, normalized: string | null = null): void {
  sqlite
    .prepare(
      `INSERT INTO finance_transactions (hash, date, amount, description, normalized_merchant)
       VALUES (?, '2026-01-15', -10, ?, ?)`
    )
    .run(`h-${Math.random().toString(36).slice(2)}`, desc, normalized)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
})
afterEach(() => sqlite.close())

describe('ensureNormalizedMerchants', () => {
  it('backfills NULL rows with normalizeMerchant(description)', () => {
    insertTxn('APLPAY NETFLIX.COM 12345 CA')
    insertTxn('Payment to Spotify Inc')
    const updated = ensureNormalizedMerchants(sqlite)
    expect(updated).toBe(2)
    const rows = sqlite
      .prepare('SELECT description, normalized_merchant AS nm FROM finance_transactions')
      .all() as Array<{ description: string; nm: string }>
    for (const r of rows) expect(r.nm).toBe(normalizeMerchant(r.description))
  })

  it('is idempotent — a second run touches nothing', () => {
    insertTxn('Netflix')
    expect(ensureNormalizedMerchants(sqlite)).toBe(1)
    expect(ensureNormalizedMerchants(sqlite)).toBe(0)
  })

  it('leaves already-populated rows alone', () => {
    insertTxn('Netflix', 'hand-set-value')
    expect(ensureNormalizedMerchants(sqlite)).toBe(0)
    const row = sqlite
      .prepare('SELECT normalized_merchant AS nm FROM finance_transactions')
      .get() as { nm: string }
    expect(row.nm).toBe('hand-set-value')
  })

  it("stores '' (not NULL) for junk descriptions so the loop terminates", () => {
    insertTxn('12345678') // all digits → normalizeMerchant returns ''
    expect(ensureNormalizedMerchants(sqlite)).toBe(1)
    const row = sqlite
      .prepare('SELECT normalized_merchant AS nm FROM finance_transactions')
      .get() as { nm: string }
    expect(row.nm).toBe('')
    expect(ensureNormalizedMerchants(sqlite)).toBe(0)
  })

  it('processes more rows than one batch', () => {
    const insert = sqlite.prepare(
      `INSERT INTO finance_transactions (hash, date, amount, description)
       VALUES (?, '2026-01-15', -10, 'Coffee Shop')`
    )
    const seed = sqlite.transaction(() => {
      for (let i = 0; i < 5001; i++) insert.run(`h${i}`)
    })
    seed()
    expect(ensureNormalizedMerchants(sqlite)).toBe(5001)
    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS n FROM finance_transactions WHERE normalized_merchant IS NULL')
      .get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})

describe('matchKeyForPlace', () => {
  it('parses the key out of a derived merchant external id', () => {
    expect(matchKeyForPlace('derived:merchant:blue bottle coffee', 'Blue Bottle')).toBe(
      'blue bottle coffee'
    )
  })

  it('parses derived place ids too', () => {
    expect(matchKeyForPlace('derived:place:main st gym', 'Main St Gym')).toBe('main st gym')
  })

  it('falls back to normalizeMerchant(name) for manual rows', () => {
    expect(matchKeyForPlace('manual:abc-123', 'Payment to Blue Bottle Inc')).toBe(
      normalizeMerchant('Payment to Blue Bottle Inc')
    )
  })

  it('keys with colons survive the parse', () => {
    expect(matchKeyForPlace('derived:merchant:weird: key', 'x')).toBe('weird: key')
  })
})

describe('matchKeyForSubscription', () => {
  it('parses the merchant out of a detected external id', () => {
    expect(matchKeyForSubscription('detected:netflix::Chase Checking', 'Netflix')).toBe('netflix')
  })

  it('handles the default "—" account suffix', () => {
    expect(matchKeyForSubscription('detected:spotify::—', 'Spotify')).toBe('spotify')
  })

  it('falls back to normalizeMerchant(name) for manual rows', () => {
    expect(matchKeyForSubscription('manual:abc-123', 'Payment to Blue Bottle Inc')).toBe(
      normalizeMerchant('Payment to Blue Bottle Inc')
    )
  })

  it('keys with double colons survive the parse (greedy up to the last "::")', () => {
    expect(matchKeyForSubscription('detected:weird::key::Chase Checking', 'x')).toBe('weird::key')
  })

  it('an account name with a single colon does not break the parse', () => {
    expect(matchKeyForSubscription('detected:netflix::Chase: Business Checking', 'Netflix')).toBe(
      'netflix'
    )
  })

  it('is the exact inverse of the detectedKey format merchants.ts resolves against', () => {
    const merchant = 'blue bottle coffee'
    const account = 'Amex Gold'
    const externalId = `detected:${merchant}::${account}`
    expect(matchKeyForSubscription(externalId, 'Blue Bottle')).toBe(merchant)
  })
})
