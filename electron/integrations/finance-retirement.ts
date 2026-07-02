/**
 * Long-horizon retirement projection (Phase 11.4).
 *
 * Turns the decorative `retirement` asset class into a live multi-decade
 * decumulation model: accumulate to the retirement age, then draw down against a
 * spending need offset by Social Security + the Airbnb's net income. Where the
 * 90-day `buildForecast` answers "will my cash be short next quarter?", this
 * answers "will my money last to 95?".
 *
 * Works in REAL (today's) dollars — `realReturnPct` is the return *above*
 * inflation, and spending / SS / Airbnb income stay constant in real terms (SS
 * has a COLA, so that's a fair approximation). Keeps the model interpretable
 * without an inflation series.
 *
 * Social Security can't be auto-read: the SSA-statement recognizer is content-
 * light by design (no benefit/earnings stored), so the PIA is a config input —
 * `hasSsaStatement()` only detects that a statement was ingested, to prompt the
 * user to enter the figure from it.
 *
 * Sequence-of-returns: a bad early-retirement market is the worst case for a
 * drawdown, so alongside the baseline we run a STRESS path with a lower return
 * for the first `stressYears` of retirement.
 *
 * The math is pure + injectable; a thin DB layer sources the starting balance
 * from net worth and reads/writes config in `app_settings`.
 */

import type { SqliteForFx } from './finance-fx'
import type { FilingStatus } from './finance-retire-constants'
import {
  DEFAULT_INPUTS,
  type RetireInputs,
  type RetirementPlan,
  computePlan
} from './finance-retire-engine'
import { type MonteCarloResult, makeRng, runMonteCarlo } from './finance-retire-math'
import {
  type NetWorthSnapshot,
  type SqliteForSnapshot,
  getNetWorthSnapshot
} from './finance-snapshot'

export type RetirementConfig = {
  currentAge: number
  retirementAge: number
  horizonAge: number // life expectancy / projection end
  startingAssets: number | null // base/USD; null → auto from net worth
  annualContribution: number // added each year until retirement
  realReturnPct: number // return above inflation, e.g. 5 = 5%
  annualSpending: number // today's $ spending need in retirement
  ssMonthlyAtFra: number // PIA — monthly benefit at full retirement age
  ssClaimAge: number // 62–70
  fra: number // full retirement age (default 67; verify for birth year)
  airbnbAnnualNet: number // property net income in retirement (today's $)
  otherAnnualIncome: number // pensions, annuities, etc.
  stressReturnPct: number // sequence-of-returns: return for the early stress years
  stressYears: number // # of early-retirement years the stress return applies
}

export const DEFAULT_RETIREMENT_CONFIG: RetirementConfig = {
  currentAge: 50,
  retirementAge: 65,
  horizonAge: 95,
  startingAssets: null,
  annualContribution: 0,
  realReturnPct: 5,
  annualSpending: 60_000,
  ssMonthlyAtFra: 0,
  ssClaimAge: 67,
  fra: 67,
  airbnbAnnualNet: 0,
  otherAnnualIncome: 0,
  stressReturnPct: 0,
  stressYears: 5
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Social Security claiming-age (pure) ─────────────────────────────────────

/**
 * Annual Social Security benefit for a given claiming age, from the PIA (the
 * monthly benefit at FRA). Standard rules *(verify)*:
 *   - Early: −5/9 % per month for the first 36 months early, −5/12 % beyond.
 *     (FRA 67 → claim at 62 = 70% of PIA.)
 *   - Delayed: +8 %/yr (2/3 %/month) credits after FRA, capped at age 70.
 *     (FRA 67 → claim at 70 = 124% of PIA.)
 */
export function ssAnnualBenefit(piaMonthly: number, claimAge: number, fra: number): number {
  if (!(piaMonthly > 0)) return 0
  const clampedClaim = Math.max(62, Math.min(70, claimAge))
  let factor = 1
  if (clampedClaim < fra) {
    const monthsEarly = Math.round((fra - clampedClaim) * 12)
    const first = Math.min(monthsEarly, 36)
    const beyond = Math.max(0, monthsEarly - 36)
    factor = 1 - first * (5 / 900) - beyond * (5 / 1200)
  } else if (clampedClaim > fra) {
    const monthsLate = Math.round((clampedClaim - fra) * 12)
    factor = 1 + monthsLate * (2 / 3 / 100)
  }
  return round2(piaMonthly * factor * 12)
}

// ─── Projection (pure) ───────────────────────────────────────────────────────

export type RetirementYear = {
  age: number
  year: number
  startBalance: number
  contribution: number
  growth: number
  ssIncome: number
  otherIncome: number // airbnb + other (today's $)
  withdrawal: number
  endBalance: number
  phase: 'accumulation' | 'decumulation'
}

export type RetirementProjection = {
  rows: RetirementYear[]
  ssAnnual: number // benefit at the chosen claim age
  retirementYear: number
  depletionAge: number | null // first age the portfolio hits 0 (null = lasts)
  endBalance: number
  peakBalance: number
}

/**
 * Walk the portfolio year-by-year from `currentAge` to `horizonAge`. `stress`
 * applies `stressReturnPct` for the first `stressYears` of retirement (the
 * sequence-of-returns path). Pure.
 */
export function projectRetirement(
  config: RetirementConfig,
  startingAssets: number,
  currentYear: number,
  opts: { stress?: boolean } = {}
): RetirementProjection {
  const ssAnnual = ssAnnualBenefit(config.ssMonthlyAtFra, config.ssClaimAge, config.fra)
  const baseReturn = config.realReturnPct / 100
  const stressReturn = config.stressReturnPct / 100
  const retirementYear = currentYear + Math.max(0, config.retirementAge - config.currentAge)

  const rows: RetirementYear[] = []
  let balance = Math.max(0, startingAssets)
  let depletionAge: number | null = null
  let peakBalance = balance

  const lastAge = Math.max(config.currentAge, config.horizonAge)
  for (let age = config.currentAge; age <= lastAge; age++) {
    const year = currentYear + (age - config.currentAge)
    const startBalance = round2(balance)
    const inRetirement = age >= config.retirementAge

    let contribution = 0
    let ssIncome = 0
    let otherIncome = 0
    let withdrawal = 0
    let rate = baseReturn

    if (!inRetirement) {
      contribution = config.annualContribution
      const growth = (balance + contribution) * rate
      balance = balance + contribution + growth
      rows.push({
        age,
        year,
        startBalance,
        contribution: round2(contribution),
        growth: round2(growth),
        ssIncome: 0,
        otherIncome: 0,
        withdrawal: 0,
        endBalance: round2(balance),
        phase: 'accumulation'
      })
    } else {
      const yearsIntoRetirement = age - config.retirementAge
      if (opts.stress && yearsIntoRetirement < config.stressYears) rate = stressReturn
      ssIncome = age >= config.ssClaimAge ? ssAnnual : 0
      otherIncome = config.airbnbAnnualNet + config.otherAnnualIncome
      const gap = config.annualSpending - ssIncome - otherIncome
      withdrawal = Math.max(0, gap) // surplus isn't reinvested — kept simple
      const growth = balance * rate
      balance = balance + growth - withdrawal
      if (balance <= 0) {
        balance = 0
        if (depletionAge == null) depletionAge = age
      }
      rows.push({
        age,
        year,
        startBalance,
        contribution: 0,
        growth: round2(growth),
        ssIncome: round2(ssIncome),
        otherIncome: round2(otherIncome),
        withdrawal: round2(withdrawal),
        endBalance: round2(balance),
        phase: 'decumulation'
      })
    }
    if (balance > peakBalance) peakBalance = balance
  }

  return {
    rows,
    ssAnnual,
    retirementYear,
    depletionAge,
    endBalance: round2(balance),
    peakBalance: round2(peakBalance)
  }
}

// ─── DB layer ────────────────────────────────────────────────────────────────

export const RETIREMENT_CONFIG_KEYS: Record<keyof RetirementConfig, string> = {
  currentAge: 'retCurrentAge',
  retirementAge: 'retRetirementAge',
  horizonAge: 'retHorizonAge',
  startingAssets: 'retStartingAssets',
  annualContribution: 'retAnnualContribution',
  realReturnPct: 'retRealReturnPct',
  annualSpending: 'retAnnualSpending',
  ssMonthlyAtFra: 'retSsMonthlyAtFra',
  ssClaimAge: 'retSsClaimAge',
  fra: 'retFra',
  airbnbAnnualNet: 'retAirbnbAnnualNet',
  otherAnnualIncome: 'retOtherAnnualIncome',
  stressReturnPct: 'retStressReturnPct',
  stressYears: 'retStressYears'
}

/** Sum of liquid/invested assets (retirement + savings) from a net-worth snapshot. */
function sumStartingAssets(snap: NetWorthSnapshot): number {
  return round2(
    snap.byAccount
      .filter((a) => a.assetClass === 'retirement' || a.assetClass === 'savings')
      .reduce((sum, a) => sum + (a.baseBalance ?? 0), 0)
  )
}

/** Sum of liquid/invested net-worth assets (retirement + savings), base currency. */
export function defaultStartingAssets(sqlite: SqliteForSnapshot): number {
  return sumStartingAssets(getNetWorthSnapshot(sqlite))
}

/** True when an SSA statement has been ingested (records source 'social-security'). */
export function hasSsaStatement(sqlite: SqliteForFx): boolean {
  try {
    return (
      sqlite.prepare("SELECT 1 FROM records WHERE source = 'social-security' LIMIT 1").get() != null
    )
  } catch {
    return false
  }
}

export function getRetirementConfig(sqlite: SqliteForFx): RetirementConfig {
  const read = (key: string): string | null => {
    try {
      const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        | { value?: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }
  const num = (key: keyof RetirementConfig, fallback: number): number => {
    // Guard before Number(): Number(null) and Number('') are both 0 (finite),
    // which would mask a missing setting as a real 0 instead of the default.
    const raw = read(RETIREMENT_CONFIG_KEYS[key])
    if (raw == null || raw === '') return fallback
    const v = Number(raw)
    return Number.isFinite(v) ? v : fallback
  }
  const startRaw = read(RETIREMENT_CONFIG_KEYS.startingAssets)
  const startingAssets =
    startRaw == null || startRaw === ''
      ? null
      : Number.isFinite(Number(startRaw))
        ? Number(startRaw)
        : null

  const d = DEFAULT_RETIREMENT_CONFIG
  return {
    currentAge: num('currentAge', d.currentAge),
    retirementAge: num('retirementAge', d.retirementAge),
    horizonAge: num('horizonAge', d.horizonAge),
    startingAssets,
    annualContribution: num('annualContribution', d.annualContribution),
    realReturnPct: num('realReturnPct', d.realReturnPct),
    annualSpending: num('annualSpending', d.annualSpending),
    ssMonthlyAtFra: num('ssMonthlyAtFra', d.ssMonthlyAtFra),
    ssClaimAge: num('ssClaimAge', d.ssClaimAge),
    fra: num('fra', d.fra),
    airbnbAnnualNet: num('airbnbAnnualNet', d.airbnbAnnualNet),
    otherAnnualIncome: num('otherAnnualIncome', d.otherAnnualIncome),
    stressReturnPct: num('stressReturnPct', d.stressReturnPct),
    stressYears: num('stressYears', d.stressYears)
  }
}

export function setRetirementConfig(
  sqlite: SqliteForFx,
  patch: Partial<RetirementConfig>,
  now: number = Date.now()
): void {
  const write = (key: string, value: string): void => {
    sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now)
  }
  for (const [k, v] of Object.entries(patch) as Array<[keyof RetirementConfig, unknown]>) {
    const key = RETIREMENT_CONFIG_KEYS[k]
    if (!key) continue
    if (k === 'startingAssets') {
      write(key, v == null ? '' : String(v))
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      write(key, String(v))
    }
  }
}

export type RetirementResult = {
  baseCurrency: string
  config: RetirementConfig
  startingAssets: number
  hasSsaStatement: boolean
  baseline: RetirementProjection
  stress: RetirementProjection
}

/**
 * Assemble the projection: resolve the starting balance (config override or
 * net-worth default), run the baseline + a sequence-of-returns stress path.
 * `currentYear` is injected for determinism.
 */
export function buildRetirementProjection(
  sqlite: SqliteForFx & SqliteForSnapshot,
  currentYear: number
): RetirementResult {
  const config = getRetirementConfig(sqlite)
  // One snapshot serves both the starting-balance default and the base currency.
  const snap = getNetWorthSnapshot(sqlite)
  const startingAssets =
    config.startingAssets != null ? config.startingAssets : sumStartingAssets(snap)
  const baseline = projectRetirement(config, startingAssets, currentYear, { stress: false })
  const stress = projectRetirement(config, startingAssets, currentYear, { stress: true })
  return {
    baseCurrency: snap.baseCurrency,
    config,
    startingAssets,
    hasSsaStatement: hasSsaStatement(sqlite),
    baseline,
    stress
  }
}

// ─── Rich engine (Phase 11.4 supersession) ───────────────────────────────────
//
// The deterministic `buildRetirementProjection` above still backs the legacy
// Finance→Retirement sub-tab. `buildRetirementPlan` below is the richer engine
// (Monte-Carlo + tax-aware bucket drawdown, ported from retire-early-hub) that
// the new Retirement surface consumes and that will supersede the legacy tab.
// It reuses the SAME connectors — starting balances come from the net-worth
// snapshot, base currency from the same snapshot — so no displayed figure moves.

// Fixed seed so the plan's Monte Carlo / success rate is reproducible (matches
// the optimizer's seed). Determinism keeps the UI stable and tests exact.
const RETIRE_MC_SEED = 20290101

/** Split the net-worth snapshot into engine seed buckets (base currency). */
function bucketsFromSnapshot(snap: NetWorthSnapshot): { taxDeferred: number; taxable: number } {
  let taxDeferred = 0
  let taxable = 0
  for (const a of snap.byAccount) {
    if (a.isDebt) continue
    const bal = a.baseBalance ?? 0
    if (a.assetClass === 'retirement') taxDeferred += bal
    else if (a.assetClass === 'savings') taxable += bal
    // real_estate / manual_asset / spending are excluded from investable buckets.
  }
  return { taxDeferred: round2(taxDeferred), taxable: round2(taxable) }
}

// ─── Rich engine config (the fields the legacy 14 don't own) ─────────────────
//
// Everything the tax-aware engine needs BEYOND the legacy config: nominal
// returns, accumulation (salary/401k), §121 home sale, healthcare/LTC, and the
// life-expectancy horizon. Persisted under `retEng*` app_settings keys so the
// new Retirement page drives the rich model WITHOUT touching the legacy config
// (which still backs the old tab). Legacy config keeps ownership of demographics,
// spending, SS, Airbnb net, other income, and the pre-retirement contribution.

export type RetireEngineConfig = {
  meanReturn: number // accumulation nominal
  postRetireReturn: number // post-retirement nominal
  stdDev: number
  inflationRate: number
  crInflationRate: number
  fxDriftPct: number
  salary: number
  k401ContribPct: number
  employerMatchPct: number
  condoValue: number
  condoPurchasePrice: number
  primaryResidenceSince: number
  condoSaleYear: number
  filingStatus: FilingStatus
  ssColaRate: number
  cajaMonthly: number
  privateMonthly: number
  medicalInflationRate: number
  ltcEnabled: boolean
  ltcMonthly: number
  ltcStartAge: number
  ltcYears: number
  lifeExpectancy: number
}

export const DEFAULT_RETIRE_ENGINE_CONFIG: RetireEngineConfig = {
  meanReturn: DEFAULT_INPUTS.meanReturn,
  postRetireReturn: DEFAULT_INPUTS.postRetireReturn,
  stdDev: DEFAULT_INPUTS.stdDev,
  inflationRate: DEFAULT_INPUTS.inflationRate,
  crInflationRate: DEFAULT_INPUTS.crInflationRate,
  fxDriftPct: DEFAULT_INPUTS.fxDriftPct,
  salary: DEFAULT_INPUTS.salary,
  k401ContribPct: DEFAULT_INPUTS.k401ContribPct,
  employerMatchPct: DEFAULT_INPUTS.employerMatchPct,
  condoValue: DEFAULT_INPUTS.condoValue,
  condoPurchasePrice: DEFAULT_INPUTS.condoPurchasePrice,
  primaryResidenceSince: DEFAULT_INPUTS.primaryResidenceSince,
  condoSaleYear: DEFAULT_INPUTS.condoSaleYear,
  filingStatus: DEFAULT_INPUTS.filingStatus,
  ssColaRate: DEFAULT_INPUTS.ssColaRate,
  cajaMonthly: DEFAULT_INPUTS.cajaMonthly,
  privateMonthly: DEFAULT_INPUTS.privateMonthly,
  medicalInflationRate: DEFAULT_INPUTS.medicalInflationRate,
  ltcEnabled: DEFAULT_INPUTS.ltcEnabled,
  ltcMonthly: DEFAULT_INPUTS.ltcMonthly,
  ltcStartAge: DEFAULT_INPUTS.ltcStartAge,
  ltcYears: DEFAULT_INPUTS.ltcYears,
  lifeExpectancy: DEFAULT_INPUTS.lifeExpectancy
}

export const RETIRE_ENGINE_CONFIG_KEYS: Record<keyof RetireEngineConfig, string> = {
  meanReturn: 'retEngMeanReturn',
  postRetireReturn: 'retEngPostRetireReturn',
  stdDev: 'retEngStdDev',
  inflationRate: 'retEngInflationRate',
  crInflationRate: 'retEngCrInflationRate',
  fxDriftPct: 'retEngFxDriftPct',
  salary: 'retEngSalary',
  k401ContribPct: 'retEngK401ContribPct',
  employerMatchPct: 'retEngEmployerMatchPct',
  condoValue: 'retEngCondoValue',
  condoPurchasePrice: 'retEngCondoPurchasePrice',
  primaryResidenceSince: 'retEngPrimaryResidenceSince',
  condoSaleYear: 'retEngCondoSaleYear',
  filingStatus: 'retEngFilingStatus',
  ssColaRate: 'retEngSsColaRate',
  cajaMonthly: 'retEngCajaMonthly',
  privateMonthly: 'retEngPrivateMonthly',
  medicalInflationRate: 'retEngMedicalInflationRate',
  ltcEnabled: 'retEngLtcEnabled',
  ltcMonthly: 'retEngLtcMonthly',
  ltcStartAge: 'retEngLtcStartAge',
  ltcYears: 'retEngLtcYears',
  lifeExpectancy: 'retEngLifeExpectancy'
}

export function getRetireEngineConfig(sqlite: SqliteForFx): RetireEngineConfig {
  const read = (key: string): string | null => {
    try {
      const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        | { value?: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }
  const num = (key: keyof RetireEngineConfig, fallback: number): number => {
    // Guard before Number(): Number(null)/Number('') are 0, which would mask a
    // missing setting as a real 0 instead of the default.
    const raw = read(RETIRE_ENGINE_CONFIG_KEYS[key])
    if (raw == null || raw === '') return fallback
    const v = Number(raw)
    return Number.isFinite(v) ? v : fallback
  }
  const bool = (key: keyof RetireEngineConfig, fallback: boolean): boolean => {
    const raw = read(RETIRE_ENGINE_CONFIG_KEYS[key])
    if (raw == null || raw === '') return fallback
    return raw === '1' || raw === 'true'
  }
  const d = DEFAULT_RETIRE_ENGINE_CONFIG
  const filingRaw = read(RETIRE_ENGINE_CONFIG_KEYS.filingStatus)
  return {
    meanReturn: num('meanReturn', d.meanReturn),
    postRetireReturn: num('postRetireReturn', d.postRetireReturn),
    stdDev: num('stdDev', d.stdDev),
    inflationRate: num('inflationRate', d.inflationRate),
    crInflationRate: num('crInflationRate', d.crInflationRate),
    fxDriftPct: num('fxDriftPct', d.fxDriftPct),
    salary: num('salary', d.salary),
    k401ContribPct: num('k401ContribPct', d.k401ContribPct),
    employerMatchPct: num('employerMatchPct', d.employerMatchPct),
    condoValue: num('condoValue', d.condoValue),
    condoPurchasePrice: num('condoPurchasePrice', d.condoPurchasePrice),
    primaryResidenceSince: num('primaryResidenceSince', d.primaryResidenceSince),
    condoSaleYear: num('condoSaleYear', d.condoSaleYear),
    filingStatus: filingRaw === 'mfj' ? 'mfj' : 'single',
    ssColaRate: num('ssColaRate', d.ssColaRate),
    cajaMonthly: num('cajaMonthly', d.cajaMonthly),
    privateMonthly: num('privateMonthly', d.privateMonthly),
    medicalInflationRate: num('medicalInflationRate', d.medicalInflationRate),
    ltcEnabled: bool('ltcEnabled', d.ltcEnabled),
    ltcMonthly: num('ltcMonthly', d.ltcMonthly),
    ltcStartAge: num('ltcStartAge', d.ltcStartAge),
    ltcYears: num('ltcYears', d.ltcYears),
    lifeExpectancy: num('lifeExpectancy', d.lifeExpectancy)
  }
}

export function setRetireEngineConfig(
  sqlite: SqliteForFx,
  patch: Partial<RetireEngineConfig>,
  now: number = Date.now()
): void {
  const write = (key: string, value: string): void => {
    sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now)
  }
  for (const [k, v] of Object.entries(patch) as Array<[keyof RetireEngineConfig, unknown]>) {
    const key = RETIRE_ENGINE_CONFIG_KEYS[k]
    if (!key) continue
    if (k === 'filingStatus') {
      if (v === 'single' || v === 'mfj') write(key, v)
    } else if (k === 'ltcEnabled') {
      if (typeof v === 'boolean') write(key, v ? '1' : '0')
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      write(key, String(v))
    }
  }
}

/**
 * Map the legacy config + engine config + snapshot-derived buckets into the rich
 * engine's inputs. Legacy config owns demographics/spending/SS/airbnb/other-income/
 * contribution; the snapshot seeds current balances (retirement→tax-deferred,
 * savings→taxable); the engine config owns everything else. NOTE: the legacy
 * `realReturnPct` (a REAL return) is deliberately NOT mapped onto the engine's
 * NOMINAL returns — that would double-count inflation.
 */
function engineInputs(
  config: RetirementConfig,
  eng: RetireEngineConfig,
  buckets: { taxDeferred: number; taxable: number }
): RetireInputs {
  const override = config.startingAssets
  // A single-number override is treated as liquid taxable; else use the buckets.
  const k401CurrentBalance = override != null ? 0 : buckets.taxDeferred
  const currentSavings = override != null ? override : buckets.taxable
  const horizonYears = Math.max(0, config.horizonAge - config.retirementAge)
  return {
    ...DEFAULT_INPUTS,
    // Legacy-owned continuity.
    currentAge: config.currentAge,
    retirementAge: config.retirementAge,
    planToAge: config.horizonAge,
    annualExpenses: config.annualSpending,
    ssMonthly: config.ssMonthlyAtFra,
    ssStartAge: config.ssClaimAge,
    annualSavingsExtra: config.annualContribution,
    rentalNetMonthly: config.airbnbAnnualNet / 12,
    rentalYears: config.airbnbAnnualNet > 0 ? horizonYears : 0,
    includeRental: config.airbnbAnnualNet > 0,
    freelanceMonthly: config.otherAnnualIncome / 12,
    freelanceYears: config.otherAnnualIncome > 0 ? horizonYears : 0,
    // Snapshot-seeded balances.
    k401CurrentBalance,
    currentSavings,
    // Engine-owned overrides.
    meanReturn: eng.meanReturn,
    postRetireReturn: eng.postRetireReturn,
    stdDev: eng.stdDev,
    inflationRate: eng.inflationRate,
    crInflationRate: eng.crInflationRate,
    fxDriftPct: eng.fxDriftPct,
    salary: eng.salary,
    k401ContribPct: eng.k401ContribPct,
    employerMatchPct: eng.employerMatchPct,
    condoValue: eng.condoValue,
    condoPurchasePrice: eng.condoPurchasePrice,
    primaryResidenceSince: eng.primaryResidenceSince,
    condoSaleYear: eng.condoSaleYear,
    filingStatus: eng.filingStatus,
    ssColaRate: eng.ssColaRate,
    cajaMonthly: eng.cajaMonthly,
    privateMonthly: eng.privateMonthly,
    medicalInflationRate: eng.medicalInflationRate,
    ltcEnabled: eng.ltcEnabled,
    ltcMonthly: eng.ltcMonthly,
    ltcStartAge: eng.ltcStartAge,
    ltcYears: eng.ltcYears,
    lifeExpectancy: eng.lifeExpectancy
  }
}

export type RetirementPlanResult = {
  baseCurrency: string
  startingAssets: number // today's-dollars investable total (snapshot sum or override)
  hasSsaStatement: boolean
  config: RetirementConfig // legacy-owned fields (age/spending/SS/airbnb/…)
  engineConfig: RetireEngineConfig // engine-owned fields (returns/healthcare/…)
  inputs: RetireInputs // fully-resolved engine inputs
  plan: RetirementPlan
  monteCarlo: MonteCarloResult
}

/**
 * Assemble the rich retirement plan: seed the tax-aware engine from the
 * net-worth snapshot + legacy config, run `computePlan` + a seeded fat-tailed
 * Monte Carlo. Pure over the DB; the seed is pinned so the result is
 * deterministic (stable UI, exact tests).
 */
export function buildRetirementPlan(sqlite: SqliteForFx & SqliteForSnapshot): RetirementPlanResult {
  const config = getRetirementConfig(sqlite)
  const engineConfig = getRetireEngineConfig(sqlite)
  const snap = getNetWorthSnapshot(sqlite)
  const buckets = bucketsFromSnapshot(snap)
  const inputs = engineInputs(config, engineConfig, buckets)
  const plan = computePlan(inputs)
  const i = plan.inputs
  const inflationMean = (1 + i.crInflationRate) * (1 + i.fxDriftPct) - 1
  const years = Math.max(1, i.planToAge - i.retirementAge)
  const monteCarlo = runMonteCarlo({
    startBalance: plan.startBalance,
    annualExpenses: i.annualExpenses,
    meanReturn: i.postRetireReturn,
    stdDev: i.stdDev,
    inflationMean,
    inflationStd: 0.02,
    years,
    simulations: 1000,
    ssStartAge: i.ssStartAge,
    ssMonthly: i.ssMonthly,
    ssColaRate: i.ssColaRate,
    currentAge: i.retirementAge,
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
    taxDrag: plan.taxDrag,
    rng: makeRng(RETIRE_MC_SEED)
  })
  const startingAssets =
    config.startingAssets != null
      ? config.startingAssets
      : round2(buckets.taxDeferred + buckets.taxable)
  return {
    baseCurrency: snap.baseCurrency,
    startingAssets,
    hasSsaStatement: hasSsaStatement(sqlite),
    config,
    engineConfig,
    inputs: i,
    plan,
    monteCarlo
  }
}
