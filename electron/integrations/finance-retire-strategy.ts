/**
 * Retirement strategy calculators layered on top of the core drawdown (Phase 11.4
 * — ported from retire-early-hub `utils/strategy.js`): RMDs, SEPP / Rule 72(t),
 * Social Security break-even, 0% LTCG harvesting, and Roth conversion ladders.
 * Pure functions.
 */
import {
  BRACKETS_2025,
  type FilingStatus,
  LTCG_BRACKETS_2025,
  STANDARD_DEDUCTION_2025
} from './finance-retire-constants'
import { calcFederalTax } from './finance-retire-tax'

// IRS Uniform Lifetime Table (2022+) — RMD divisors, ages 72+.
export const UNIFORM_LIFETIME_TABLE: Record<number, number> = {
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4
}

// IRS Single Life Table (2022+) — used for SEPP, ages 50–70.
export const SINGLE_LIFE_TABLE: Record<number, number> = {
  50: 36.2,
  51: 35.3,
  52: 34.3,
  53: 33.4,
  54: 32.5,
  55: 31.6,
  56: 30.6,
  57: 29.8,
  58: 28.9,
  59: 28.0,
  60: 27.1,
  61: 26.2,
  62: 25.4,
  63: 24.5,
  64: 23.7,
  65: 22.9,
  66: 22.0,
  67: 21.2,
  68: 20.4,
  69: 19.6,
  70: 18.8
}

function nearest(table: Record<number, number>, age: number): number {
  if (table[age] != null) return table[age]
  const keys = Object.keys(table).map(Number)
  const min = Math.min(...keys)
  const max = Math.max(...keys)
  return table[Math.max(min, Math.min(max, age))]
}

/** RMD divisor for a given age (≥73). Returns 0 below the RMD age. */
export function rmdDivisor(age: number): number {
  return age >= 73 ? nearest(UNIFORM_LIFETIME_TABLE, age) : 0
}

export type SeppResult = {
  balance: number
  age: number
  rate: number
  lifeExpectancy: number
  amortization: number
  rmdMethod: number
  recommended: number
}

/**
 * SEPP / Rule 72(t) — substantially equal periodic payments to tap a pre-tax
 * account before 59½ without the 10% penalty.
 */
export function calcSEPP({
  balance,
  age,
  rate = 0.05
}: {
  balance: number
  age: number
  rate?: number
}): SeppResult {
  const L = nearest(SINGLE_LIFE_TABLE, age)
  const amortization = rate > 0 ? balance * (rate / (1 - (1 + rate) ** -L)) : balance / L
  const rmdMethod = balance / L
  return {
    balance,
    age,
    rate,
    lifeExpectancy: L,
    amortization,
    rmdMethod,
    recommended: amortization
  }
}

export type SsBreakevenRow = { age: number } & Record<string, number>

export type SsBreakevenResult = {
  claimAges: number[]
  lifeExpectancy: number
  series: SsBreakevenRow[]
  byClaimAge: Record<number, { monthly: number; annual: number; lifetimeTotal: number }>
  breakeven: Record<string, number | null>
  bestClaimAge: number
}

/**
 * Social Security break-even across claim ages — cumulative lifetime benefits
 * (with optional COLA), and the age at which delaying overtakes claiming early.
 */
export function calcSSBreakeven({
  monthlyByAge,
  lifeExpectancy = 90,
  colaRate = 0
}: {
  monthlyByAge: Record<number, number>
  lifeExpectancy?: number
  colaRate?: number
}): SsBreakevenResult {
  const claimAges = Object.keys(monthlyByAge)
    .map(Number)
    .sort((a, b) => a - b)
  const startAge = Math.min(...claimAges)

  const annualAt = (claimAge: number, age: number): number =>
    age >= claimAge ? monthlyByAge[claimAge] * 12 * (1 + colaRate) ** (age - claimAge) : 0

  const series: SsBreakevenRow[] = []
  const cumulative: Record<number, number> = Object.fromEntries(claimAges.map((a) => [a, 0]))
  for (let age = startAge; age <= lifeExpectancy; age++) {
    const row: SsBreakevenRow = { age }
    for (const a of claimAges) {
      cumulative[a] += annualAt(a, age)
      row[`c${a}`] = Math.round(cumulative[a])
    }
    series.push(row)
  }

  const breakevenAge = (earlier: number, later: number): number | null => {
    for (const row of series) {
      if (row[`c${later}`] >= row[`c${earlier}`] && row.age > later) return row.age
    }
    return null
  }

  const byClaimAge: SsBreakevenResult['byClaimAge'] = Object.fromEntries(
    claimAges.map((a) => [
      a,
      {
        monthly: monthlyByAge[a],
        annual: monthlyByAge[a] * 12,
        lifetimeTotal: Math.round(cumulative[a])
      }
    ])
  )

  const breakeven: Record<string, number | null> = {}
  for (let i = 0; i < claimAges.length; i++) {
    for (let j = i + 1; j < claimAges.length; j++) {
      breakeven[`${claimAges[j]}v${claimAges[i]}`] = breakevenAge(claimAges[i], claimAges[j])
    }
  }

  const best = claimAges.reduce((b, a) => (cumulative[a] > cumulative[b] ? a : b), claimAges[0])

  return { claimAges, lifeExpectancy, series, byClaimAge, breakeven, bestClaimAge: best }
}

/**
 * 0% long-term capital-gains headroom: how much MORE in LTCG can be realized this
 * year while staying in the 0% federal LTCG bracket.
 */
export function ltcg0Headroom({
  ordinaryTaxableIncome = 0,
  realizedLTCG = 0,
  filingStatus = 'single'
}: {
  ordinaryTaxableIncome?: number
  realizedLTCG?: number
  filingStatus?: FilingStatus
}): number {
  const top0 = LTCG_BRACKETS_2025[filingStatus][0].max
  return Math.max(0, top0 - Math.max(0, ordinaryTaxableIncome) - Math.max(0, realizedLTCG))
}

export const LTCG_0_TOP = (filingStatus: FilingStatus = 'single'): number =>
  LTCG_BRACKETS_2025[filingStatus][0].max
export const STD_DEDUCTION = (filingStatus: FilingStatus = 'single'): number =>
  STANDARD_DEDUCTION_2025[filingStatus]

/** Top of the Nth ordinary bracket (0-indexed), e.g. bracketTop(1) = top of 12%. */
export const bracketTop = (i: number, filingStatus: FilingStatus = 'single'): number =>
  BRACKETS_2025[filingStatus][i].max

export type RothLadderRow = {
  age: number
  baseline: number
  conversion: number
  tax: number
  marginalRate: number
  cumulativeConverted: number
  rothBalance: number
  k401Remaining: number
  accessibleAt: number
}

export type RothLadderResult = {
  ladder: RothLadderRow[]
  totalConverted: number
  totalTax: number
  avgRate: number
  rothBalanceEnd: number
  k401Remaining: number
}

/**
 * Roth conversion ladder — each year convert from the tax-deferred account up to
 * a target ordinary-taxable-income ceiling, paying the marginal ordinary tax.
 */
export function calcRothLadder({
  rows,
  k401Balance,
  fillToTaxableIncome,
  startAge,
  endAge,
  growthRate = 0.06,
  filingStatus = 'single'
}: {
  rows: Array<{ age: number; ordinaryTaxable?: number }>
  k401Balance: number
  fillToTaxableIncome: number
  startAge: number
  endAge: number
  growthRate?: number
  filingStatus?: FilingStatus
}): RothLadderResult {
  const byAge: Record<number, { age: number; ordinaryTaxable?: number }> = Object.fromEntries(
    rows.map((r) => [r.age, r])
  )
  let k401 = k401Balance
  let roth = 0
  let cumulative = 0
  const ladder: RothLadderRow[] = []

  for (let age = startAge; age < endAge; age++) {
    k401 *= 1 + growthRate
    roth *= 1 + growthRate
    const baseline = byAge[age]?.ordinaryTaxable ?? 0
    const room = Math.max(0, fillToTaxableIncome - baseline)
    const conversion = Math.min(room, k401)
    const tax =
      calcFederalTax(baseline + conversion, filingStatus).tax -
      calcFederalTax(baseline, filingStatus).tax
    k401 -= conversion
    roth += conversion
    cumulative += conversion
    ladder.push({
      age,
      baseline,
      conversion,
      tax,
      marginalRate: conversion > 0 ? tax / conversion : 0,
      cumulativeConverted: cumulative,
      rothBalance: roth,
      k401Remaining: k401,
      accessibleAt: age + 5
    })
  }

  const totalConverted = cumulative
  const totalTax = ladder.reduce((s, r) => s + r.tax, 0)
  return {
    ladder,
    totalConverted,
    totalTax,
    avgRate: totalConverted > 0 ? totalTax / totalConverted : 0,
    rothBalanceEnd: roth,
    k401Remaining: k401
  }
}
