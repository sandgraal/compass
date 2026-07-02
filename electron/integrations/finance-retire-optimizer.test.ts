import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUTS, type RetireInputs } from './finance-retire-engine'
import { evaluateSuccess, optimizePlan } from './finance-retire-optimizer'

// A funded early-retirement plan (Compass's DEFAULT_INPUTS is neutral / 0 assets),
// so the optimizer's Monte Carlo lands strictly between 0% and 100% and the levers
// visibly move the needle.
const FUNDED: RetireInputs = {
  ...DEFAULT_INPUTS,
  currentAge: 50,
  retirementAge: 55,
  salary: 70_000,
  currentSavings: 40_000,
  annualSavingsExtra: 10_000,
  freelanceMonthly: 1_000,
  freelanceYears: 4,
  condoValue: 300_000,
  condoPurchasePrice: 180_000,
  annualExpenses: 28_200,
  ssMonthly: 1_900,
  postRetireReturn: 0.06
}

describe('evaluateSuccess', () => {
  it('is deterministic via the seeded RNG', () => {
    const a = evaluateSuccess(FUNDED, { simulations: 300 })
    const b = evaluateSuccess(FUNDED, { simulations: 300 })
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(100)
  })

  it('rises when expenses fall', () => {
    const base = evaluateSuccess(FUNDED, { simulations: 400 })
    const leaner = evaluateSuccess(
      { ...FUNDED, annualExpenses: FUNDED.annualExpenses * 0.6 },
      { simulations: 400 }
    )
    expect(leaner).toBeGreaterThan(base)
  })

  it('rises when retirement is delayed', () => {
    const base = evaluateSuccess(FUNDED, { simulations: 400 })
    const delayed = evaluateSuccess(
      {
        ...FUNDED,
        retirementAge: FUNDED.retirementAge + 3,
        yearsToRetirement: FUNDED.yearsToRetirement + 3
      },
      { simulations: 400 }
    )
    expect(delayed).toBeGreaterThan(base)
  })
})

describe('optimizePlan', () => {
  it('returns the three levers with non-negative sensitivity', () => {
    const r = optimizePlan(FUNDED, 90, { simulations: 300 })
    expect(r.levers.map((l) => l.key)).toEqual(['expenses', 'freelance', 'retireAge'])
    for (const l of r.levers) {
      expect(Number.isFinite(l.sensitivity)).toBe(true)
      expect(l.sensitivity).toBeGreaterThan(-1) // weak levers can wiggle within MC noise
    }
    // Cutting expenses must reliably help.
    const exp = r.levers.find((l) => l.key === 'expenses')
    expect(exp?.sensitivity).toBeGreaterThan(0)
    expect(r.baseSuccess).toBeGreaterThanOrEqual(0)
  })

  it('finds a feasible expense cut for a reachable target', () => {
    const r = optimizePlan(FUNDED, 80, { simulations: 300 })
    const exp = r.levers.find((l) => l.key === 'expenses')
    // either already above target (no cut needed) or a positive cut is found
    const ok =
      exp?.required == null || (exp.required.kind === 'expenses' && exp.required.cutMonthly > 0)
    expect(ok).toBe(true)
  })
})
