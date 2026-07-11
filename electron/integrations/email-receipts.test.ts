/**
 * Email-receipts parsing — pure functions, no network/DB. Proves the
 * conservative gate (needs a receipt signal AND a labelled total), the
 * grand-total pick, merchant derivation, Gmail body decode, and that the record
 * body it emits is readable by entities.parseMoney (so spend rolls into Merchants).
 */
import { describe, expect, it } from 'vitest'
import { parseMoney } from '../lib/entities'
import {
  extractBody,
  merchantFromSender,
  parseReceiptEmail,
  receiptsToRecords
} from './email-receipts'

const b64url = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url')
const JUN1 = Date.parse('2026-06-01T15:00:00Z')

describe('merchantFromSender', () => {
  it('maps a known domain to its brand', () => {
    expect(merchantFromSender('Amazon.com <auto-confirm@amazon.com>')).toBe('Amazon')
    expect(merchantFromSender('receipts@email.uber.com')).toBe('Uber')
  })
  it('title-cases an unknown second-level domain', () => {
    expect(merchantFromSender('orders@blenders.example.com')).toBe('Example')
    expect(merchantFromSender('hello@monoprice.com')).toBe('Monoprice')
  })
  it('returns null without a parseable email', () => {
    expect(merchantFromSender('No Reply')).toBeNull()
  })
})

describe('parseReceiptEmail', () => {
  it('parses a confident receipt (signal + labelled total)', () => {
    const r = parseReceiptEmail({
      subject: 'Your Amazon.com order confirmation',
      from: 'auto-confirm@amazon.com',
      bodyText: 'Thanks for your order. Subtotal: $38.00  Tax: $4.00  Order Total: $42.00',
      receivedAt: JUN1
    })
    expect(r).toEqual({ merchant: 'Amazon', amount: 42, currency: 'USD', date: '2026-06-01' })
  })

  it('picks the grand total, not the subtotal', () => {
    const r = parseReceiptEmail({
      subject: 'Receipt from Uber',
      from: 'receipts@uber.com',
      bodyText: 'Total fare $12.50 · Total $18.75 including tip',
      receivedAt: JUN1
    })
    expect(r?.amount).toBe(18.75)
  })

  it('reads € / £ currencies', () => {
    expect(
      parseReceiptEmail({
        subject: 'Invoice',
        from: 'billing@shop.co',
        bodyText: 'Amount due £29.99',
        receivedAt: JUN1
      })?.currency
    ).toBe('GBP')
  })

  it('returns null for a marketing email (no receipt signal)', () => {
    expect(
      parseReceiptEmail({
        subject: 'Weekend sale — save big!',
        from: 'deals@store.com',
        bodyText: 'Everything up to $50 off this weekend only. Total savings await!',
        receivedAt: JUN1
      })
    ).toBeNull()
  })

  it('returns null when there is a signal but no labelled total', () => {
    expect(
      parseReceiptEmail({
        subject: 'Your order has shipped',
        from: 'ship@store.com',
        bodyText: 'Your order is on the way! Track it here.',
        receivedAt: JUN1
      })
    ).toBeNull()
  })
})

describe('extractBody', () => {
  it('decodes a base64url text/plain part', () => {
    const body = extractBody({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/plain', body: { data: b64url('Order Total: $9.99') } }]
    })
    expect(body).toBe('Order Total: $9.99')
  })
  it('falls back to stripped HTML', () => {
    const body = extractBody({
      mimeType: 'text/html',
      body: { data: b64url('<p>Order <b>Total</b>: $5.00</p>') }
    })
    expect(body).toBe('Order Total : $5.00')
  })
})

describe('receiptsToRecords', () => {
  const msg = (id: string, subject: string, from: string, body: string) => ({
    id,
    data: {
      internalDate: String(JUN1),
      payload: {
        headers: [
          { name: 'Subject', value: subject },
          { name: 'From', value: from }
        ],
        parts: [{ mimeType: 'text/plain', body: { data: b64url(body) } }]
      }
    }
  })

  it('builds a spine record per confident receipt and skips the rest', () => {
    const recs = receiptsToRecords([
      msg('a', 'Order confirmation', 'auto-confirm@amazon.com', 'Order Total: $42.00'),
      msg('b', 'Weekly newsletter', 'news@store.com', 'Total savings $99 this week')
    ])
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      source: 'email-receipt',
      type: 'order',
      title: 'Amazon',
      naturalKey: 'a'
    })
  })

  it('emits a body that parseMoney can read (so spend rolls into Merchants)', () => {
    const recs = receiptsToRecords([msg('a', 'Your receipt', 'receipts@uber.com', 'Total $18.75')])
    const money = parseMoney(recs[0].body ?? null)
    expect(money).toEqual({ amount: 18.75, currency: 'USD' })
  })
})
