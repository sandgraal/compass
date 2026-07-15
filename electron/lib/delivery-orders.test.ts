/**
 * Tests for the delivery-order recognizers (Phase 10). Mirrors
 * `rideshare.test.ts` — sample columns are best-guess/unvalidated (see the
 * caveat in `delivery-orders.ts`); update fixtures + column candidates
 * together if a real export differs.
 */

import { describe, expect, it } from 'vitest'
import { DOORDASH_RECOGNIZER, INSTACART_RECOGNIZER } from './delivery-orders'
import { type RecognizerFile, recognize } from './recognizers'
import { LYFT_RECOGNIZER, UBER_RECOGNIZER } from './rideshare'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const DOORDASH = [
  'Order ID,Restaurant,Delivered At,Total',
  '123,Chipotle,2026-02-15 18:30:00,24.50'
].join('\n')

const INSTACART = ['Store,Order Date,Total', 'Whole Foods,2026-03-01 10:00:00,88.32'].join('\n')

describe('DoorDash recognizer', () => {
  it('parses an order, puts the restaurant in title + body', () => {
    const f = file('doordash_orders.csv', DOORDASH)
    expect(recognize(f)?.id).toBe('doordash')

    const out = DOORDASH_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'doordash',
      type: 'order',
      title: 'DoorDash · Chipotle · $24.50',
      body: 'Chipotle'
    })
    expect(out[0].occurredAt).toBe(Date.parse('2026-02-15 18:30:00'))
  })
})

describe('Instacart recognizer', () => {
  it('parses an order, puts the store in title + body', () => {
    const f = file('instacart_orders.csv', INSTACART)
    expect(recognize(f)?.id).toBe('instacart')

    const out = INSTACART_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'instacart',
      type: 'order',
      title: 'Instacart · Whole Foods · $88.32',
      body: 'Whole Foods'
    })
    expect(out[0].occurredAt).toBe(Date.parse('2026-03-01 10:00:00'))
  })
})

describe('delivery recognizers do not claim unrelated files', () => {
  it('DoorDash and Instacart do not claim each other, Uber, or Lyft', () => {
    expect(DOORDASH_RECOGNIZER.detect(file('instacart_orders.csv', INSTACART))).toBe(false)
    expect(INSTACART_RECOGNIZER.detect(file('doordash_orders.csv', DOORDASH))).toBe(false)
    expect(
      DOORDASH_RECOGNIZER.detect(
        file(
          'trips_data.csv',
          'City,Product Type,Trip or Order Status,Begin Trip Time,Dropoff Address\nSF,UberX,COMPLETED,2026-02-15,1 Ferry Building'
        )
      )
    ).toBe(false)
  })

  it('Uber and Lyft do not claim DoorDash/Instacart files', () => {
    expect(UBER_RECOGNIZER.detect(file('doordash_orders.csv', DOORDASH))).toBe(false)
    expect(LYFT_RECOGNIZER.detect(file('instacart_orders.csv', INSTACART))).toBe(false)
  })
})
