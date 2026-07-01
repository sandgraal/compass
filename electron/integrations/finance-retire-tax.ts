/**
 * US federal + Costa Rica tax math for the retirement engine (Phase 11.4 — ported
 * from retire-early-hub `utils/taxCalc.js`). Pure functions, no side effects.
 */
import {
  BRACKETS_2025,
  CR_TAX,
  type FilingStatus,
  LTCG_BRACKETS_2025,
  NIIT,
  STANDARD_DEDUCTION_2025
} from './finance-retire-constants'

export type TaxBreakdownRow = {
  range: string
  rate: number
  taxable: number
  tax: number
}

export type FederalTaxResult = {
  tax: number
  breakdown: TaxBreakdownRow[]
  effectiveRate: number
}

/** US federal ordinary-income tax on `income` (taxable, after deductions). */
export function calcFederalTax(
  income: number,
  filingStatus: FilingStatus = 'single'
): FederalTaxResult {
  const brackets = BRACKETS_2025[filingStatus]
  let tax = 0
  let remaining = Math.max(0, income)
  const breakdown: TaxBreakdownRow[] = []

  for (const bracket of brackets) {
    if (remaining <= 0) break
    const taxable = Math.min(remaining, bracket.max - bracket.min)
    const bracketTax = taxable * bracket.rate
    if (taxable > 0) {
      breakdown.push({
        range: `$${bracket.min.toLocaleString()}–${bracket.max === Number.POSITIVE_INFINITY ? '∞' : `$${bracket.max.toLocaleString()}`}`,
        rate: bracket.rate,
        taxable,
        tax: bracketTax
      })
    }
    tax += bracketTax
    remaining -= taxable
  }

  return { tax, breakdown, effectiveRate: income > 0 ? tax / income : 0 }
}

/**
 * Taxable portion of Social Security under the IRC §86 provisional-income tiers
 * (0% / up to 50% / up to 85%). Thresholds are not inflation-indexed.
 * Source: IRS Pub 915 (https://www.irs.gov/publications/p915).
 */
export function socialSecurityTaxable(
  ssBenefits: number,
  otherIncome: number,
  filingStatus: FilingStatus = 'single'
): number {
  if (ssBenefits <= 0) return 0
  const [base1, base2] = filingStatus === 'mfj' ? [32_000, 44_000] : [25_000, 34_000]
  // Don't clamp otherIncome — a net-capital-loss year can legitimately lower it.
  const provisional = otherIncome + 0.5 * ssBenefits
  if (provisional <= base1) return 0
  if (provisional <= base2) {
    return Math.min(0.5 * ssBenefits, 0.5 * (provisional - base1))
  }
  const tier1Carry = Math.min(0.5 * ssBenefits, 0.5 * (base2 - base1))
  return Math.min(0.85 * ssBenefits, 0.85 * (provisional - base2) + tier1Carry)
}

export type UsAnnualTaxOpts = {
  ordinaryIncome?: number // wages, freelance, 401k distributions
  capitalGains?: number // LTCG from investments / condo sale beyond §121
  socialSecurity?: number // taxed per §86 provisional-income tiers
  filingStatus?: FilingStatus
  stateRate?: number // FL = 0
}

export type UsAnnualTaxResult = {
  agi: number
  taxableIncome: number
  standardDeduction: number
  ordinaryTax: number
  ltcgTax: number
  niitTax: number
  stateTax: number
  totalTax: number
  effectiveRate: number
  breakdown: TaxBreakdownRow[]
}

/** Full US tax estimate for a year (ordinary + LTCG stacking + §86 SS + NIIT). */
export function calcUSAnnualTax({
  ordinaryIncome = 0,
  capitalGains = 0,
  socialSecurity = 0,
  filingStatus = 'single',
  stateRate = 0
}: UsAnnualTaxOpts): UsAnnualTaxResult {
  const stdDed = STANDARD_DEDUCTION_2025[filingStatus]

  const ssTaxable = socialSecurityTaxable(
    socialSecurity,
    ordinaryIncome + capitalGains,
    filingStatus
  )

  const agi = ordinaryIncome + ssTaxable + capitalGains
  const taxableIncome = Math.max(0, agi - stdDed)
  const taxableOrdinary = Math.max(0, taxableIncome - capitalGains)

  const { tax: ordinaryTax, breakdown } = calcFederalTax(taxableOrdinary, filingStatus)

  // LTCG stacked on top of ordinary income for bracket placement.
  const ltcgBrackets = LTCG_BRACKETS_2025[filingStatus]
  let ltcgTax = 0
  let ltcgRemaining = capitalGains
  const stackedOrdinary = taxableOrdinary
  for (const b of ltcgBrackets) {
    if (ltcgRemaining <= 0) break
    if (stackedOrdinary >= b.max) continue
    const space = b.max - Math.max(stackedOrdinary, b.min)
    const taxable = Math.min(ltcgRemaining, space)
    ltcgTax += taxable * b.rate
    ltcgRemaining -= taxable
  }

  const niitThreshold = filingStatus === 'mfj' ? NIIT.thresholdMFJ : NIIT.thresholdSingle
  const niitBase = Math.max(0, agi - niitThreshold)
  const niitTax = niitBase > 0 ? Math.min(capitalGains, niitBase) * NIIT.rate : 0

  const stateTax = (ordinaryIncome + ssTaxable) * stateRate

  const totalTax = ordinaryTax + ltcgTax + niitTax + stateTax
  const totalIncomeCombined = ordinaryIncome + socialSecurity + capitalGains
  return {
    agi,
    taxableIncome,
    standardDeduction: stdDed,
    ordinaryTax,
    ltcgTax,
    niitTax,
    stateTax,
    totalTax,
    effectiveRate: totalIncomeCombined > 0 ? totalTax / totalIncomeCombined : 0,
    breakdown
  }
}

export type Sec121Opts = {
  primaryResidenceSince: number
  salePlannedYear: number
  moveOutYear?: number | null
  filingStatus?: FilingStatus
}

export type Sec121Result = {
  eligible: boolean
  ownEligible: boolean
  useEligible: boolean
  yearsQualified: number
  yearsUsedInWindow: number
  sellByYear: number | null
  exclusionAmount: number
  note: string
}

/**
 * §121 principal-residence exclusion eligibility (2-of-5 ownership AND use tests).
 * For someone relocating abroad the USE test is the binding constraint.
 * Source: IRS Pub 523 / IRC §121(a).
 */
export function check121Eligibility({
  primaryResidenceSince,
  salePlannedYear,
  moveOutYear = null,
  filingStatus = 'single'
}: Sec121Opts): Sec121Result {
  const exclusion = filingStatus === 'mfj' ? 500_000 : 250_000
  const yearsOwned = salePlannedYear - primaryResidenceSince
  const ownEligible = yearsOwned >= 2

  const movesOutBeforeSale = moveOutYear != null && moveOutYear < salePlannedYear
  const windowStart = salePlannedYear - 5
  const usedFrom = Math.max(primaryResidenceSince, windowStart)
  const usedTo = movesOutBeforeSale && moveOutYear != null ? moveOutYear : salePlannedYear
  const yearsUsedInWindow = Math.max(0, usedTo - usedFrom)
  const useEligible = !movesOutBeforeSale || yearsUsedInWindow >= 2
  const sellByYear = movesOutBeforeSale && moveOutYear != null ? moveOutYear + 3 : null

  const eligible = ownEligible && useEligible
  const fmt$ = (n: number): string =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  let note: string
  if (!ownEligible) {
    note = `✗ Fails the 2-of-5-year ownership test (owned ${yearsOwned} yr). Consult a CPA.`
  } else if (!useEligible && moveOutYear != null) {
    note = `✗ USE test fails: sold ${salePlannedYear - moveOutYear} years after moving out (>3), so <2 of the last 5 years were lived-in. The ${fmt$(exclusion)} exclusion is lost — it would have required selling by ${sellByYear}.`
  } else if (sellByYear != null) {
    note = `✓ Eligible — ${fmt$(exclusion)} exclusion. ⚠ Deadline: after moving out in ${moveOutYear}, you must sell by ${sellByYear} (within 3 years) to keep the USE test satisfied.`
  } else {
    note = `✓ Owned & lived in since ${primaryResidenceSince} (${yearsOwned} yr), selling while still resident — §121 exclusion of ${fmt$(exclusion)} applies.`
  }

  return {
    eligible,
    ownEligible,
    useEligible,
    yearsQualified: yearsOwned,
    yearsUsedInWindow,
    sellByYear,
    exclusionAmount: eligible ? exclusion : 0,
    note
  }
}

export type CrTaxResult = {
  crSourcedIncomeUSD: number
  crSourcedIncomeCRC: number
  taxCRC: number
  taxUSD: number
  effectiveRate: number
  breakdown: Array<{
    range: string
    taxableCRC: number
    taxableUSD: number
    taxCRC: number
    taxUSD: number
  }>
  note: string
}

/** CR income tax on CR-sourced income (territorial — ~0 on US-sourced income). */
export function calcCRTax({
  crSourcedIncomeUSD = 0,
  usdToCrc = 505
}: {
  crSourcedIncomeUSD?: number
  usdToCrc?: number
}): CrTaxResult {
  const incomeInCRC = crSourcedIncomeUSD * usdToCrc
  const brackets = CR_TAX.crSourcedBrackets
  let tax = 0
  let remaining = Math.max(0, incomeInCRC)
  const breakdown: CrTaxResult['breakdown'] = []

  for (const b of brackets) {
    if (remaining <= 0) break
    const taxable = Math.min(remaining, b.max - b.min)
    const bracketTax = taxable * b.rate
    if (taxable > 0 && b.rate > 0) {
      breakdown.push({
        range: b.label,
        taxableCRC: taxable,
        taxableUSD: taxable / usdToCrc,
        taxCRC: bracketTax,
        taxUSD: bracketTax / usdToCrc
      })
    }
    tax += bracketTax
    remaining -= taxable
  }

  return {
    crSourcedIncomeUSD,
    crSourcedIncomeCRC: incomeInCRC,
    taxCRC: tax,
    taxUSD: tax / usdToCrc,
    effectiveRate: incomeInCRC > 0 ? tax / incomeInCRC : 0,
    breakdown,
    note: CR_TAX.note
  }
}
