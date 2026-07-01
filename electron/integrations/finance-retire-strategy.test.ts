import { describe, expect, it } from 'vitest'
import {
  calcRothLadder,
  calcSEPP,
  calcSSBreakeven,
  ltcg0Headroom,
  rmdDivisor
} from './finance-retire-strategy'

describe('rmdDivisor', () => {
  it('is zero before age 73', () => {
    expect(rmdDivisor(72)).toBe(0)
    expect(rmdDivisor(56)).toBe(0)
  })
  it('uses the Uniform Lifetime Table at 73+', () => {
    expect(rmdDivisor(73)).toBe(26.5)
    expect(rmdDivisor(80)).toBe(20.2)
  })
})

describe('calcSEPP', () => {
  it('amortization pays more than the RMD method', () => {
    const r = calcSEPP({ balance: 200_000, age: 56, rate: 0.05 })
    expect(r.lifeExpectancy).toBe(30.6)
    expect(r.amortization).toBeGreaterThan(r.rmdMethod)
    expect(r.amortization / 200_000).toBeGreaterThan(0.06)
    expect(r.amortization / 200_000).toBeLessThan(0.07)
  })
  it('RMD method equals balance ÷ single-life divisor', () => {
    const r = calcSEPP({ balance: 100_000, age: 56 })
    expect(r.rmdMethod).toBeCloseTo(100_000 / 30.6, 4)
  })
})

describe('calcSSBreakeven', () => {
  const benefits = { 62: 1_400, 67: 2_100, 70: 2_650 }

  it('claiming later yields a higher lifetime total at age 90', () => {
    const r = calcSSBreakeven({ monthlyByAge: benefits, lifeExpectancy: 90 })
    expect(r.byClaimAge[70].lifetimeTotal).toBeGreaterThan(r.byClaimAge[62].lifetimeTotal)
    expect(r.bestClaimAge).toBe(70)
  })
  it('finds a plausible 67-vs-62 break-even in the late 70s', () => {
    const r = calcSSBreakeven({ monthlyByAge: benefits, lifeExpectancy: 95 })
    expect(r.breakeven['67v62']).toBeGreaterThanOrEqual(76)
    expect(r.breakeven['67v62']).toBeLessThanOrEqual(80)
  })
  it('with a short life expectancy, claiming early wins', () => {
    const r = calcSSBreakeven({ monthlyByAge: benefits, lifeExpectancy: 72 })
    expect(r.bestClaimAge).toBe(62)
  })
})

describe('ltcg0Headroom', () => {
  it('gives the full 0% bracket when there is no other income', () => {
    expect(ltcg0Headroom({ ordinaryTaxableIncome: 0 })).toBe(48_350)
  })
  it('shrinks by ordinary taxable income and already-realized gains', () => {
    expect(ltcg0Headroom({ ordinaryTaxableIncome: 10_000, realizedLTCG: 5_000 })).toBe(33_350)
  })
  it('is zero once the 0% bracket is used up', () => {
    expect(ltcg0Headroom({ ordinaryTaxableIncome: 50_000 })).toBe(0)
  })
})

describe('calcRothLadder', () => {
  const rows = [56, 57, 58].map((age) => ({ age, ordinaryTaxable: 3_000 }))

  it('fills to the bracket ceiling, capped at the 401k balance', () => {
    const r = calcRothLadder({
      rows,
      k401Balance: 30_000,
      fillToTaxableIncome: 48_475,
      startAge: 56,
      endAge: 59,
      growthRate: 0
    })
    expect(r.totalConverted).toBeCloseTo(30_000, 0)
    expect(r.k401Remaining).toBeLessThan(1)
    expect(r.rothBalanceEnd).toBeCloseTo(30_000, 0)
    expect(r.avgRate).toBeGreaterThan(0.09) // ~10–12% marginal
    expect(r.avgRate).toBeLessThan(0.15)
  })

  it('does nothing when the ceiling is at/below baseline income', () => {
    const r = calcRothLadder({
      rows,
      k401Balance: 30_000,
      fillToTaxableIncome: 0,
      startAge: 56,
      endAge: 59,
      growthRate: 0
    })
    expect(r.totalConverted).toBe(0)
    expect(r.totalTax).toBe(0)
  })

  it('seasons each conversion 5 years out', () => {
    const r = calcRothLadder({
      rows,
      k401Balance: 30_000,
      fillToTaxableIncome: 48_475,
      startAge: 56,
      endAge: 59,
      growthRate: 0
    })
    expect(r.ladder[0].accessibleAt).toBe(61)
  })
})
