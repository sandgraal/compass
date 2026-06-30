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
