/**
 * Tests for the rideshare recognizers (Phase 10). Covers Uber's documented
 * columns, cancelled-row skipping, the dropoff-in-body contract the place
 * extractor relies on, and that Uber/Lyft detection don't fight over a file.
 *
 * NOTE: sample columns mirror the documented/typical exports; update fixtures +
 * the recognizer's column candidates together if a real export differs.
 */

import { describe, expect, it } from 'vitest'
import { type RecognizerFile, recognize } from './recognizers'
import { LYFT_RECOGNIZER, UBER_RECOGNIZER } from './rideshare'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const UBER = [
  'City,Product Type,Trip or Order Status,Begin Trip Time,Dropoff Address,Distance (miles),Fare Amount,Fare Currency',
  'San Francisco,UberX,COMPLETED,2026-02-15 18:30:00,"1 Ferry Building, San Francisco, CA",4.2,18.50,USD',
  'San Francisco,UberX,CANCELED,2026-02-16 09:00:00,"555 California St",0,0,USD'
].join('\n')

const LYFT = [
  'Requested,Pickup,Dropoff,Amount',
  '2026-03-01 10:00:00,"Home","900 Market St, San Francisco",22.00'
].join('\n')

describe('Uber recognizer', () => {
  it('parses completed trips, skips cancelled, puts dropoff in body', () => {
    const f = file('trips_data.csv', UBER)
    expect(recognize(f)?.id).toBe('uber')

    const out = UBER_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1) // cancelled row skipped
    expect(out[0]).toMatchObject({
      source: 'uber',
      type: 'ride',
      title: 'Uber ride · $18.50',
      body: '1 Ferry Building, San Francisco, CA' // dropoff → Places extractor
    })
    expect(out[0].occurredAt).toBe(Date.parse('2026-02-15 18:30:00'))
  })
})

describe('Lyft recognizer', () => {
  it('parses a Lyft ride and keeps dropoff in body', () => {
    const f = file('lyft_rides.csv', LYFT)
    expect(recognize(f)?.id).toBe('lyft')
    const out = LYFT_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'lyft',
      title: 'Lyft ride · $22.00',
      body: '900 Market St, San Francisco'
    })
  })

  it('Uber and Lyft do not claim each other’s files', () => {
    expect(LYFT_RECOGNIZER.detect(file('trips_data.csv', UBER))).toBe(false)
    expect(UBER_RECOGNIZER.detect(file('lyft_rides.csv', LYFT))).toBe(false)
  })
})
