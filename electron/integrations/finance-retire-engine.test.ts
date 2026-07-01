import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INPUTS,
  type RetireInputs,
  type RetirementPlan,
  computePlan
} from './finance-retire-engine'
import { fvAnnuity } from './finance-retire-math'

// Compass's DEFAULT_INPUTS is neutral (0 assets) — the drawdown-dynamics tests
// need a FUNDED plan to exercise. This mirrors the standalone app's example
// early-retirement profile (retire at 55 with real assets).
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

describe('computePlan — structure & determinism', () => {
  it('startBalance equals the sum of the account buckets', () => {
    const p = computePlan(FUNDED)
    expect(p.startBalance).toBeCloseTo(p.buckets.taxDeferred + p.buckets.taxable, 6)
    expect(p.buckets.taxDeferred).toBeCloseTo(p.k401.balance, 6)
  })

  it('is deterministic — same inputs yield identical results (no drift)', () => {
    const a = computePlan(FUNDED)
    const b = computePlan(FUNDED)
    expect(a.startBalance).toBe(b.startBalance)
    expect(a.projection[0].balance).toBe(b.projection[0].balance)
    expect(a.projection.at(-1)?.balance).toBe(b.projection.at(-1)?.balance)
  })
})

describe('computePlan — CR rental income stream', () => {
  const withRental: RetireInputs = { ...FUNDED, rentalNetMonthly: 1500, rentalYears: 15 }

  it('flows rental net income into the projection only while includeRental is on', () => {
    const on = computePlan({ ...withRental, includeRental: true })
    const off = computePlan({ ...withRental, includeRental: false })
    expect(on.projection[0].rentalIncome).toBe(18_000) // 1500 * 12
    expect(off.projection[0].rentalIncome || 0).toBe(0)
  })

  it('reduces early withdrawals when rental income is present', () => {
    const on = computePlan({ ...withRental, includeRental: true })
    const off = computePlan({ ...withRental, includeRental: false })
    expect(on.projection[0].withdrawal).toBeLessThan(off.projection[0].withdrawal)
  })

  it('stops rental income after rentalYears', () => {
    const on = computePlan({ ...withRental, includeRental: true, rentalYears: 10 })
    const retAge = on.inputs.retirementAge
    const lastYear = on.projection.find((r) => r.age === retAge + 9) // yr 9, still on
    const afterEnd = on.projection.find((r) => r.age === retAge + 10) // yr 10, off
    expect(lastYear?.rentalIncome).toBe(18_000)
    expect(afterEnd?.rentalIncome).toBe(0)
  })
})

describe('computePlan — healthcare', () => {
  it('exposes a healthCost line that grows over time at the medical rate', () => {
    const p = computePlan({
      ...FUNDED,
      cajaMonthly: 200,
      privateMonthly: 250,
      medicalInflationRate: 0.07
    })
    const early = p.projection[0].healthCost
    const late = p.projection.find((r) => r.age === 80)?.healthCost
    expect(early).toBeCloseTo((200 + 250) * 12, 0)
    expect(late).toBeGreaterThan(early) // medical inflation compounds the health slice
  })

  it('LTC stress raises late-life expenses and is reported per row', () => {
    const off = computePlan({ ...FUNDED, ltcEnabled: false })
    const on = computePlan({
      ...FUNDED,
      ltcEnabled: true,
      ltcMonthly: 3_000,
      ltcStartAge: 85,
      ltcYears: 5
    })
    const offAt86 = off.projection.find((r) => r.age === 86)
    const onAt86 = on.projection.find((r) => r.age === 86)
    expect(onAt86?.ltcCost).toBeGreaterThan(0)
    expect(offAt86?.ltcCost || 0).toBe(0)
    expect(onAt86!.expenses).toBeGreaterThan(offAt86!.expenses)
  })

  it('treats the health line as a subset of expenses (year-0 total unchanged)', () => {
    const lo = computePlan({ ...FUNDED, cajaMonthly: 100, privateMonthly: 100 })
    const hi = computePlan({ ...FUNDED, cajaMonthly: 300, privateMonthly: 300 })
    expect(lo.projection[0].expenses).toBeCloseTo(hi.projection[0].expenses, 0)
    expect(hi.projection[0].healthCost).toBeGreaterThan(lo.projection[0].healthCost)
  })
})

describe('computePlan — nest-egg accounting', () => {
  it('counts extra annual savings in the nest egg', () => {
    const withExtra = computePlan({ ...FUNDED, annualSavingsExtra: 12_000 })
    const without = computePlan({ ...FUNDED, annualSavingsExtra: 0 })
    expect(withExtra.startBalance).toBeGreaterThan(without.startBalance)
    // extra savings use a proper FV annuity, consistent with the 401k stream
    expect(withExtra.extraSavings).toBeCloseTo(
      fvAnnuity(12_000 / 12, FUNDED.meanReturn, withExtra.inputs.yearsToRetirement),
      6
    )
  })

  it('every consumer sees the same number for the same inputs', () => {
    const inputs = { ...FUNDED, meanReturn: 0.07, annualExpenses: 30_000 }
    const a = computePlan(inputs)
    const b = computePlan(inputs)
    expect(b.startBalance).toBe(a.startBalance)
    expect(b.swr.swr).toBe(a.swr.swr)
  })
})

describe('computePlan — tax-aware projection', () => {
  it('funds early years to (net) expenses via gross-up', () => {
    const p = computePlan(FUNDED)
    const funded = p.projection.find((r) => !r.depleted && r.withdrawal > 0)
    expect(Math.abs(funded!.netIncome - funded!.expenses)).toBeLessThan(5)
  })

  it('charges no CR tax across the whole projection', () => {
    const p = computePlan(FUNDED)
    for (const r of p.projection) expect(r.crTax).toBe(0)
  })

  it('produces a tax-drag schedule of ratios ≥ 1', () => {
    const p = computePlan(FUNDED)
    expect(p.taxDrag.length).toBe(p.projection.length)
    for (const d of p.taxDrag) expect(d).toBeGreaterThanOrEqual(1)
  })

  it('tolerates partial inputs by merging defaults', () => {
    const p = computePlan({ annualExpenses: 18_000 })
    expect(p.inputs.postRetireReturn).toBe(DEFAULT_INPUTS.postRetireReturn)
    expect(Number.isFinite(p.startBalance)).toBe(true)
  })

  it('computes a 55→59½ bridge from the taxable bucket', () => {
    const p = computePlan(FUNDED)
    expect(p.bridge).toBeTruthy()
    expect(typeof p.bridge.fundedFromTaxable).toBe('boolean')
    expect(p.bridge.taxableAtRetirement).toBeGreaterThan(0)
    expect(p.bridge.accessAge).toBe(59.5)
  })

  it("projection carries today's-dollars + 0% LTCG headroom", () => {
    const p = computePlan(FUNDED)
    expect(p.projection[0].realBalance).toBeGreaterThan(0)
    expect(p.projection[0]).toHaveProperty('ltcg0Headroom')
  })
})

describe('computePlan — input sanitization (no garbage in → garbage out)', () => {
  const finite = (p: RetirementPlan): void => {
    expect(Number.isFinite(p.startBalance)).toBe(true)
    expect(p.projection.every((r) => Number.isFinite(r.balance))).toBe(true)
  }

  it('blank/empty fields fall back to defaults, never to 0', () => {
    const p = computePlan({ ...FUNDED, annualExpenses: '', salary: '', currentSavings: '' })
    finite(p)
    expect(p.inputs.annualExpenses).toBe(DEFAULT_INPUTS.annualExpenses) // not 0
    // a blanked-expenses plan must NOT read as a free 0% withdrawal rate
    expect(p.swr.swr).not.toBe('0.00')
  })

  it('clamps negative and non-numeric inputs (no NaN)', () => {
    const p = computePlan({ ...FUNDED, stdDev: -0.5, annualExpenses: -1000, meanReturn: 'abc' })
    finite(p)
    expect(p.inputs.annualExpenses).toBeGreaterThanOrEqual(0)
  })

  it('never lets the horizon invert (planToAge ≤ retirementAge)', () => {
    const p = computePlan({ ...FUNDED, retirementAge: 60, planToAge: 50 })
    finite(p) // no NaN / negative-year collapse
    expect(p.inputs.planToAge).toBeGreaterThan(p.inputs.retirementAge)
    expect(p.projection.length).toBeGreaterThanOrEqual(1)
  })
})

describe('computePlan — age & residence inputs', () => {
  it('derives years-out from the synced currentAge', () => {
    const p = computePlan({ ...FUNDED, currentAge: 40, retirementAge: 56 })
    expect(p.inputs.currentAge).toBe(40)
    expect(p.inputs.yearsToRetirement).toBe(16)
  })

  it('keeps retirementAge and yearsToRetirement consistent', () => {
    const p = computePlan({ ...FUNDED, retirementAge: 60 })
    expect(p.inputs.yearsToRetirement).toBe(60 - FUNDED.currentAge)
  })

  it('carries the residence/§121 year fields and rounds/falls back cleanly', () => {
    expect(DEFAULT_INPUTS).toHaveProperty('primaryResidenceSince')
    expect(DEFAULT_INPUTS).toHaveProperty('condoSaleYear')
    const p = computePlan({ ...FUNDED, primaryResidenceSince: '2015.7', condoSaleYear: '' })
    expect(p.inputs.primaryResidenceSince).toBe(2016) // rounded to a whole year
    expect(p.inputs.condoSaleYear).toBe(DEFAULT_INPUTS.condoSaleYear) // blank → default, never NaN
  })

  it('clamps a wild currentAge to 74 and pins retirementAge to its 75 ceiling', () => {
    const p = computePlan({ ...FUNDED, currentAge: 999, retirementAge: 50 })
    expect(p.inputs.currentAge).toBe(74) // clamped to the 18–74 cap
    expect(p.inputs.retirementAge).toBe(75) // clamp(50, currentAge+1=75, 75) → 75
    expect(p.inputs.yearsToRetirement).toBe(1) // 75 − 74, still consistent
  })
})
