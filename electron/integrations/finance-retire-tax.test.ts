import { describe, expect, it } from 'vitest'
import {
  calcCRTax,
  calcFederalTax,
  calcUSAnnualTax,
  check121Eligibility,
  socialSecurityTaxable
} from './finance-retire-tax'

describe('socialSecurityTaxable (§86 provisional-income tiers)', () => {
  it('is $0 when provisional income is below the base', () => {
    // $20k SS, no other income → provisional = $10k < $25k → 0 taxable
    expect(socialSecurityTaxable(20_000, 0, 'single')).toBe(0)
  })
  it('caps at 85% for high other income', () => {
    expect(socialSecurityTaxable(24_000, 100_000, 'single')).toBeCloseTo(0.85 * 24_000, 0)
  })
  it('uses the 50% tier between the two thresholds', () => {
    // $24k SS + $18k other → provisional = $30k (between $25k and $34k single)
    const t = socialSecurityTaxable(24_000, 18_000, 'single')
    expect(t).toBeCloseTo(Math.min(0.5 * 24_000, 0.5 * (30_000 - 25_000)), 0) // = $2,500
    expect(t).toBeLessThan(0.85 * 24_000) // NOT the flat-85% the old code used
  })
})

describe('calcFederalTax', () => {
  it('is zero on no income', () => {
    expect(calcFederalTax(0).tax).toBe(0)
  })
  it('matches a hand-computed bracket walk (single, $50k taxable)', () => {
    const expected = 11_925 * 0.1 + (48_475 - 11_925) * 0.12 + (50_000 - 48_475) * 0.22
    const r = calcFederalTax(50_000, 'single')
    expect(r.tax).toBeCloseTo(expected, 4)
    expect(r.effectiveRate).toBeCloseTo(expected / 50_000, 6)
  })
})

describe('calcUSAnnualTax', () => {
  it('keeps LTCG in the 0% bracket when total income is low', () => {
    const r = calcUSAnnualTax({
      ordinaryIncome: 18_000,
      capitalGains: 8_000,
      filingStatus: 'single'
    })
    // taxableOrdinary = (18k+8k-15.75k stdded) - 8k cg = 2.25k ordinary → 225 tax; CG in 0% bracket
    expect(r.ordinaryTax).toBeCloseTo(225, 4)
    expect(r.ltcgTax).toBe(0)
    expect(r.niitTax).toBe(0)
    expect(r.totalTax).toBeCloseTo(225, 4)
  })
  it('stacks LTCG above ordinary income into the 15% bracket', () => {
    const r = calcUSAnnualTax({
      ordinaryIncome: 60_000,
      capitalGains: 20_000,
      filingStatus: 'single'
    })
    // taxableOrdinary = 60k + 20k - 15.75k stdded - 20k cg = 44,250
    const expectedLtcg = (20_000 - (48_350 - 44_250)) * 0.15
    expect(r.ltcgTax).toBeCloseTo(expectedLtcg, 2)
  })
  it('applies 3.8% NIIT above the single threshold', () => {
    const r = calcUSAnnualTax({
      ordinaryIncome: 250_000,
      capitalGains: 50_000,
      filingStatus: 'single'
    })
    // agi 300k, niitBase 100k, min(cap gains, base) * 3.8%
    expect(r.niitTax).toBeCloseTo(50_000 * 0.038, 4)
  })
})

describe('check121Eligibility', () => {
  it('qualifies after 2+ years owned', () => {
    const r = check121Eligibility({
      primaryResidenceSince: 2015,
      salePlannedYear: 2025,
      filingStatus: 'single'
    })
    expect(r.eligible).toBe(true)
    expect(r.exclusionAmount).toBe(250_000)
  })
  it('fails the 2-of-5 rule under 2 years', () => {
    const r = check121Eligibility({ primaryResidenceSince: 2027, salePlannedYear: 2028 })
    expect(r.eligible).toBe(false)
    expect(r.exclusionAmount).toBe(0)
  })
  it('USE test: still eligible if sold within 3 years of moving out', () => {
    const r = check121Eligibility({
      primaryResidenceSince: 2018,
      salePlannedYear: 2031,
      moveOutYear: 2029
    })
    expect(r.eligible).toBe(true)
    expect(r.sellByYear).toBe(2032)
  })
  it('USE test: loses the exclusion if sold too long after moving out', () => {
    const r = check121Eligibility({
      primaryResidenceSince: 2018,
      salePlannedYear: 2034,
      moveOutYear: 2029
    })
    expect(r.eligible).toBe(false)
    expect(r.useEligible).toBe(false)
    expect(r.exclusionAmount).toBe(0)
  })
  it('no deadline when selling BEFORE moving out (still resident at sale)', () => {
    const r = check121Eligibility({
      primaryResidenceSince: 2018,
      salePlannedYear: 2028,
      moveOutYear: 2029
    })
    expect(r.eligible).toBe(true)
    expect(r.sellByYear).toBeNull()
    expect(r.note).not.toMatch(/Deadline/)
  })
})

describe('calcCRTax — territorial', () => {
  it('is zero on US-sourced income', () => {
    expect(calcCRTax({ crSourcedIncomeUSD: 0 }).taxUSD).toBe(0)
  })
  it('is zero on CR income below the first bracket', () => {
    expect(calcCRTax({ crSourcedIncomeUSD: 5_000, usdToCrc: 519 }).taxUSD).toBe(0) // < ~$8.2k
  })
  it('taxes CR-sourced income above the first bracket', () => {
    expect(calcCRTax({ crSourcedIncomeUSD: 30_000, usdToCrc: 519 }).taxUSD).toBeGreaterThan(0)
  })
  it('uses taxableUSD in the breakdown entries', () => {
    const result = calcCRTax({ crSourcedIncomeUSD: 30_000, usdToCrc: 519 })
    expect(result.breakdown[0]).toHaveProperty('taxableUSD')
    expect(result.breakdown[0]).not.toHaveProperty('taxablUSD')
  })
})
