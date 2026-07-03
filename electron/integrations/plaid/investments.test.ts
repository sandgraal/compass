/**
 * Tests for the pure Plaid-investments normalization (Phase 10.2 — LIVE path).
 * The network/DB wrapper (`syncPlaidInvestments`) is a thin shell; the join
 * logic (holdings ↔ securities → ParsedHolding) is what's worth pinning down.
 */

import type { Holding, Security } from 'plaid'
import { describe, expect, it } from 'vitest'
import { type HoldingsPage, normalizePlaidHoldings } from './investments'

function holding(over: Partial<Holding>): Holding {
  return {
    account_id: 'acc_1',
    security_id: 'sec_1',
    institution_price: 100,
    institution_value: 1000,
    cost_basis: 800,
    quantity: 10,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    ...over
  } as Holding
}

function security(over: Partial<Security>): Security {
  return {
    security_id: 'sec_1',
    ticker_symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'equity',
    ...over
  } as Security
}

const acct = (id: string): string => `Fidelity ·${id.slice(-4)}`

describe('normalizePlaidHoldings', () => {
  it('joins holdings to securities and maps market value + cost basis', () => {
    const page: HoldingsPage = {
      holdings: [holding({})],
      securities: [security({})]
    }
    const out = normalizePlaidHoldings(page, acct)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      symbol: 'AAPL',
      description: 'Apple Inc.',
      quantity: 10,
      price: 100,
      marketValue: 1000,
      costBasis: 800,
      account: 'Fidelity ·cc_1'
    })
  })

  it('falls back to name then security_id when there is no ticker', () => {
    const page: HoldingsPage = {
      holdings: [holding({ security_id: 'sec_mmf' })],
      securities: [
        security({ security_id: 'sec_mmf', ticker_symbol: null, name: 'Money Market Fund' })
      ]
    }
    expect(normalizePlaidHoldings(page, acct)[0].symbol).toBe('MONEY MARKET FUND')

    const noSec: HoldingsPage = { holdings: [holding({ security_id: 'orphan' })], securities: [] }
    expect(normalizePlaidHoldings(noSec, acct)[0].symbol).toBe('ORPHAN')
  })

  it('carries null cost basis through (Plaid omits it for some securities)', () => {
    const page: HoldingsPage = {
      holdings: [holding({ cost_basis: null })],
      securities: [security({})]
    }
    expect(normalizePlaidHoldings(page, acct)[0].costBasis).toBeNull()
  })
})
