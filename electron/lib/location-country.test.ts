/**
 * Tests for offline country derivation (Phase 10.8). `countryForPoint` is checked
 * against the bundled Natural Earth 110m set on INTERIOR coordinates (border points
 * are intentionally coarse at 110m), including an enclave (Lesotho inside South
 * Africa) to confirm holes are respected. `pointsToSegments` collapse logic is tested
 * with an injected `countryOf`/`localDayOf` so it's deterministic and TZ-independent.
 */

import { describe, expect, it } from 'vitest'
import boundaries from './country-boundaries.json'
import { type LocPoint, countryForPoint, pointsToSegments } from './location-country'

describe('countryForPoint (offline point-in-polygon)', () => {
  it('resolves interior coordinates to the right ISO-2', () => {
    expect(countryForPoint(9.93, -84.08)).toBe('CR') // San José
    expect(countryForPoint(40.71, -74.01)).toBe('US') // New York City
    expect(countryForPoint(40.4168, -3.7038)).toBe('ES') // Madrid
    expect(countryForPoint(51.5074, -0.1278)).toBe('GB') // London
  })

  it('returns null over open ocean', () => {
    expect(countryForPoint(0, -140)).toBeNull() // mid-Pacific
  })

  it('attributes an enclave to itself, not its surrounder (holes respected)', () => {
    expect(countryForPoint(-29.6, 28.3)).toBe('LS') // central Lesotho, inside South Africa
  })

  it('rejects non-finite input', () => {
    expect(countryForPoint(Number.NaN, 0)).toBeNull()
  })
})

// ── pointsToSegments — deterministic via injected country + day resolvers ──────

const dayUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const at = (day: number, hour = 12): number => Date.UTC(2025, 0, day, hour)
// lat encodes the country for the fake resolver
const fakeCountry = (lat: number): string | null =>
  lat === 10 ? 'CR' : lat === 40 ? 'US' : lat === 50 ? 'ES' : null
const p = (day: number, lat: number, hour = 12): LocPoint => ({ at: at(day, hour), lat, lng: 0 })
const opts = (over: Partial<Parameters<typeof pointsToSegments>[1]> = {}) => ({
  homeCountry: 'XX',
  localDayOf: dayUtc,
  countryOf: (lat: number) => fakeCountry(lat),
  ...over
})

describe('pointsToSegments', () => {
  it('collapses consecutive same-country days into one run', () => {
    const segs = pointsToSegments([p(1, 10), p(2, 10), p(3, 10)], opts())
    expect(segs).toEqual([
      { country: 'CR', startDate: '2025-01-01', endDate: '2025-01-03', days: 3, pointCount: 3 }
    ])
  })

  it('breaks a run on a country change (CR → US → CR = three runs)', () => {
    const segs = pointsToSegments(
      [p(1, 10), p(2, 10), p(3, 40), p(4, 40), p(5, 10), p(6, 10)],
      opts()
    )
    expect(segs.map((s) => `${s.country}:${s.startDate}..${s.endDate}`)).toEqual([
      'CR:2025-01-01..2025-01-02',
      'US:2025-01-03..2025-01-04',
      'CR:2025-01-05..2025-01-06'
    ])
  })

  it('drops home-country runs (home is the residency remainder)', () => {
    const segs = pointsToSegments(
      [p(1, 10), p(2, 10), p(3, 40), p(4, 40)],
      opts({ homeCountry: 'CR' })
    )
    expect(segs).toEqual([
      { country: 'US', startDate: '2025-01-03', endDate: '2025-01-04', days: 2, pointCount: 2 }
    ])
  })

  it('bridges a short interior gap but breaks on a gap beyond the cap', () => {
    // days 1 and 5 in CR, 3-day gap between → bridged with default maxGap=14
    expect(pointsToSegments([p(1, 10), p(5, 10)], opts())[0]).toMatchObject({
      startDate: '2025-01-01',
      endDate: '2025-01-05',
      days: 5
    })
    // same points, tiny cap → two separate 1-day runs
    const tight = pointsToSegments([p(1, 10), p(5, 10)], opts({ maxGapDays: 2 }))
    expect(tight).toHaveLength(2)
    expect(tight.map((s) => s.days)).toEqual([1, 1])
  })

  it('resolves each day to its majority country; ties go to the last point', () => {
    const segs = pointsToSegments(
      [
        // day 1: 2×CR + 1×US → majority CR
        p(1, 10, 8),
        p(1, 10, 9),
        p(1, 40, 20),
        // day 2: 1×CR + 1×US, US is later → tie → US
        p(2, 10, 8),
        p(2, 40, 20)
      ],
      opts()
    )
    expect(segs.map((s) => `${s.country}:${s.startDate}`)).toEqual([
      'CR:2025-01-01',
      'US:2025-01-02'
    ])
  })

  it('drops runs shorter than minDaysPerSegment', () => {
    expect(pointsToSegments([p(1, 40)], opts({ minDaysPerSegment: 2 }))).toEqual([])
  })

  it('ignores points that resolve to no country', () => {
    expect(pointsToSegments([p(1, 99), p(2, 99)], opts())).toEqual([])
  })
})

describe('bundled country-boundaries.json', () => {
  it('loads with a sane country count and shape (guards a bad rebuild)', () => {
    const arr = boundaries as Array<{ iso2: string; bbox: number[]; geom: unknown[] }>
    expect(Array.isArray(arr)).toBe(true)
    expect(arr.length).toBeGreaterThan(150)
    for (const c of arr) {
      expect(c.iso2).toMatch(/^[A-Z]{2}$/)
      expect(c.bbox).toHaveLength(4)
      expect(Array.isArray(c.geom)).toBe(true)
    }
  })
})
