import { describe, expect, it } from 'vitest'
import {
  type Comp,
  compStats,
  parseAirbnbUrl,
  percentile,
  propertyTotals,
  revenueProjection,
  seasonalOccCurve,
  seasonalRateCurve,
  suggestNightly,
  unitEconomics
} from './finance-rental-pricing'

describe('percentile', () => {
  it('interpolates and handles edges', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 6)
    expect(percentile([10, 20, 30, 40], 0)).toBe(10)
    expect(percentile([10, 20, 30, 40], 1)).toBe(40)
    expect(percentile([42], 0.5)).toBe(42)
    expect(percentile([], 0.5)).toBeNull()
  })
})

describe('compStats', () => {
  it('summarizes nightly rates and per-bedroom median', () => {
    const comps: Comp[] = [
      { nightlyUSD: 50, bedrooms: 1 },
      { nightlyUSD: 100, bedrooms: 2 },
      { nightlyUSD: 150, bedrooms: 3 }
    ]
    const s = compStats(comps)
    expect(s.count).toBe(3)
    expect(s.min).toBe(50)
    expect(s.max).toBe(150)
    expect(s.p50).toBeCloseTo(100, 6)
    expect(s.perBedroomP50).toBeCloseTo(50, 6) // all are $50/BR
  })
  it('ignores zero/blank rates and never throws on empty', () => {
    const s = compStats([{ nightlyUSD: '' }, { nightlyUSD: 0 }])
    expect(s.count).toBe(0)
    expect(s.p50).toBeNull()
  })
})

describe('suggestNightly', () => {
  const comps: Comp[] = [
    { nightlyUSD: 48, bedrooms: 1 },
    { nightlyUSD: 60, bedrooms: 1 },
    { nightlyUSD: 95, bedrooms: 2 },
    { nightlyUSD: 110, bedrooms: 2 }
  ]
  it('scales toward a larger listing via per-bedroom pricing', () => {
    const r2 = suggestNightly(comps, { bedrooms: 2 })
    const r1 = suggestNightly(comps, { bedrooms: 1 })
    expect(r2.suggested).toBeGreaterThan(r1.suggested ?? 0)
    expect(r2.low ?? 0).toBeLessThanOrEqual(r2.suggested ?? 0)
    expect(r2.high ?? 0).toBeGreaterThanOrEqual(r2.suggested ?? 0)
  })
  it('premium positioning raises the price above market match', () => {
    const market = suggestNightly(comps, { bedrooms: 2, positioning: 0 }).suggested ?? 0
    const premium = suggestNightly(comps, { bedrooms: 2, positioning: 1 }).suggested ?? 0
    expect(premium).toBeGreaterThan(market)
  })
  it('returns a no-comps basis when there is nothing to price from', () => {
    const r = suggestNightly([], { bedrooms: 2 })
    expect(r.suggested).toBeNull()
    expect(r.basis).toBe('no-comps')
  })
})

describe('seasonal curves', () => {
  it('rate curve averages to 1 and peaks in dry season', () => {
    const c = seasonalRateCurve()
    const mean = c.reduce((a, b) => a + b, 0) / 12
    expect(mean).toBeCloseTo(1, 6)
    // January (dry, index 0) should beat September (wettest, index 8)
    expect(c[0]).toBeGreaterThan(c[8])
  })
  it('occupancy curve is damped relative to the rate curve but same direction', () => {
    const rate = seasonalRateCurve()
    const occ = seasonalOccCurve()
    expect(occ.reduce((a, b) => a + b, 0) / 12).toBeCloseTo(1, 6)
    // Damped: Jan occupancy lift is smaller than Jan rate lift.
    expect(occ[0] - 1).toBeLessThan(rate[0] - 1)
    expect(occ[0]).toBeGreaterThan(1) // still above average in peak season
  })
})

describe('revenueProjection', () => {
  const base = { nightly: 80, occupancy: 0.6, avgStayNights: 4 }

  it('produces 12 months and a positive, internally-consistent annual roll-up', () => {
    const r = revenueProjection(base)
    expect(r.months).toHaveLength(12)
    expect(r.annual.grossRoom).toBeGreaterThan(0)
    expect(r.annual.netAfterTax).toBeLessThan(r.annual.grossTotal) // costs + tax reduce gross
    expect(r.annual.netAfterTax).toBeGreaterThan(0)
    // realized occupancy should land near the input (seasonality ~mean-preserving)
    expect(r.annual.occupancyRealized).toBeCloseTo(0.6, 1)
  })

  it('charges CR rental tax (≈12.75% of gross at default 15% rate / 15% deemed deduction)', () => {
    const r = revenueProjection(base)
    expect(r.effectiveTaxRate).toBeGreaterThan(0.1)
    expect(r.effectiveTaxRate).toBeLessThan(0.15)
  })

  it('higher occupancy yields more net income', () => {
    const lo = revenueProjection({ ...base, occupancy: 0.4 }).annual.netAfterTax
    const hi = revenueProjection({ ...base, occupancy: 0.8 }).annual.netAfterTax
    expect(hi).toBeGreaterThan(lo)
  })

  it('a management fee reduces net', () => {
    const without = revenueProjection(base).annual.netAfterTax
    const withMgmt = revenueProjection({ ...base, mgmtFeePct: 0.2 }).annual.netAfterTax
    expect(withMgmt).toBeLessThan(without)
  })

  it('never returns NaN for degenerate inputs', () => {
    const r = revenueProjection({ nightly: 0, occupancy: 0 })
    expect(Number.isFinite(r.annual.netAfterTax)).toBe(true)
    expect(r.effectiveTaxRate).toBe(0)
  })
})

describe('unitEconomics / propertyTotals (multi-unit)', () => {
  const u1 = { id: 'a', name: 'Cabin 1', bedrooms: 2, occupancy: 0.5, nightlyOverride: 90 }
  const u2 = { id: 'b', name: 'Cabin 2', bedrooms: 1, occupancy: 0.4, nightlyOverride: 60 }

  it('computes per-unit net consistently with revenueProjection', () => {
    const e = unitEconomics(u1, [])
    expect(e.nightly).toBe(90) // override wins
    expect(e.monthlyNet).toBeCloseTo(e.proj.monthlyNet, 6)
    expect(e.annualNet).toBeCloseTo(e.proj.annual.netAfterTax, 6)
    expect(e.monthlyNet).toBeGreaterThan(0)
  })

  it('property total is the exact sum of its units', () => {
    const t = propertyTotals([u1, u2], [])
    const e1 = unitEconomics(u1, [])
    const e2 = unitEconomics(u2, [])
    expect(t.per).toHaveLength(2)
    expect(t.monthlyNet).toBeCloseTo(e1.monthlyNet + e2.monthlyNet, 6)
    expect(t.annualNet).toBeCloseTo(e1.annualNet + e2.annualNet, 6)
    // a second cabin strictly increases the property's net
    expect(t.monthlyNet).toBeGreaterThan(propertyTotals([u1], []).monthlyNet)
  })

  it('handles an empty property without throwing', () => {
    const t = propertyTotals([], [])
    expect(t.monthlyNet).toBe(0)
    expect(t.per).toEqual([])
  })
})

describe('parseAirbnbUrl', () => {
  it('extracts the room id from common URL shapes', () => {
    expect(parseAirbnbUrl('https://www.airbnb.com/rooms/12345678?check_in=2027-01').roomId).toBe(
      '12345678'
    )
    expect(parseAirbnbUrl('https://airbnb.com/rooms/plus/987654').roomId).toBe('987654')
    expect(parseAirbnbUrl('airbnb.co.cr/rooms/555000').cleanUrl).toBe(
      'https://www.airbnb.com/rooms/555000'
    )
  })
  it('flags non-airbnb input as invalid but does not throw', () => {
    expect(parseAirbnbUrl('').valid).toBe(false)
    expect(parseAirbnbUrl('just some notes').valid).toBe(false)
    expect(parseAirbnbUrl('https://example.com/123456')).toEqual({
      valid: false,
      roomId: null,
      cleanUrl: 'https://example.com/123456'
    })
  })
})
