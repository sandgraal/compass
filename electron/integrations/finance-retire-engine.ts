/**
 * planEngine — the single source of truth for the retirement model (Phase 11.4 —
 * ported from retire-early-hub `utils/planEngine.js`).
 *
 * `computePlan(inputs)` is pure so every consumer (projection view, Monte Carlo,
 * scenarios, optimizer) shares identical numbers. All personal seed values that
 * the standalone app loaded from a gitignored file are DROPPED — `DEFAULT_INPUTS`
 * carries only neutral defaults + public assumptions; real figures come from the
 * DB in Compass (the deep-integration layer seeds `k401CurrentBalance` and the
 * buckets from the net-worth snapshot — see the retirement IPC handler).
 */
import { ASSUMPTIONS, type FilingStatus, K401_LIMITS } from './finance-retire-constants'
import {
  type CondoProceedsResult,
  type Project401kResult,
  type SwrResult,
  type TaxAwareDrawdownRow,
  calcCondoProceeds,
  calcSWR,
  fvAnnuity,
  project401k,
  projectRetirementDrawdown
} from './finance-retire-math'

export type RetireInputs = {
  currentAge: number
  retirementAge: number
  yearsToRetirement: number
  salary: number
  k401ContribPct: number
  k401CurrentBalance: number // seeded from the net-worth snapshot in Compass
  employerMatchPct: number
  currentSavings: number
  annualSavingsExtra: number
  condoValue: number
  condoPurchasePrice: number
  primaryResidenceSince: number
  condoSaleYear: number
  filingStatus: FilingStatus
  annualExpenses: number
  ssStartAge: number
  ssMonthly: number
  ssColaRate: number
  freelanceMonthly: number
  freelanceYears: number
  rentalNetMonthly: number
  rentalYears: number
  includeRental: boolean
  cajaMonthly: number
  privateMonthly: number
  medicalInflationRate: number
  ltcEnabled: boolean
  ltcMonthly: number
  ltcStartAge: number
  ltcYears: number
  meanReturn: number
  postRetireReturn: number
  stdDev: number
  inflationRate: number
  crInflationRate: number
  fxDriftPct: number
  lifeExpectancy: number
  planToAge: number
}

// Canonical default inputs — neutral personal fields (0), sensible public
// assumptions. Also the merge base so a partial/older saved config tolerates
// newly-added keys.
export const DEFAULT_INPUTS: RetireInputs = {
  currentAge: 50,
  retirementAge: 65,
  yearsToRetirement: 15,
  salary: 0,
  k401ContribPct: 1.0, // fraction of salary to 401k (capped at IRS max)
  k401CurrentBalance: 0,
  employerMatchPct: K401_LIMITS.defaultEmployerMatchPct,
  currentSavings: 0,
  annualSavingsExtra: 0,
  condoValue: 0,
  condoPurchasePrice: 0,
  primaryResidenceSince: 2015, // §121 USE-test year; cosmetic default, user overrides
  condoSaleYear: 2030,
  filingStatus: 'single',
  annualExpenses: 30_000, // CR cost-of-living ballpark; never 0 (0 → false "100% success")
  ssStartAge: 67,
  ssMonthly: 0, // from the SSA statement; user enters
  ssColaRate: 0.025,
  freelanceMonthly: 0,
  freelanceYears: 0,
  rentalNetMonthly: 0, // net of CR tax + operating; from the CR Rental Studio
  rentalYears: 0,
  includeRental: true,
  cajaMonthly: 200, // CAJA (SEM + IVM) — subset of annualExpenses
  privateMonthly: 250, // private top-up — subset of annualExpenses
  medicalInflationRate: 0.065,
  ltcEnabled: false,
  ltcMonthly: 3_000,
  ltcStartAge: 83,
  ltcYears: 4,
  meanReturn: ASSUMPTIONS.stockReturn, // accumulation nominal
  postRetireReturn: ASSUMPTIONS.postRetireReturn, // conservative post-retirement nominal
  stdDev: 0.15,
  inflationRate: ASSUMPTIONS.usInflation, // US inflation (brackets, today's dollars)
  crInflationRate: ASSUMPTIONS.crInflation, // drives CR expense growth
  fxDriftPct: 0,
  lifeExpectancy: 90,
  planToAge: 95 // fund the plan to this terminal age (horizon)
}

// Age the 401k becomes penalty-free accessible. Drives the gap-year bridge.
export const PENALTY_FREE_AGE = 59.5

export const PROJECTION_YEARS = 40

const NUMERIC_INPUT_KEYS: Array<keyof RetireInputs> = [
  'currentAge',
  'retirementAge',
  'yearsToRetirement',
  'salary',
  'k401ContribPct',
  'k401CurrentBalance',
  'employerMatchPct',
  'currentSavings',
  'annualSavingsExtra',
  'condoValue',
  'condoPurchasePrice',
  'primaryResidenceSince',
  'condoSaleYear',
  'annualExpenses',
  'ssStartAge',
  'ssMonthly',
  'ssColaRate',
  'freelanceMonthly',
  'freelanceYears',
  'rentalNetMonthly',
  'rentalYears',
  'cajaMonthly',
  'privateMonthly',
  'medicalInflationRate',
  'ltcMonthly',
  'ltcStartAge',
  'ltcYears',
  'meanReturn',
  'postRetireReturn',
  'stdDev',
  'inflationRate',
  'crInflationRate',
  'fxDriftPct',
  'lifeExpectancy',
  'planToAge'
]

/**
 * Coerce/clamp raw inputs so the model can never produce NaN/garbage from a
 * blank, non-numeric, negative, or inverted value. Returns a fully-valid input
 * set merged over DEFAULT_INPUTS.
 */
export function sanitizeInputs(raw: Record<string, unknown> = {}): RetireInputs {
  // Blank/empty/non-numeric → the default (NOT 0), so a cleared field can't
  // silently produce a "$0 expenses → 100% success" result.
  const num = (v: unknown, d: number): number => {
    if (v === '' || v == null) return d
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

  const i: RetireInputs = { ...DEFAULT_INPUTS }
  const mut = i as unknown as Record<string, number>
  const defs = DEFAULT_INPUTS as unknown as Record<string, number>
  for (const k of NUMERIC_INPUT_KEYS) {
    mut[k] = num(raw[k], defs[k])
  }

  for (const k of [
    'salary',
    'currentSavings',
    'annualSavingsExtra',
    'condoValue',
    'condoPurchasePrice',
    'annualExpenses',
    'ssMonthly',
    'freelanceMonthly',
    'freelanceYears',
    'stdDev',
    'cajaMonthly',
    'privateMonthly',
    'ltcMonthly',
    'k401CurrentBalance'
  ]) {
    mut[k] = Math.max(0, mut[k])
  }
  for (const r of [
    'meanReturn',
    'postRetireReturn',
    'inflationRate',
    'crInflationRate',
    'ssColaRate',
    'medicalInflationRate'
  ]) {
    mut[r] = clamp(mut[r], 0, 0.5)
  }
  i.fxDriftPct = clamp(i.fxDriftPct, -0.1, 0.1)
  i.k401ContribPct = clamp(i.k401ContribPct, 0, 1)
  i.employerMatchPct = clamp(i.employerMatchPct, 0, 0.5)
  // Cap currentAge at 74 so retirementAge (currentAge+1 … 75) always has a valid range.
  i.currentAge = clamp(Math.round(i.currentAge), 18, 74)
  i.retirementAge = clamp(Math.round(i.retirementAge), i.currentAge + 1, 75)
  i.ssStartAge = clamp(Math.round(i.ssStartAge), 62, 70)
  i.lifeExpectancy = clamp(Math.round(i.lifeExpectancy), 70, 110)
  i.planToAge = clamp(Math.round(i.planToAge), i.retirementAge + 1, 110)
  i.ltcStartAge = clamp(Math.round(i.ltcStartAge), 50, 110)
  i.ltcYears = clamp(Math.round(i.ltcYears), 0, 30)
  i.primaryResidenceSince = clamp(Math.round(i.primaryResidenceSince), 1900, 2200)
  i.condoSaleYear = clamp(Math.round(i.condoSaleYear), 1900, 2200)
  // Booleans: preserve true/false (num() would coerce them to 1/0).
  i.includeRental = raw.includeRental == null ? DEFAULT_INPUTS.includeRental : !!raw.includeRental
  i.ltcEnabled = raw.ltcEnabled == null ? DEFAULT_INPUTS.ltcEnabled : !!raw.ltcEnabled
  i.filingStatus = raw.filingStatus === 'mfj' ? 'mfj' : 'single'
  return i
}

export type RetirementBridge = {
  accessAge: number
  fundedFromTaxable: boolean
  firstTapAge: number | null
  spendingToAccess: number
  taxableAtRetirement: number
  taxableAtAccess: number | null
  yearsToAccess: number
}

export type RetirementPlan = {
  inputs: RetireInputs
  k401: Project401kResult
  k401Annual: number
  employerMatch: number
  condo: CondoProceedsResult
  buckets: { taxDeferred: number; taxable: number; taxableBasis: number; roth: number }
  startBalance: number
  extraSavings: number
  grownSavings: number
  projection: TaxAwareDrawdownRow[]
  swr: SwrResult
  depleted: TaxAwareDrawdownRow | null
  taxDrag: number[]
  bridge: RetirementBridge
}

/** Compute the full plan from a set of inputs. Pure. */
export function computePlan(inputs: Record<string, unknown> = {}): RetirementPlan {
  const i = sanitizeInputs(inputs)
  const retAge = i.retirementAge
  const yearsToRetire = Math.max(0, retAge - i.currentAge)
  i.yearsToRetirement = yearsToRetire
  // Horizon runs to a fixed terminal age, so delaying retirement SHORTENS the
  // years to fund (sanitizer guarantees planToAge > retAge).
  const planYears = Math.max(1, i.planToAge - retAge)

  const k401Annual = Math.min(i.salary * i.k401ContribPct, K401_LIMITS.totalAnnualMax)
  const employerMatch = i.salary * i.employerMatchPct
  const k401 = project401k({
    currentBalance: i.k401CurrentBalance || 0,
    annualContrib: k401Annual,
    employerMatch,
    annualReturn: i.meanReturn,
    years: yearsToRetire
  })

  const condo = calcCondoProceeds({
    estimatedValue: i.condoValue,
    purchasePrice: i.condoPurchasePrice,
    filingStatus: i.filingStatus
  })

  const extraSavings = fvAnnuity(i.annualSavingsExtra / 12, i.meanReturn, yearsToRetire)
  const grownSavings = i.currentSavings * (1 + i.meanReturn) ** yearsToRetire

  const taxDeferred = k401.balance
  const taxable = condo.netProceeds + extraSavings + grownSavings
  const startBalance = taxDeferred + taxable
  const buckets = { taxDeferred, taxable, taxableBasis: taxable, roth: 0 }

  const projection = projectRetirementDrawdown({
    startBalance,
    annualExpenses: i.annualExpenses,
    annualReturn: i.postRetireReturn,
    inflationRate: i.inflationRate,
    expenseInflationRate: i.crInflationRate,
    fxDriftPct: i.fxDriftPct,
    years: planYears,
    ssStartAge: i.ssStartAge,
    ssMonthly: i.ssMonthly,
    ssColaRate: i.ssColaRate,
    currentAge: retAge,
    additionalIncome: i.freelanceMonthly,
    freelanceYears: i.freelanceYears,
    rentalNetMonthly: i.includeRental ? i.rentalNetMonthly : 0,
    rentalYears: i.includeRental ? i.rentalYears : 0,
    healthMonthly: i.cajaMonthly + i.privateMonthly,
    medicalInflationRate: i.medicalInflationRate,
    ltcEnabled: i.ltcEnabled,
    ltcMonthly: i.ltcMonthly,
    ltcStartAge: i.ltcStartAge,
    ltcYears: i.ltcYears,
    buckets,
    taxAware: true,
    filingStatus: i.filingStatus
  })

  const swr = calcSWR(startBalance, i.annualExpenses, planYears)
  const depleted = projection.find((r) => r.depleted) || null

  // 56 → 59½ bridge: can the taxable bucket fund spending before the 401k is
  // penalty-free accessible, without dipping into tax-deferred early?
  const preAccess = projection.filter((r) => r.age < Math.ceil(PENALTY_FREE_AGE))
  const earlyTap = preAccess.find((r) => r.deferredWithdrawal > 1)
  const at60 = projection.find((r) => r.age === Math.ceil(PENALTY_FREE_AGE)) || null
  const bridge: RetirementBridge = {
    accessAge: PENALTY_FREE_AGE,
    fundedFromTaxable: !earlyTap,
    firstTapAge: earlyTap ? earlyTap.age : null,
    spendingToAccess: preAccess.reduce(
      (s, r) => s + Math.max(0, r.expenses - r.ssIncome - r.freelanceIncome),
      0
    ),
    taxableAtRetirement: buckets.taxable,
    taxableAtAccess: at60 ? at60.taxableBalance : null,
    yearsToAccess: preAccess.length
  }

  // Per-year gross-up ratio (gross withdrawal ÷ pre-tax net need) so Monte Carlo
  // can scale taxes with stochastic spending without running the full tax calc.
  const taxDrag = projection.map((r) => {
    const netNeed = Math.max(
      0,
      r.expenses - r.ssIncome - (r.freelanceIncome || 0) - (r.rentalIncome || 0)
    )
    return netNeed > 0 ? Math.max(1, r.withdrawal / netNeed) : 1
  })

  return {
    inputs: i,
    k401,
    k401Annual,
    employerMatch,
    condo,
    buckets,
    startBalance,
    extraSavings,
    grownSavings,
    projection,
    swr,
    depleted,
    taxDrag,
    bridge
  }
}
