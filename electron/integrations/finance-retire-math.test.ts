import { describe, expect, it } from 'vitest'
import {
  type DrawdownBuckets,
  type DrawdownOpts,
  calcCondoProceeds,
  calcSWR,
  fv,
  fvAnnuity,
  makeRng,
  project401k,
  projectRetirementDrawdown,
  runMonteCarlo
} from './finance-retire-math'

// A fully-typed tax-aware option bag so the projectRetirementDrawdown overload
// resolves to the richer TaxAwareDrawdownRow[] return.
type TaxAwareOpts = DrawdownOpts & { taxAware: true; buckets: DrawdownBuckets }

describe('fv / fvAnnuity', () => {
  it('compounds a lump sum', () => {
    expect(fv(1000, 0.1, 1)).toBeCloseTo(1100, 6)
    expect(fv(1000, 0.1, 2)).toBeCloseTo(1210, 6)
  })
  it('returns principal at 0% / 0 years', () => {
    expect(fv(5000, 0, 10)).toBe(5000)
    expect(fv(5000, 0.07, 0)).toBe(5000)
  })
  it('sums contributions at 0% rate', () => {
    expect(fvAnnuity(100, 0, 2)).toBe(2400) // 100 * 24 months
  })
  it('grows contributions above their sum when rate > 0', () => {
    expect(fvAnnuity(1000, 0.06, 10)).toBeGreaterThan(1000 * 120)
  })
})

describe('project401k', () => {
  it('splits growth and tallies total contributions', () => {
    const r = project401k({
      currentBalance: 0,
      annualContrib: 31_000,
      employerMatch: 3_400,
      annualReturn: 0.072,
      years: 3
    })
    expect(r.totalContributions).toBe((31_000 + 3_400) * 3)
    expect(r.balance).toBeCloseTo(r.growthOnExisting + r.growthOnContribs, 6)
    expect(r.balance).toBeGreaterThan(r.totalContributions) // growth added
  })
})

describe('calcCondoProceeds — §121', () => {
  it('fully excludes a gain under the single exclusion', () => {
    const r = calcCondoProceeds({
      estimatedValue: 400_000,
      purchasePrice: 180_000,
      filingStatus: 'single'
    })
    expect(r.grossGain).toBe(220_000)
    expect(r.taxableGain).toBe(0) // 220k < 250k exclusion
    expect(r.estimatedTaxOnGain).toBe(0)
    expect(r.closingCosts).toBeCloseTo(24_000, 6) // 6% of 400k
    expect(r.netProceeds).toBeCloseTo(376_000, 6)
  })
  it('taxes the gain above the exclusion at 15%', () => {
    const r = calcCondoProceeds({
      estimatedValue: 600_000,
      purchasePrice: 180_000,
      filingStatus: 'single'
    })
    expect(r.taxableGain).toBe(170_000) // 420k gain - 250k
    expect(r.estimatedTaxOnGain).toBeCloseTo(25_500, 6)
  })
  it('uses the $500k exclusion for MFJ', () => {
    const r = calcCondoProceeds({
      estimatedValue: 600_000,
      purchasePrice: 180_000,
      filingStatus: 'mfj'
    })
    expect(r.taxableGain).toBe(0) // 420k < 500k
  })
})

describe('projectRetirementDrawdown — legacy (tax-free) mode', () => {
  it('inflates expenses year over year', () => {
    const rows = projectRetirementDrawdown({
      startBalance: 1_000_000,
      annualExpenses: 40_000,
      annualReturn: 0.05,
      inflationRate: 0.03,
      years: 5
    })
    expect(rows[0].expenses).toBe(40_000)
    expect(rows[1].expenses).toBeCloseTo(40_000 * 1.03, 6)
  })
  it('flags depletion and back-fills remaining years', () => {
    const rows = projectRetirementDrawdown({
      startBalance: 50_000,
      annualExpenses: 40_000,
      annualReturn: 0.0,
      inflationRate: 0.0,
      years: 10
    })
    expect(rows.length).toBe(10)
    expect(rows[rows.length - 1].depleted).toBe(true)
    expect(rows[rows.length - 1].balance).toBe(0)
  })
  it('offsets withdrawals with Social Security once it starts', () => {
    const rows = projectRetirementDrawdown({
      startBalance: 1_000_000,
      annualExpenses: 40_000,
      annualReturn: 0.05,
      inflationRate: 0,
      years: 15,
      ssStartAge: 67,
      ssMonthly: 2_000,
      currentAge: 60
    })
    const before = rows.find((r) => r.age === 66)
    const after = rows.find((r) => r.age === 67)
    expect(before?.ssIncome).toBe(0)
    expect(after?.ssIncome).toBe(24_000)
    expect(after!.withdrawal).toBeLessThan(before!.withdrawal)
  })
})

describe('projectRetirementDrawdown — tax-aware mode', () => {
  const base: TaxAwareOpts = {
    startBalance: 600_000,
    annualExpenses: 24_000,
    annualReturn: 0.06,
    inflationRate: 0.03,
    years: 30,
    currentAge: 56,
    ssStartAge: 67,
    ssMonthly: 2_100,
    additionalIncome: 1_500,
    freelanceYears: 4,
    buckets: { taxDeferred: 100_000, taxable: 500_000, taxableBasis: 500_000, roth: 0 },
    taxAware: true,
    filingStatus: 'single'
  }

  it('grosses withdrawals up so after-tax cash covers expenses', () => {
    const rows = projectRetirementDrawdown(base)
    const yr0 = rows[0]
    expect(yr0.netIncome).toBeCloseTo(yr0.expenses, 0) // funded to the dollar
    expect(yr0.withdrawal).toBeGreaterThan(yr0.expenses - yr0.ssIncome - yr0.freelanceIncome) // grossed up
    expect(yr0.usTax).toBeGreaterThanOrEqual(0)
  })

  it('never charges CR tax on US-sourced income (territorial)', () => {
    const rows = projectRetirementDrawdown(base)
    for (const r of rows) expect(r.crTax).toBe(0)
  })

  it('phases out freelance income after freelanceYears', () => {
    const rows = projectRetirementDrawdown(base)
    expect(rows[0].freelanceIncome).toBe(18_000)
    expect(rows[5].freelanceIncome).toBe(0) // beyond the 4-year window
  })

  it('enforces an RMD from age 73', () => {
    const rows = projectRetirementDrawdown({
      ...base,
      years: 30,
      buckets: { taxDeferred: 200_000, taxable: 800_000, taxableBasis: 800_000, roth: 0 }
    })
    const at73 = rows.find((r) => r.age === 73)
    expect(at73?.rmd).toBeGreaterThan(0)
    expect(at73!.deferredWithdrawal).toBeGreaterThanOrEqual(at73!.rmd - 1)
    const at72 = rows.find((r) => r.age === 72)
    expect(at72?.rmd).toBe(0)
  })

  it("reports real (today's-dollars) balances below nominal", () => {
    const rows = projectRetirementDrawdown(base)
    expect(rows[10].realBalance).toBeLessThan(rows[10].balance)
    expect(rows[0].realBalance).toBeCloseTo(rows[0].balance, 6) // year 0 factor = 1
  })

  it('exposes 0% LTCG harvesting headroom in low-income years', () => {
    const rows = projectRetirementDrawdown(base)
    expect(rows[0].ltcg0Headroom).toBeGreaterThan(0)
  })

  it('applies CR rental income: offsets withdrawals, reported per row, phases out', () => {
    const withRental = projectRetirementDrawdown({
      ...base,
      rentalNetMonthly: 1_000,
      rentalYears: 5
    })
    const without = projectRetirementDrawdown(base)
    expect(withRental[0].rentalIncome).toBe(12_000)
    expect(withRental[0].withdrawal).toBeLessThan(without[0].withdrawal)
    expect(withRental[5].rentalIncome).toBe(0) // beyond the 5-year window
    // rental net is after-tax spendable cash → the year stays fully funded
    expect(withRental[0].netIncome).toBeGreaterThanOrEqual(withRental[0].expenses - 1)
  })

  it('keeps post-depletion rows consistent (SS still starts, expenses keep inflating)', () => {
    const rows = projectRetirementDrawdown({
      ...base,
      years: 25,
      ssStartAge: 67,
      additionalIncome: 0,
      freelanceYears: 0,
      annualExpenses: 40_000,
      buckets: { taxDeferred: 0, taxable: 50_000, taxableBasis: 50_000, roth: 0 }
    })
    const depletedRows = rows.filter((r) => r.depleted)
    expect(depletedRows.length).toBeGreaterThan(0)
    const at67 = rows.find((r) => r.age === 67)
    expect(at67?.ssIncome).toBeGreaterThan(0)
    expect(at67!.netIncome).toBe(at67!.ssIncome)
    const a = rows.find((r) => r.age === 70)
    const b = rows.find((r) => r.age === 75)
    expect(b!.expenses).toBeGreaterThan(a!.expenses)
    expect(b?.realExpenses).toBeGreaterThan(0)
  })
})

describe('projectRetirementDrawdown — healthcare & long-term care', () => {
  const hbase: TaxAwareOpts = {
    startBalance: 1_500_000,
    annualExpenses: 36_000,
    annualReturn: 0.05,
    inflationRate: 0.03,
    expenseInflationRate: 0.04,
    years: 35,
    currentAge: 56,
    ssStartAge: 67,
    ssMonthly: 2_000,
    buckets: { taxDeferred: 500_000, taxable: 1_000_000, taxableBasis: 1_000_000, roth: 0 },
    taxAware: true,
    filingStatus: 'single'
  }

  it('inflates the health slice faster than the rest (medical > general)', () => {
    const flat = projectRetirementDrawdown(hbase) // healthMonthly 0 → all at general 4%
    const split = projectRetirementDrawdown({
      ...hbase,
      healthMonthly: 1_000,
      medicalInflationRate: 0.08
    })
    expect(split[0].expenses).toBeCloseTo(flat[0].expenses, 0) // year-0 total unchanged (health is a subset)
    expect(split[0].healthCost).toBeCloseTo(12_000, 0) // health slice exposed per row
    const late = 85
    expect(split.find((r) => r.age === late)!.expenses).toBeGreaterThan(
      flat.find((r) => r.age === late)!.expenses
    )
    expect(split.find((r) => r.age === late)!.healthCost).toBeGreaterThan(split[0].healthCost)
  })

  it('adds the LTC cost only within its age window', () => {
    const noLtc = projectRetirementDrawdown({ ...hbase, healthMonthly: 1_000 })
    const ltc = projectRetirementDrawdown({
      ...hbase,
      healthMonthly: 1_000,
      ltcEnabled: true,
      ltcMonthly: 3_000,
      ltcStartAge: 85,
      ltcYears: 3
    })
    expect(ltc.find((r) => r.age === 84)?.ltcCost).toBe(0)
    expect(ltc.find((r) => r.age === 85)?.ltcCost).toBeGreaterThan(0)
    expect(ltc.find((r) => r.age === 88)?.ltcCost).toBe(0) // window is 85,86,87
    expect(ltc.find((r) => r.age === 85)!.expenses).toBeGreaterThan(
      noLtc.find((r) => r.age === 85)!.expenses
    )
    // healthCost is the non-LTC slice only — identical with/without LTC (no double-count).
    expect(ltc.find((r) => r.age === 85)!.healthCost).toBeCloseTo(
      noLtc.find((r) => r.age === 85)!.healthCost,
      0
    )
  })

  it('with no health slice, matches a single-rate projection exactly', () => {
    const a = projectRetirementDrawdown(hbase)
    const b = projectRetirementDrawdown({
      ...hbase,
      healthMonthly: 0,
      medicalInflationRate: 0.08,
      ltcEnabled: false
    })
    expect(a.map((r) => Math.round(r.expenses))).toEqual(b.map((r) => Math.round(r.expenses)))
  })
})

describe('calcSWR', () => {
  it('classifies 4% as safe over a 30-yr horizon', () => {
    const r = calcSWR(1_000_000, 40_000, 30)
    expect(r.swr).toBe('4.00')
    expect(r.status).toBe('safe')
    expect(r.maxSafeWithdrawal).toBe(40_000)
  })
  it('classifies 5.5% as risky', () => {
    expect(calcSWR(1_000_000, 55_000, 30).status).toBe('risky')
  })
  it('is stricter over a long (40-yr) horizon — 4% is no longer "safe"', () => {
    expect(calcSWR(1_000_000, 40_000, 40).status).not.toBe('safe')
    expect(calcSWR(1_000_000, 33_000, 40).status).toBe('safe') // ~3.3%
  })
  it('never classifies a non-positive/insolvent balance as safe', () => {
    expect(calcSWR(-5_000, 40_000).status).toBe('risky')
    expect(calcSWR(0, 40_000).status).toBe('risky')
    expect(calcSWR(0, 40_000).swr).toBe('—')
  })
})

describe('runMonteCarlo', () => {
  const base: Parameters<typeof runMonteCarlo>[0] = {
    startBalance: 800_000,
    annualExpenses: 24_000,
    years: 30,
    simulations: 400,
    ssStartAge: 67,
    ssMonthly: 2_000,
    currentAge: 56
  }
  it('is reproducible with a seeded RNG', () => {
    const a = runMonteCarlo({ ...base, rng: makeRng(42), pathsNeeded: false })
    const b = runMonteCarlo({ ...base, rng: makeRng(42), pathsNeeded: false })
    expect(a.successRate).toBe(b.successRate)
    expect(Number.parseFloat(a.successRate)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(a.successRate)).toBeLessThanOrEqual(100)
  })
  it('never produces NaN even when the seed yields a 0 uniform', () => {
    const r = runMonteCarlo({ ...base, rng: makeRng(0) })
    expect(Number.isFinite(Number.parseFloat(r.successRate))).toBe(true)
    expect(r.percentiles.p50).not.toBeNaN()
    expect(r.paths?.p50.every((pt) => Number.isFinite(pt.value))).toBe(true)
  })
  it('a richer plan succeeds more often than a leaner one', () => {
    const rich = Number.parseFloat(
      runMonteCarlo({ ...base, startBalance: 2_000_000, rng: makeRng(7), pathsNeeded: false })
        .successRate
    )
    const poor = Number.parseFloat(
      runMonteCarlo({ ...base, startBalance: 300_000, rng: makeRng(7), pathsNeeded: false })
        .successRate
    )
    expect(rich).toBeGreaterThan(poor)
  })

  it('fat-tailed regime is no more optimistic than the plain normal model', () => {
    const tight = { ...base, startBalance: 600_000, annualExpenses: 30_000 }
    const fat = Number.parseFloat(
      runMonteCarlo({ ...tight, fatTails: true, rng: makeRng(11), pathsNeeded: false }).successRate
    )
    const normal = Number.parseFloat(
      runMonteCarlo({ ...tight, fatTails: false, rng: makeRng(11), pathsNeeded: false }).successRate
    )
    expect(fat).toBeLessThanOrEqual(normal)
  })

  it('reports a downside (failure-age) metric', () => {
    const r = runMonteCarlo({
      ...base,
      startBalance: 400_000,
      annualExpenses: 30_000,
      rng: makeRng(3),
      pathsNeeded: false
    })
    expect(r.downside).toBeTruthy()
    expect(r.downside.failRate).toBeGreaterThanOrEqual(0)
    if (r.failure > 0) {
      expect(r.downside.medianFailAge).toBeGreaterThan(base.currentAge ?? 0)
      expect(r.downside.earliestFailAge!).toBeLessThanOrEqual(r.downside.medianFailAge!)
    }
  })

  it('does not NaN with an out-of-range correlation', () => {
    const r = runMonteCarlo({
      ...base,
      returnInflationCorr: -5,
      rng: makeRng(1),
      pathsNeeded: false
    })
    expect(Number.isFinite(Number.parseFloat(r.successRate))).toBe(true)
  })
})

describe('runMonteCarlo — CR rental income', () => {
  const base: Parameters<typeof runMonteCarlo>[0] = {
    startBalance: 600_000,
    annualExpenses: 36_000,
    years: 30,
    simulations: 400,
    ssStartAge: 67,
    ssMonthly: 2_000,
    currentAge: 56
  }
  it('rental income never lowers the success rate (and helps a tight plan)', () => {
    const noRent = Number.parseFloat(
      runMonteCarlo({ ...base, rng: makeRng(5), pathsNeeded: false }).successRate
    )
    const withRent = Number.parseFloat(
      runMonteCarlo({
        ...base,
        rentalNetMonthly: 800,
        rentalYears: 20,
        rng: makeRng(5),
        pathsNeeded: false
      }).successRate
    )
    expect(withRent).toBeGreaterThanOrEqual(noRent)
  })
  it('is reproducible with rental income and a seeded RNG', () => {
    const opts = { ...base, rentalNetMonthly: 800, rentalYears: 20, pathsNeeded: false }
    const a = runMonteCarlo({ ...opts, rng: makeRng(9) }).successRate
    const b = runMonteCarlo({ ...opts, rng: makeRng(9) }).successRate
    expect(a).toBe(b)
  })

  it('a long-term-care shock never raises the success rate', () => {
    const b: Parameters<typeof runMonteCarlo>[0] = {
      startBalance: 700_000,
      annualExpenses: 40_000,
      years: 35,
      simulations: 400,
      ssStartAge: 67,
      ssMonthly: 2_000,
      currentAge: 56,
      healthMonthly: 1_200
    }
    const noLtc = Number.parseFloat(
      runMonteCarlo({ ...b, rng: makeRng(4), pathsNeeded: false }).successRate
    )
    const withLtc = Number.parseFloat(
      runMonteCarlo({
        ...b,
        ltcEnabled: true,
        ltcMonthly: 3_500,
        ltcStartAge: 82,
        ltcYears: 5,
        rng: makeRng(4),
        pathsNeeded: false
      }).successRate
    )
    expect(withLtc).toBeLessThanOrEqual(noLtc)
  })

  it('faster medical inflation never raises the success rate', () => {
    const b: Parameters<typeof runMonteCarlo>[0] = {
      startBalance: 700_000,
      annualExpenses: 40_000,
      years: 35,
      simulations: 400,
      ssStartAge: 67,
      ssMonthly: 2_000,
      currentAge: 56,
      healthMonthly: 1_500
    }
    const lo = Number.parseFloat(
      runMonteCarlo({ ...b, medicalInflationRate: 0.04, rng: makeRng(6), pathsNeeded: false })
        .successRate
    )
    const hi = Number.parseFloat(
      runMonteCarlo({ ...b, medicalInflationRate: 0.09, rng: makeRng(6), pathsNeeded: false })
        .successRate
    )
    expect(hi).toBeLessThanOrEqual(lo)
  })
})
