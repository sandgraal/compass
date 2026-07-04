/**
 * Tests for the crypto-exchange recognizers (Phase 10). Covers the Coinbase
 * transaction-history shape (with its preamble) and the Kraken ledger shape,
 * that each claims its own file ahead of the generic catch-all, the composed vs
 * stable dedup keys, and that neither grabs a non-crypto CSV.
 *
 * NOTE: the sample headers mirror the documented/typical export formats. If a
 * real Coinbase/Kraken export differs, update these fixtures + the recognizer's
 * column candidates together.
 */

import { describe, expect, it } from 'vitest'
import { COINBASE_RECOGNIZER, KRAKEN_RECOGNIZER } from './crypto-exchange'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const COINBASE = [
  'You can use this transaction report to inform your likely tax obligations.',
  '',
  'Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes',
  '2026-01-15T12:34:56Z,Buy,BTC,0.50000000,USD,30000.00,15000.00,15025.00,25.00,Bought 0.5 BTC',
  '2026-02-01T09:00:00Z,Sell,ETH,2.00000000,USD,2500.00,5000.00,4990.00,10.00,Sold 2 ETH',
  ',,,,,,,,,' // blank row → skipped
].join('\n')

const KRAKEN = [
  '"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"',
  '"L1","R1","2026-01-15 12:34:56","trade","","currency","XXBT","0.5000","0.0010","0.5000"',
  '"L2","R2","2026-02-01 09:00:00","deposit","","currency","ZUSD","1000.00","0.00","1000.00"',
  '"","R3","2026-03-01 00:00:00","trade","","currency","XETH","1.0","0.0","1.0"' // no txid → skipped
].join('\n')

describe('Coinbase transaction recognizer', () => {
  it('recognizes a transaction history export — one record per transaction', () => {
    const f = file('Coinbase-transactions.csv', COINBASE)
    expect(recognize(f)?.id).toBe('coinbase') // claims it ahead of the generic catch-all

    const out = COINBASE_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.source === 'coinbase' && r.type === 'crypto')).toBe(true)

    const buy = out[0]
    expect(buy.title).toBe('Buy 0.5 BTC')
    expect(buy.body).toBe('$15,025.00') // Total inclusive of fees, formatted USD
    expect(buy.occurredAt).toBe(Date.parse('2026-01-15T12:34:56Z'))
    expect(buy.naturalKey).toContain('Buy')
  })

  it('does not claim a non-Coinbase CSV', () => {
    const f = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    expect(COINBASE_RECOGNIZER.detect(f)).toBe(false)
  })
})

describe('Kraken ledger recognizer', () => {
  it('recognizes a ledger export keyed on the stable txid', () => {
    const f = file('ledgers.csv', KRAKEN)
    expect(recognize(f)?.id).toBe('kraken')

    const out = KRAKEN_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2) // the txid-less row is skipped
    expect(out.every((r) => r.source === 'kraken' && r.type === 'crypto')).toBe(true)

    const trade = out.find((r) => r.naturalKey === 'L1')
    expect(trade?.title).toBe('trade 0.5 XXBT')
    expect(trade?.occurredAt).toBe(Date.parse('2026-01-15 12:34:56'))
  })

  it('does not claim a non-Kraken CSV', () => {
    const f = file('paypal.csv', 'Date,Name,Amount\n1/2/26,Store,-5.00\n')
    expect(KRAKEN_RECOGNIZER.detect(f)).toBe(false)
  })
})
