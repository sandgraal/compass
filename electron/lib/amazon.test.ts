/**
 * Tests for the Amazon order-history recognizer (Phase 10). Covers both export
 * shapes (modern Retail.OrderHistory + legacy Items report), the per-item dedup
 * key, money formatting, and that it claims the file ahead of the generic
 * catch-all without grabbing a non-Amazon CSV.
 */

import { describe, expect, it } from 'vitest'
import { AMAZON_RECOGNIZER } from './amazon'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

// Modern "Request My Data" export: ISO dates, bare-number Total Owed + Currency.
const MODERN = [
  'Website,Order ID,Order Date,Currency,Unit Price,Total Owed,Quantity,Product Name',
  'Amazon.com,111-2223334-5556667,2026-01-05T14:00:00Z,USD,12.99,12.99,1,USB-C Cable 6ft',
  'Amazon.com,111-2223334-5556667,2026-01-05T14:00:00Z,USD,8.50,17.00,2,AA Batteries (8-pack)',
  'Amazon.com,222-3334445-6667778,2025-12-20T09:30:00Z,USD,49.99,49.99,1,Mechanical Keyboard'
].join('\n')

// Legacy "Order History Reports" Items export: M/D/YY dates, $-prefixed totals.
const LEGACY = [
  'Order Date,Order ID,Title,Category,Item Total,Quantity',
  '12/25/25,D01-9988776-5544332,"The Pragmatic Programmer, 2nd Edition",Book,$42.00,1'
].join('\n')

describe('Amazon order-history recognizer', () => {
  it('recognizes a modern Retail.OrderHistory export — one record per item', () => {
    const f = file('Retail.OrderHistory.1.csv', MODERN)
    expect(recognize(f)?.id).toBe('amazon') // claims it ahead of the generic catch-all

    const out = AMAZON_RECOGNIZER.parse(f)
    expect(out).toHaveLength(3)
    expect(out.every((r) => r.source === 'amazon' && r.type === 'order')).toBe(true)

    const titles = out.map((r) => r.title)
    expect(titles).toContain('USB-C Cable 6ft')
    expect(titles).toContain('AA Batteries (8-pack)')

    expect(out[0].occurredAt).toBe(Date.parse('2026-01-05T14:00:00Z')) // ISO order date
    expect(out[0].body).toBe('12.99 USD') // bare number + Currency column

    // Two line items in one order must dedupe on (order|product), not order alone.
    expect(out[0].naturalKey).toBe('111-2223334-5556667|USB-C Cable 6ft')
    expect(out[1].naturalKey).toBe('111-2223334-5556667|AA Batteries (8-pack)')
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey)
  })

  it('recognizes a legacy Items report (M/D/YY date, $-total, quoted title)', () => {
    const f = file('01-Jan-2026_to_31-Dec-2026.csv', LEGACY)
    expect(recognize(f)?.id).toBe('amazon')

    const out = AMAZON_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('The Pragmatic Programmer, 2nd Edition') // embedded comma preserved
    expect(out[0].body).toBe('$42.00') // currency symbol kept verbatim
    expect(out[0].occurredAt).toBe(new Date(2025, 11, 25).getTime()) // local 12/25/25
  })

  it('does not claim a non-Amazon CSV (Netflix viewing history)', () => {
    const f = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    expect(AMAZON_RECOGNIZER.detect(f)).toBe(false)
    expect(recognize(f)?.id).not.toBe('amazon')
  })

  it('skips blank rows and drops non-numeric totals', () => {
    const csv = [
      'Order ID,Order Date,Total Owed,Currency,Product Name',
      ',,,,', // blank → skipped (no product, no order id)
      '900-0001,2026-02-01,Not Available,USD,Gift Card' // non-numeric total → no body
    ].join('\n')
    const out = AMAZON_RECOGNIZER.parse(file('Retail.OrderHistory.2.csv', csv))
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Gift Card')
    expect(out[0].body).toBeUndefined()
  })
})
