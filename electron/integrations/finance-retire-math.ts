/**
 * Core financial math for the retirement engine (Phase 11.4 — ported from
 * retire-early-hub `utils/financialMath.js`): future value, 401k accumulation,
 * §121 condo proceeds, a tax-aware year-by-year drawdown, a fat-tailed seeded
 * Monte Carlo, and safe-withdrawal-rate analysis. Pure functions.
 *
 * The Monte Carlo RNG is SEEDED (`makeRng`) so runs are reproducible — tests pin
 * a seed for exact success-rate assertions, and the optimizer reuses one seed so
 * its lever search is stable.
 */
import type { FilingStatus } from './finance-retire-constants'
import { ltcg0Headroom, rmdDivisor } from './finance-retire-strategy'
import { calcCRTax, calcUSAnnualTax } from './finance-retire-tax'

// ─── Future value ─────────────────────────────────────────────────────────────
export function fv(principal: number, annualRate: number, years: number): number {
  return principal * (1 + annualRate) ** years
}

/** Future value of regular monthly contributions. */
export function fvAnnuity(monthlyContrib: number, annualRate: number, years: number): number {
  const r = annualRate / 12
  const n = years * 12
  if (r === 0) return monthlyContrib * n
  return monthlyContrib * (((1 + r) ** n - 1) / r)
}

export type Project401kResult = {
  balance: number
  totalContributions: number
  growthOnExisting: number
  growthOnContribs: number
}

/** 401k projection: grow an existing balance plus contributions + employer match. */
export function project401k({
  currentBalance,
  annualContrib,
  employerMatch,
  annualReturn,
  years
}: {
  currentBalance: number
  annualContrib: number
  employerMatch: number
  annualReturn: number
  years: number
}): Project401kResult {
  const totalAnnualContrib = annualContrib + employerMatch
  const monthlyContrib = totalAnnualContrib / 12
  const growthOnExisting = fv(currentBalance, annualReturn, years)
  const growthOnContribs = fvAnnuity(monthlyContrib, annualReturn, years)
  return {
    balance: growthOnExisting + growthOnContribs,
    totalContributions: totalAnnualContrib * years,
    growthOnExisting,
    growthOnContribs
  }
}

export type CondoProceedsResult = {
  estimatedValue: number
  purchasePrice: number
  grossGain: number
  exclusionApplied: number
  taxableGain: number
  estimatedTaxOnGain: number
  closingCosts: number
  netProceeds: number
  sec121Eligible: boolean
}

/** Primary-residence §121 exclusion → net sale proceeds. */
export function calcCondoProceeds({
  estimatedValue,
  purchasePrice,
  closingCostsPct = 0.06,
  filingStatus = 'single',
  sec121Eligible = true
}: {
  estimatedValue: number
  purchasePrice: number
  closingCostsPct?: number
  filingStatus?: FilingStatus
  sec121Eligible?: boolean
}): CondoProceedsResult {
  const gain = estimatedValue - purchasePrice
  const exclusionLimit = filingStatus === 'mfj' ? 500_000 : 250_000
  const exclusionApplied = sec121Eligible ? Math.min(gain, exclusionLimit) : 0
  const taxableGain = Math.max(0, gain - exclusionApplied)
  const closingCosts = estimatedValue * closingCostsPct
  const netProceeds = estimatedValue - closingCosts - taxableGain * 0.15 // assume 15% LTCG if any
  return {
    estimatedValue,
    purchasePrice,
    grossGain: gain,
    exclusionApplied,
    taxableGain,
    estimatedTaxOnGain: taxableGain * 0.15,
    closingCosts,
    netProceeds,
    sec121Eligible
  }
}

// ─── Drawdown ─────────────────────────────────────────────────────────────────

export type DrawdownBuckets = {
  taxDeferred?: number
  taxable?: number
  taxableBasis?: number
  roth?: number
}

export type LegacyDrawdownRow = {
  year: number
  age: number
  balance: number
  withdrawal: number
  expenses: number
  ssIncome: number
  depleted: boolean
}

export type TaxAwareDrawdownRow = {
  year: number
  age: number
  balance: number
  realBalance: number
  withdrawal: number
  expenses: number
  realExpenses: number
  ssIncome: number
  freelanceIncome: number
  rentalIncome: number
  healthCost: number
  ltcCost: number
  deferredWithdrawal: number
  taxableWithdrawal: number
  rmd: number
  capitalGains: number
  ordinaryTaxable: number
  ltcg0Headroom: number
  usTax: number
  crTax: number
  netIncome: number
  effectiveRate: number
  taxableBalance: number
  taxDeferredBalance: number
  depleted: boolean
}

export type DrawdownOpts = {
  startBalance: number
  annualExpenses: number
  annualReturn: number
  inflationRate: number
  years?: number
  ssStartAge?: number
  ssMonthly?: number
  currentAge?: number
  additionalIncome?: number
  rentalNetMonthly?: number
  rentalYears?: number
  healthMonthly?: number
  medicalInflationRate?: number | null
  ltcEnabled?: boolean
  ltcMonthly?: number
  ltcStartAge?: number
  ltcYears?: number
  buckets?: DrawdownBuckets | null
  taxAware?: boolean
  filingStatus?: FilingStatus
  usdToCrc?: number
  freelanceYears?: number
  expenseInflationRate?: number | null
  fxDriftPct?: number
  ssColaRate?: number
}

/**
 * Year-by-year retirement drawdown. Two modes:
 *  • Legacy: single balance, withdrawals assumed already net of tax.
 *  • Tax-aware (`taxAware: true` + `buckets`): splits the nest egg into
 *    taxable / tax-deferred / Roth and grosses up each year's withdrawal so the
 *    AFTER-TAX cash covers expenses (US federal tax via calcUSAnnualTax; CR ~0).
 */
export function projectRetirementDrawdown(
  opts: DrawdownOpts & { taxAware: true; buckets: DrawdownBuckets }
): TaxAwareDrawdownRow[]
export function projectRetirementDrawdown(opts: DrawdownOpts): LegacyDrawdownRow[]
export function projectRetirementDrawdown(
  opts: DrawdownOpts
): LegacyDrawdownRow[] | TaxAwareDrawdownRow[] {
  const {
    startBalance,
    annualExpenses,
    annualReturn,
    inflationRate,
    years = 35,
    ssStartAge = 0,
    ssMonthly = 0,
    currentAge = 56,
    additionalIncome = 0,
    rentalNetMonthly = 0,
    rentalYears = 0,
    healthMonthly = 0,
    medicalInflationRate = null,
    ltcEnabled = false,
    ltcMonthly = 0,
    ltcStartAge = 0,
    ltcYears = 0,
    buckets = null,
    taxAware = false,
    filingStatus = 'single',
    usdToCrc = 519,
    freelanceYears = Number.POSITIVE_INFINITY,
    expenseInflationRate = null,
    fxDriftPct = 0,
    ssColaRate = 0
  } = opts

  if (taxAware && buckets) {
    return drawdownTaxAware({
      buckets,
      annualExpenses,
      annualReturn,
      inflationRate,
      years,
      ssStartAge,
      ssMonthly,
      currentAge,
      additionalIncome,
      filingStatus,
      usdToCrc,
      freelanceYears,
      ssColaRate,
      rentalNetMonthly,
      rentalYears,
      healthMonthly,
      medicalInflationRate,
      ltcEnabled,
      ltcMonthly,
      ltcStartAge,
      ltcYears,
      expenseInflationRate: expenseInflationRate != null ? expenseInflationRate : inflationRate,
      fxDriftPct
    })
  }

  const results: LegacyDrawdownRow[] = []
  let balance = startBalance
  let expenses = annualExpenses

  for (let yr = 0; yr < years; yr++) {
    const age = currentAge + yr
    const ssAnnual = age >= ssStartAge && ssStartAge > 0 ? ssMonthly * 12 : 0
    const freelanceAnnual = yr < freelanceYears ? additionalIncome * 12 : 0
    const rentalAnnual = yr < rentalYears ? rentalNetMonthly * 12 : 0
    const netWithdrawal = Math.max(0, expenses - ssAnnual - freelanceAnnual - rentalAnnual)
    const growth = balance * annualReturn
    balance = balance + growth - netWithdrawal
    results.push({
      year: yr + 1,
      age,
      balance: Math.max(0, balance),
      withdrawal: netWithdrawal,
      expenses,
      ssIncome: ssAnnual,
      depleted: balance <= 0
    })
    if (balance <= 0) {
      for (let remaining = yr + 1; remaining < years; remaining++) {
        const rAge = currentAge + remaining
        const rSs = rAge >= ssStartAge && ssStartAge > 0 ? ssMonthly * 12 : 0
        results.push({
          year: remaining + 1,
          age: rAge,
          balance: 0,
          withdrawal: 0,
          expenses,
          ssIncome: rSs,
          depleted: true
        })
      }
      break
    }
    expenses = expenses * (1 + inflationRate)
  }
  return results
}

type TaxAwareOpts = {
  buckets: DrawdownBuckets
  annualExpenses: number
  annualReturn: number
  inflationRate: number
  years: number
  ssStartAge: number
  ssMonthly: number
  currentAge: number
  additionalIncome: number
  filingStatus: FilingStatus
  usdToCrc: number
  freelanceYears: number
  expenseInflationRate: number
  fxDriftPct: number
  ssColaRate?: number
  rentalNetMonthly?: number
  rentalYears?: number
  healthMonthly?: number
  medicalInflationRate?: number | null
  ltcEnabled?: boolean
  ltcMonthly?: number
  ltcStartAge?: number
  ltcYears?: number
}

function drawdownTaxAware({
  buckets,
  annualExpenses,
  annualReturn,
  inflationRate,
  years,
  ssStartAge,
  ssMonthly,
  currentAge,
  additionalIncome,
  filingStatus,
  usdToCrc,
  freelanceYears,
  expenseInflationRate,
  fxDriftPct,
  ssColaRate = 0,
  rentalNetMonthly = 0,
  rentalYears = 0,
  healthMonthly = 0,
  medicalInflationRate = null,
  ltcEnabled = false,
  ltcMonthly = 0,
  ltcStartAge = 0,
  ltcYears = 0
}: TaxAwareOpts): TaxAwareDrawdownRow[] {
  const results: TaxAwareDrawdownRow[] = []
  let taxDeferred = buckets.taxDeferred || 0
  let taxable = buckets.taxable || 0
  let basis = buckets.taxableBasis != null ? buckets.taxableBasis : taxable
  let roth = buckets.roth || 0

  const expenseGrowth = (1 + expenseInflationRate) * (1 + fxDriftPct) - 1
  const medRate = medicalInflationRate != null ? medicalInflationRate : expenseInflationRate
  const medicalGrowth = (1 + medRate) * (1 + fxDriftPct) - 1
  const healthBase = Math.max(0, Math.min(annualExpenses, healthMonthly * 12))
  let nonHealth = annualExpenses - healthBase
  let health = healthBase
  const ltcCurrent = Math.max(0, ltcMonthly * 12)
  let ltcRunning = ltcCurrent

  for (let yr = 0; yr < years; yr++) {
    const age = currentAge + yr
    const inLtc = ltcEnabled && age >= ltcStartAge && age < ltcStartAge + ltcYears
    const ltc = inLtc ? ltcRunning : 0
    const expenses = nonHealth + health + ltc

    taxDeferred *= 1 + annualReturn
    taxable *= 1 + annualReturn
    roth *= 1 + annualReturn
    const gainFraction = taxable > 0 ? Math.min(1, Math.max(0, (taxable - basis) / taxable)) : 0

    const ssAnnual =
      age >= ssStartAge && ssStartAge > 0
        ? ssMonthly * 12 * (1 + ssColaRate) ** Math.max(0, age - ssStartAge)
        : 0
    const freelanceAnnual = yr < freelanceYears ? additionalIncome * 12 : 0
    const rentalAnnual = yr < rentalYears ? rentalNetMonthly * 12 : 0
    const otherIncome = freelanceAnnual + rentalAnnual

    const divisor = rmdDivisor(age)
    const rmd = divisor > 0 ? Math.min(taxDeferred, taxDeferred / divisor) : 0
    const wDeferred = rmd

    let extra = Math.max(0, expenses - ssAnnual - otherIncome - rmd)
    let wTaxable = 0
    let wMoreDeferred = 0
    let wRoth = 0
    let taxInfo = { totalTax: 0, taxableIncome: 0 }
    for (let i = 0; i < 12; i++) {
      const headroomTaxable = taxable
      const headroomDeferred = taxDeferred - wDeferred
      extra = Math.min(extra, headroomTaxable + headroomDeferred + roth)
      wTaxable = Math.min(extra, headroomTaxable)
      let rem = extra - wTaxable
      wMoreDeferred = Math.min(rem, headroomDeferred)
      rem -= wMoreDeferred
      wRoth = Math.min(rem, roth)

      const totalDeferredIter = wDeferred + wMoreDeferred
      const capitalGainsIter = wTaxable * gainFraction
      taxInfo = calcUSAnnualTax({
        ordinaryIncome: freelanceAnnual + totalDeferredIter,
        capitalGains: capitalGainsIter,
        socialSecurity: ssAnnual,
        filingStatus
      })
      const grossWIter = totalDeferredIter + wTaxable + wRoth
      const netCash = ssAnnual + otherIncome + grossWIter - taxInfo.totalTax
      const shortfall = expenses - netCash
      if (Math.abs(shortfall) < 1) break
      extra = Math.max(0, extra + shortfall)
    }

    const totalDeferred = wDeferred + wMoreDeferred
    const capitalGains = wTaxable * gainFraction
    const usTax = taxInfo.totalTax

    taxDeferred -= totalDeferred
    basis = Math.max(0, basis - wTaxable * (1 - gainFraction))
    taxable -= wTaxable
    roth -= wRoth

    const grossW = totalDeferred + wTaxable + wRoth
    const crTax = calcCRTax({ crSourcedIncomeUSD: 0, usdToCrc }).taxUSD
    const netIncome = ssAnnual + otherIncome + grossW - usTax - crTax

    const surplus = netIncome - expenses
    if (surplus > 1) {
      taxable += surplus
      basis += surplus
    }

    const ordinaryTaxable = Math.max(0, taxInfo.taxableIncome - capitalGains)
    const harvestHeadroom = ltcg0Headroom({
      ordinaryTaxableIncome: ordinaryTaxable,
      realizedLTCG: capitalGains,
      filingStatus
    })

    const balance = Math.max(0, taxDeferred + taxable + roth)
    const depleted = balance <= 0 && netIncome < expenses - 1
    const realFactor = (1 + inflationRate) ** yr

    results.push({
      year: yr + 1,
      age,
      balance,
      realBalance: balance / realFactor,
      withdrawal: grossW,
      expenses,
      realExpenses: expenses / realFactor,
      ssIncome: ssAnnual,
      freelanceIncome: freelanceAnnual,
      rentalIncome: rentalAnnual,
      healthCost: health,
      ltcCost: ltc,
      deferredWithdrawal: totalDeferred,
      taxableWithdrawal: wTaxable,
      rmd,
      capitalGains,
      ordinaryTaxable,
      ltcg0Headroom: harvestHeadroom,
      usTax,
      crTax,
      netIncome,
      effectiveRate:
        grossW + otherIncome + ssAnnual > 0
          ? (usTax + crTax) / (grossW + otherIncome + ssAnnual)
          : 0,
      taxableBalance: taxable,
      taxDeferredBalance: taxDeferred,
      depleted
    })

    if (depleted) {
      let fNon = nonHealth
      let fHealth = health
      let fLtc = ltcRunning
      for (let r = yr + 1; r < years; r++) {
        fNon *= 1 + expenseGrowth
        fHealth *= 1 + medicalGrowth
        fLtc *= 1 + medicalGrowth
        const rAge = currentAge + r
        const rInLtc = ltcEnabled && rAge >= ltcStartAge && rAge < ltcStartAge + ltcYears
        const rLtc = rInLtc ? fLtc : 0
        const futureExpenses = fNon + fHealth + rLtc
        const rf = (1 + inflationRate) ** r
        const rSs =
          rAge >= ssStartAge && ssStartAge > 0
            ? ssMonthly * 12 * (1 + ssColaRate) ** Math.max(0, rAge - ssStartAge)
            : 0
        const rFreelance = r < freelanceYears ? additionalIncome * 12 : 0
        const rRental = r < rentalYears ? rentalNetMonthly * 12 : 0
        results.push({
          year: r + 1,
          age: rAge,
          balance: 0,
          realBalance: 0,
          withdrawal: 0,
          expenses: futureExpenses,
          realExpenses: futureExpenses / rf,
          ssIncome: rSs,
          freelanceIncome: rFreelance,
          rentalIncome: rRental,
          healthCost: fHealth,
          ltcCost: rLtc,
          deferredWithdrawal: 0,
          taxableWithdrawal: 0,
          rmd: 0,
          capitalGains: 0,
          ordinaryTaxable: 0,
          ltcg0Headroom: 0,
          usTax: 0,
          crTax: 0,
          netIncome: rSs + rFreelance + rRental,
          effectiveRate: 0,
          taxableBalance: 0,
          taxDeferredBalance: 0,
          depleted: true
        })
      }
      break
    }
    nonHealth *= 1 + expenseGrowth
    health *= 1 + medicalGrowth
    ltcRunning *= 1 + medicalGrowth
  }
  return results
}

// ─── Seedable RNG (mulberry32) ────────────────────────────────────────────────
export type Rng = () => number

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Monte Carlo ──────────────────────────────────────────────────────────────
export type MonteCarloPathPoint = { year: number; age: number; value: number }

export type MonteCarloResult = {
  success: number
  failure: number
  portfolioValues: number[]
  successRate: string
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number }
  downside: { failRate: number; medianFailAge: number | null; earliestFailAge: number | null }
  paths?: {
    p10: MonteCarloPathPoint[]
    p25: MonteCarloPathPoint[]
    p50: MonteCarloPathPoint[]
    p75: MonteCarloPathPoint[]
    p90: MonteCarloPathPoint[]
  }
}

export type MonteCarloOpts = {
  startBalance: number
  annualExpenses: number
  meanReturn?: number
  stdDev?: number
  inflationMean?: number
  inflationStd?: number
  returnInflationCorr?: number
  years?: number
  simulations?: number
  ssStartAge?: number
  ssMonthly?: number
  currentAge?: number
  additionalIncome?: number
  taxDrag?: number[] | null
  freelanceYears?: number
  ssColaRate?: number
  rentalNetMonthly?: number
  rentalYears?: number
  healthMonthly?: number
  medicalInflationRate?: number | null
  ltcEnabled?: boolean
  ltcMonthly?: number
  ltcStartAge?: number
  ltcYears?: number
  fatTails?: boolean
  crisisProb?: number
  crisisPersistence?: number
  crisisReturnShift?: number
  crisisVolMult?: number
  rng?: Rng
  pathsNeeded?: boolean
}

/**
 * Monte Carlo simulation with a mean-preserving 2-state (normal/crisis) regime
 * for fat tails, volatility clustering, and sequence-of-returns risk. Pass a
 * seeded `rng` for reproducibility; skip `pathsNeeded` for success-only runs.
 */
export function runMonteCarlo({
  startBalance,
  annualExpenses,
  meanReturn = 0.072,
  stdDev = 0.15,
  inflationMean = 0.03,
  inflationStd = 0.02,
  returnInflationCorr = -0.3,
  years = 35,
  simulations = 1000,
  ssStartAge = 67,
  ssMonthly = 2000,
  currentAge = 56,
  additionalIncome = 0,
  taxDrag = null,
  freelanceYears = Number.POSITIVE_INFINITY,
  ssColaRate = 0,
  rentalNetMonthly = 0,
  rentalYears = 0,
  healthMonthly = 0,
  medicalInflationRate = null,
  ltcEnabled = false,
  ltcMonthly = 0,
  ltcStartAge = 0,
  ltcYears = 0,
  fatTails = true,
  crisisProb = 0.08,
  crisisPersistence = 0.5,
  crisisReturnShift = 0.18,
  crisisVolMult = 1.7,
  rng = Math.random,
  pathsNeeded = true
}: MonteCarloOpts): MonteCarloResult {
  const dragFor = (yr: number): number => (taxDrag && taxDrag[yr] != null ? taxDrag[yr] : 1)
  const corr = Math.max(-1, Math.min(1, returnInflationCorr))

  const pEnter = fatTails ? Math.max(0, Math.min(1, crisisProb)) : 0
  const pStay = fatTails ? Math.max(0, Math.min(0.999999, crisisPersistence)) : 0
  const denom = 1 - pStay + pEnter
  const piC = fatTails && denom > 0 ? pEnter / denom : 0
  const baseMean = meanReturn + piC * crisisReturnShift
  const shift = fatTails ? crisisReturnShift : 0
  const volMult = fatTails ? crisisVolMult : 1
  const cProb = pEnter
  const cPers = pStay

  const drawYR = (
    inCrisis: boolean
  ): { annualReturn: number; inflation: number; nextCrisis: boolean } => {
    const u1 = Math.max(rng(), 1e-12)
    const u2 = Math.max(rng(), 1e-12)
    const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const z2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2)
    const annualReturn =
      (inCrisis ? baseMean - shift : baseMean) + (inCrisis ? stdDev * volMult : stdDev) * z1
    const inflation = Math.max(
      0,
      inflationMean + inflationStd * (corr * z1 + Math.sqrt(1 - corr * corr) * z2)
    )
    const nextCrisis = rng() < (inCrisis ? cPers : cProb)
    return { annualReturn, inflation, nextCrisis }
  }

  const healthBase = Math.max(0, Math.min(annualExpenses, healthMonthly * 12))
  const medPremium =
    (medicalInflationRate != null ? medicalInflationRate : inflationMean) - inflationMean

  let success = 0
  let failure = 0
  const allFinalBalances: number[] = []
  const failureAges: number[] = []

  for (let sim = 0; sim < simulations; sim++) {
    let balance = startBalance
    let nonHealth = annualExpenses - healthBase
    let health = healthBase
    let ltcCurrent = Math.max(0, ltcMonthly * 12)
    let inCrisis = rng() < piC
    let depleted = false

    for (let yr = 0; yr < years; yr++) {
      const age = currentAge + yr
      const { annualReturn, inflation, nextCrisis } = drawYR(inCrisis)

      const inLtc = ltcEnabled && age >= ltcStartAge && age < ltcStartAge + ltcYears
      const expenses = nonHealth + health + (inLtc ? ltcCurrent : 0)
      const ssAnnual =
        age >= ssStartAge ? ssMonthly * 12 * (1 + ssColaRate) ** Math.max(0, age - ssStartAge) : 0
      const freelanceAnnual = yr < freelanceYears ? additionalIncome * 12 : 0
      const rentalAnnual = yr < rentalYears ? rentalNetMonthly * 12 : 0
      const netNeed = Math.max(0, expenses - ssAnnual - freelanceAnnual - rentalAnnual)
      const netWithdrawal = netNeed * dragFor(yr)
      balance = balance * (1 + annualReturn) - netWithdrawal
      const medInfl = Math.max(0, inflation + medPremium)
      nonHealth *= 1 + inflation
      health *= 1 + medInfl
      ltcCurrent *= 1 + medInfl
      inCrisis = nextCrisis

      if (balance <= 0) {
        depleted = true
        balance = 0
        failureAges.push(age)
        break
      }
    }

    if (depleted) failure++
    else success++
    allFinalBalances.push(balance)
  }

  allFinalBalances.sort((a, b) => a - b)
  failureAges.sort((a, b) => a - b)

  const result: MonteCarloResult = {
    success,
    failure,
    portfolioValues: allFinalBalances,
    successRate: ((success / simulations) * 100).toFixed(1),
    percentiles: {
      p10: allFinalBalances[Math.floor(simulations * 0.1)],
      p25: allFinalBalances[Math.floor(simulations * 0.25)],
      p50: allFinalBalances[Math.floor(simulations * 0.5)],
      p75: allFinalBalances[Math.floor(simulations * 0.75)],
      p90: allFinalBalances[Math.floor(simulations * 0.9)]
    },
    downside: {
      failRate: +((failure / simulations) * 100).toFixed(1),
      medianFailAge: failureAges.length ? failureAges[Math.floor(failureAges.length / 2)] : null,
      earliestFailAge: failureAges.length ? failureAges[0] : null
    }
  }

  if (!pathsNeeded) return result

  const paths: NonNullable<MonteCarloResult['paths']> = {
    p10: [],
    p25: [],
    p50: [],
    p75: [],
    p90: []
  }
  for (let yr = 0; yr <= years; yr++) {
    const simBals: number[] = []
    for (let sim = 0; sim < simulations; sim++) {
      let balance = startBalance
      let nonHealth = annualExpenses - healthBase
      let health = healthBase
      let ltcCurrent = Math.max(0, ltcMonthly * 12)
      let inCrisis = rng() < piC
      for (let y = 0; y < yr; y++) {
        const age = currentAge + y
        const { annualReturn, inflation, nextCrisis } = drawYR(inCrisis)
        const inLtc = ltcEnabled && age >= ltcStartAge && age < ltcStartAge + ltcYears
        const expenses = nonHealth + health + (inLtc ? ltcCurrent : 0)
        const ssAnnual =
          age >= ssStartAge ? ssMonthly * 12 * (1 + ssColaRate) ** Math.max(0, age - ssStartAge) : 0
        const freelanceAnnual = y < freelanceYears ? additionalIncome * 12 : 0
        const rentalAnnual = y < rentalYears ? rentalNetMonthly * 12 : 0
        const netNeed = Math.max(0, expenses - ssAnnual - freelanceAnnual - rentalAnnual)
        const withdrawal = netNeed * dragFor(y)
        balance = Math.max(0, balance * (1 + annualReturn) - withdrawal)
        const medInfl = Math.max(0, inflation + medPremium)
        nonHealth *= 1 + inflation
        health *= 1 + medInfl
        ltcCurrent *= 1 + medInfl
        inCrisis = nextCrisis
      }
      simBals.push(balance)
    }
    simBals.sort((a, b) => a - b)
    const n = simBals.length
    paths.p10.push({ year: yr, age: currentAge + yr, value: simBals[Math.floor(n * 0.1)] })
    paths.p25.push({ year: yr, age: currentAge + yr, value: simBals[Math.floor(n * 0.25)] })
    paths.p50.push({ year: yr, age: currentAge + yr, value: simBals[Math.floor(n * 0.5)] })
    paths.p75.push({ year: yr, age: currentAge + yr, value: simBals[Math.floor(n * 0.75)] })
    paths.p90.push({ year: yr, age: currentAge + yr, value: simBals[Math.floor(n * 0.9)] })
  }
  result.paths = paths

  return result
}

export type SwrResult = {
  swr: string
  safeThreshold: number
  status: 'safe' | 'caution' | 'risky'
  maxSafeWithdrawal: number
}

/**
 * Safe-withdrawal-rate analysis, horizon-aware: the 4% rule is a 30-year result;
 * a ~40-year early-retirement horizon needs a lower safe rate (~3.4%).
 * Source: Kitces (https://www.kitces.com/?s=safe+withdrawal+rate).
 */
export function calcSWR(balance: number, annualExpenses: number, years = 30): SwrResult {
  if (!(balance > 0) || !Number.isFinite(annualExpenses)) {
    return { swr: '—', safeThreshold: 0, status: 'risky', maxSafeWithdrawal: 0 }
  }
  const swr = annualExpenses / balance
  const safe = years >= 40 ? 0.034 : years >= 31 ? 0.037 : 0.04
  const caution = safe + 0.01
  return {
    swr: (swr * 100).toFixed(2),
    safeThreshold: +(safe * 100).toFixed(1),
    status: swr <= safe ? 'safe' : swr <= caution ? 'caution' : 'risky',
    maxSafeWithdrawal: balance * safe
  }
}
