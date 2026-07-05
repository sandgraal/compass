import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  NET_WORTH_HOLDINGS_SOURCES,
  SNAPTRADE_SOURCE,
  getLatestHoldings,
  importHoldings
} from './finance-holdings'
import {
  buildSignedContent,
  normalizeSnaptradeHoldings,
  signSnaptrade,
  snaptradeHoldingsToParsed
} from './snaptrade'

const HOLDINGS = [
  {
    account: { id: 'acc-1', name: 'Schwab Brokerage' },
    positions: [
      {
        symbol: { symbol: { symbol: 'AAPL', description: 'Apple Inc', currency: { code: 'USD' } } },
        units: 10,
        price: 150.25,
        average_purchase_price: 145
      },
      {
        symbol: { symbol: { symbol: 'VTI', currency: { code: 'USD' } } },
        units: 5.5,
        price: 220
      }
    ]
  }
]

describe('buildSignedContent — the canonical string SnapTrade signs', () => {
  it('matches the documented mock-signature vector exactly (sorted keys, POST body)', () => {
    const out = buildSignedContent(
      '/api/v1/snapTrade/mockSignature',
      'clientId=PASSIVTEST&timestamp=1635790389',
      { userId: 'api@passiv.com', userSecret: 'CHRIS.P.BACON' }
    )
    expect(out).toBe(
      '{"content":{"userId":"api@passiv.com","userSecret":"CHRIS.P.BACON"},"path":"/api/v1/snapTrade/mockSignature","query":"clientId=PASSIVTEST&timestamp=1635790389"}'
    )
  })

  it('uses null content for a GET (no body)', () => {
    expect(buildSignedContent('/api/v1/holdings', 'clientId=X&timestamp=1')).toBe(
      '{"content":null,"path":"/api/v1/holdings","query":"clientId=X&timestamp=1"}'
    )
  })

  it('sorts nested content keys so the signature is canonical regardless of input order', () => {
    // keys given out of order → serialized sorted (userId before userSecret)
    expect(buildSignedContent('/p', 'q=1', { userSecret: 'b', userId: 'a' })).toBe(
      '{"content":{"userId":"a","userSecret":"b"},"path":"/p","query":"q=1"}'
    )
  })
})

describe('signSnaptrade — HMAC-SHA256 signature', () => {
  it('is deterministic, base64, and sensitive to every input', () => {
    const sig = signSnaptrade('consumer-key', '/api/v1/holdings', 'clientId=X&timestamp=1')
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/) // base64
    // deterministic
    expect(signSnaptrade('consumer-key', '/api/v1/holdings', 'clientId=X&timestamp=1')).toBe(sig)
    // a different key, path, query, or body all change the signature
    expect(signSnaptrade('other-key', '/api/v1/holdings', 'clientId=X&timestamp=1')).not.toBe(sig)
    expect(signSnaptrade('consumer-key', '/api/v1/accounts', 'clientId=X&timestamp=1')).not.toBe(
      sig
    )
    expect(signSnaptrade('consumer-key', '/api/v1/holdings', 'clientId=X&timestamp=2')).not.toBe(
      sig
    )
    expect(
      signSnaptrade('consumer-key', '/api/v1/holdings', 'clientId=X&timestamp=1', { a: 1 })
    ).not.toBe(sig)
  })
})

describe('normalizeSnaptradeHoldings', () => {
  it('extracts ticker/units/price from the nested symbol object and derives value + cost basis', () => {
    const out = normalizeSnaptradeHoldings(HOLDINGS)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      symbol: 'AAPL',
      description: 'Apple Inc',
      units: 10,
      price: 150.25,
      value: 1502.5, // 10 × 150.25
      costBasis: 1450, // 145 × 10
      currency: 'USD',
      account: 'acc-1'
    })
    expect(out[1]).toMatchObject({ symbol: 'VTI', units: 5.5, value: 1210, costBasis: null })
  })

  it('skips positions with no symbol or no units, and tolerates malformed input', () => {
    expect(normalizeSnaptradeHoldings({})).toEqual([])
    expect(normalizeSnaptradeHoldings({ positions: 'nope' })).toEqual([])
    const partial = normalizeSnaptradeHoldings([
      { account: { id: 'a' }, positions: [{ units: 10 }, { symbol: { symbol: { symbol: 'X' } } }] }
    ])
    expect(partial).toEqual([]) // first has no symbol, second has no units
  })
})

describe('SnapTrade → net worth (real DB)', () => {
  function makeDb(): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: Database.Database } {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
        dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
      );
    `)
    return { db: drizzle(sqlite, { schema }), sqlite }
  }

  it('projects holdings into the shared store so the net-worth card rolls them up', () => {
    const { db, sqlite } = makeDb()
    const holdings = snaptradeHoldingsToParsed(normalizeSnaptradeHoldings(HOLDINGS))
    const { imported } = importHoldings(db, holdings, '2026-07-05', 'snaptrade', SNAPTRADE_SOURCE)
    expect(imported).toBe(2)

    // The Net Worth holdings card reads NET_WORTH_HOLDINGS_SOURCES — SnapTrade is in it.
    const latest = getLatestHoldings(sqlite, NET_WORTH_HOLDINGS_SOURCES)
    expect(latest.asOf).toBe('2026-07-05')
    expect(latest.holdings.map((h) => h.symbol).sort()).toEqual(['AAPL', 'VTI'])
    expect(latest.summary.totalMarketValue).toBe(2712.5) // 1502.5 + 1210

    // Re-sync the same day is idempotent (sha256 dedup) — no double snapshot.
    expect(importHoldings(db, holdings, '2026-07-05', 'snaptrade', SNAPTRADE_SOURCE).imported).toBe(
      0
    )
  })
})
