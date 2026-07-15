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

  it('uses the Order ID as naturalKey when the column is present', () => {
    const out = DOORDASH_RECOGNIZER.parse(file('doordash_orders.csv', DOORDASH))
    expect(out[0].naturalKey).toBe('123')
  })

  it('two same-time, same-restaurant orders get distinct naturalKeys via Order ID', () => {
    const twoOrders = [
      'Order ID,Restaurant,Delivered At,Total',
      '123,Chipotle,2026-02-15 18:30:00,24.50',
      '124,Chipotle,2026-02-15 18:30:00,24.50'
    ].join('\n')
    const out = DOORDASH_RECOGNIZER.parse(file('doordash_orders.csv', twoOrders))
    expect(out).toHaveLength(2)
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey)
  })

  it('falls back to time|merchant|total and still distinguishes same-time orders by total when there is no Order ID column', () => {
    const noOrderId = [
      'Restaurant,Delivered At,Total',
      'Chipotle,2026-02-15 18:30:00,24.50',
      'Chipotle,2026-02-15 18:30:00,31.00'
    ].join('\n')
    const out = DOORDASH_RECOGNIZER.parse(file('doordash_orders.csv', noOrderId))
    expect(out).toHaveLength(2)
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey)
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

  it('uses the Order ID as naturalKey when the column is present', () => {
    const withOrderId = [
      'Order ID,Store,Order Date,Total',
      'INS-9,Whole Foods,2026-03-01 10:00:00,88.32'
    ].join('\n')
    const out = INSTACART_RECOGNIZER.parse(file('instacart_orders.csv', withOrderId))
    expect(out[0].naturalKey).toBe('INS-9')
  })

  it('falls back to time|merchant|total and still distinguishes same-time orders by total when there is no Order ID column', () => {
    const noOrderId = [
      'Store,Order Date,Total',
      'Whole Foods,2026-03-01 10:00:00,88.32',
      'Whole Foods,2026-03-01 10:00:00,42.10'
    ].join('\n')
    const out = INSTACART_RECOGNIZER.parse(file('instacart_orders.csv', noOrderId))
    expect(out).toHaveLength(2)
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey)
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
