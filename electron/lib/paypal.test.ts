/**
 * Tests for the PayPal transaction-history recognizer (Phase 10). Covers the
 * statement (Gross) and activity (Amount) column shapes, the signed-amount body,
 * Transaction-ID dedup key, and that it claims PayPal CSVs ahead of the generic
 * catch-all without grabbing Amazon's order export.
 */

import { describe, expect, it } from 'vitest'
import { PAYPAL_RECOGNIZER } from './paypal'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

// Statement-style export: Gross + Fee + Net, signed amounts, a unique Transaction ID.
const STATEMENT = [
  'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID',
  '01/15/2026,10:30:00,PST,Jane Doe,Money Sent,Completed,USD,-25.00,0.00,-25.00,8XY11223344556677',
  '01/20/2026,14:05:00,PST,Acme Store,Express Checkout Payment,Completed,USD,-49.99,0.00,-49.99,9AB99887766554433',
  '01/22/2026,09:00:00,PST,John Smith,Money Received,Completed,USD,75.00,0.00,75.00,7CD55667788990011'
].join('\n')

// Activity-style export: a single `Amount` column instead of Gross/Net.
const ACTIVITY = [
  'Date,Name,Type,Status,Currency,Amount,Receipt ID,Transaction ID',
  '01/25/2026,Coffee Shop,Mobile Payment,Completed,USD,-4.50,,5EF00112233445566'
].join('\n')

describe('PayPal transaction-history recognizer', () => {
  it('recognizes a statement export — one record per transaction', () => {
    const f = file('Download.csv', STATEMENT)
    expect(recognize(f)?.id).toBe('paypal') // claims it ahead of the generic catch-all

    const out = PAYPAL_RECOGNIZER.parse(f)
    expect(out).toHaveLength(3)
    expect(out.every((r) => r.source === 'paypal' && r.type === 'payment')).toBe(true)

    expect(out[0].title).toBe('Jane Doe')
    expect(out[0].body).toBe('-25.00 USD · Money Sent') // sign preserved (sent = negative)
    expect(out[2].body).toBe('75.00 USD · Money Received') // received = positive
    expect(out[0].occurredAt).toBe(new Date(2026, 0, 15).getTime())

    // Transaction ID is the unique dedup key.
    expect(out[0].naturalKey).toBe('8XY11223344556677')
    expect(new Set(out.map((r) => r.naturalKey)).size).toBe(3)
  })

  it('handles the activity shape (Amount column instead of Gross)', () => {
    const f = file('activity.csv', ACTIVITY)
    expect(recognize(f)?.id).toBe('paypal')

    const out = PAYPAL_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Coffee Shop')
    expect(out[0].body).toBe('-4.50 USD · Mobile Payment')
    expect(out[0].naturalKey).toBe('5EF00112233445566')
  })

  it('does not claim an Amazon order CSV or a plain dated CSV', () => {
    const amazon = file(
      'Retail.OrderHistory.1.csv',
      'Website,Order ID,Order Date,Currency,Total Owed,Product Name\nAmazon.com,111,2026-01-05,USD,9.99,Cable\n'
    )
    expect(PAYPAL_RECOGNIZER.detect(amazon)).toBe(false)
    expect(recognize(amazon)?.id).not.toBe('paypal')

    const plain = file('misc.csv', 'when,event\n2026-02-01,Did a thing\n')
    expect(PAYPAL_RECOGNIZER.detect(plain)).toBe(false)
  })
})
