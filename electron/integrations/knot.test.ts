import { describe, expect, it } from 'vitest'
import { normalizeKnotTransactions } from './knot'

// A representative TransactionLink payload: one multi-item order + one order with no
// itemized products, plus a junk row that must be skipped.
const PAYLOAD = {
  transactions: [
    {
      id: 'txn_1',
      datetime: '2026-06-15T18:30:00Z',
      merchant: { id: '19', name: 'Amazon' },
      price: { total: 42.5, currency: 'USD' },
      products: [
        { name: 'USB-C Cable 6ft', quantity: 2, price: { total: 12.99 }, url: 'https://a.co/x' },
        { name: 'AA Batteries', quantity: 1, price: { unit_price: 8.49 } }
      ]
    },
    {
      id: 'txn_2',
      datetime: '2026-06-16T12:00:00Z',
      merchant: 'DoorDash',
      total: 27.8,
      currency: 'USD'
      // no products → one order-level row
    },
    { datetime: '2026-06-17T00:00:00Z', merchant: { name: 'Nope' } } // no id → skipped
  ]
}

describe('normalizeKnotTransactions', () => {
  it('emits one record per line item + an order-level row when no items', () => {
    const recs = normalizeKnotTransactions(PAYLOAD)
    // 2 line items + 1 order-level = 3
    expect(recs).toHaveLength(3)
    expect(recs.every((r) => r.source === 'knot' && r.type === 'order')).toBe(true)
  })

  it('carries product name + merchant into the title and price into the body', () => {
    const recs = normalizeKnotTransactions(PAYLOAD)
    const cable = recs.find((r) => r.title.startsWith('USB-C Cable'))
    expect(cable?.title).toBe('USB-C Cable 6ft — Amazon')
    expect(cable?.body).toBe('12.99 USD')
    expect(cable?.occurredAt).toBe(Date.parse('2026-06-15T18:30:00Z'))
    // unit_price fallback when a line has no total
    expect(recs.find((r) => r.title.startsWith('AA Batteries'))?.body).toBe('8.49 USD')
  })

  it('emits a single order-level row (with the order total) for item-less orders', () => {
    const recs = normalizeKnotTransactions(PAYLOAD)
    const order = recs.find((r) => r.title === 'Order at DoorDash')
    expect(order).toBeDefined()
    expect(order?.body).toBe('27.80 USD')
    expect(order?.naturalKey).toBe('DoorDash|txn_2')
  })

  it('produces stable, unique natural keys so re-syncs dedupe per item', () => {
    const first = normalizeKnotTransactions(PAYLOAD).map((r) => r.naturalKey)
    const second = normalizeKnotTransactions(PAYLOAD).map((r) => r.naturalKey)
    expect(first).toEqual(second) // deterministic → upsert dedupes
    expect(new Set(first).size).toBe(first.length) // all distinct within a pull
    expect(first).toContain('19|txn_1|0|USB-C Cable 6ft')
  })

  it('skips transactions with no id and tolerates empty / malformed input', () => {
    expect(normalizeKnotTransactions(PAYLOAD).some((r) => r.title.includes('Nope'))).toBe(false)
    expect(normalizeKnotTransactions({})).toEqual([])
    expect(normalizeKnotTransactions({ transactions: 'nope' })).toEqual([])
    expect(normalizeKnotTransactions(null)).toEqual([])
  })
})
