/**
 * Tax disposition tagging for finance transactions (Phase 4.3).
 *
 * Each transaction gets a `taxTag` so year-end prep is a query rather than a
 * re-categorization marathon:
 *   - CR Property/Construction → `tax:capex-airbnb` (depreciable over 27.5y)
 *   - Enndustrious deposits   → `tax:schedule-c-income`
 *   - Enndustrious expenses   → `tax:schedule-c-expense`
 *   - Charity/Gifts           → `tax:charitable`
 *   - Health (eligible)       → `tax:medical`
 *   - Investment              → `tax:investment`
 *   - Default                 → `tax:none` (consumption, transfers, etc.)
 *
 * Rule order (first match wins). User overrides are sticky — see
 * `shouldOverwrite()` below — and are never re-classified.
 */

import type { RawTxn } from './finance'
import type { Geo, Purpose } from './finance-geo'

export type TaxTag =
  | 'tax:capex-airbnb'
  | 'tax:schedule-c-income'
  | 'tax:schedule-c-expense'
  | 'tax:schedule-e-income'
  | 'tax:schedule-e-expense'
  | 'tax:charitable'
  | 'tax:medical'
  | 'tax:home-office'
  | 'tax:personal'
  | 'tax:investment'
  | 'tax:none'

export type TaxTagSource = 'auto' | 'user'

// Account-name substrings that mark income/expenses as Schedule C business.
// Lowercased and matched as substrings for resilience to "Enndustrious Checking"
// vs "ENNDUSTRIOUS - CHK" etc.
const SCHEDULE_C_ACCOUNT_HINTS = ['enndustrious']

// Categories whose presence implies the row should map to a specific tag.
// Subcategory may be ignored or used for a finer match (key is `Cat|Sub`).
const CATEGORY_TAGS: Record<string, TaxTag> = {
  Charity: 'tax:charitable',
  Gifts: 'tax:charitable',
  Investment: 'tax:investment',
  Investments: 'tax:investment',
  // Health is medical only when it's a deductible expense (not insurance reimbursement).
  // Reimbursements show up as positive amounts — we filter on `amount < 0`.
  Health: 'tax:medical'
}

const HEALTH_INCOME_SUBCATEGORIES = new Set(['Insurance reimbursement', 'HSA distribution'])

export type ClassifyTaxInput = {
  amount: number
  account: string | null | undefined
  category: string | null | undefined
  subcategory: string | null | undefined
  geo: Geo
  purpose: Purpose | null | undefined
}

export function classifyTax(txn: ClassifyTaxInput): TaxTag {
  const accountLower = (txn.account ?? '').toLowerCase()
  const isScheduleCAccount = SCHEDULE_C_ACCOUNT_HINTS.some((hint) => accountLower.includes(hint))
  const category = txn.category ?? ''
  const subcategory = txn.subcategory ?? ''

  // 1. Schedule C — Enndustrious account activity.
  //    Deposits = income, withdrawals = expense. Internal transfers stay neutral.
  if (isScheduleCAccount && category !== 'Transfers') {
    return txn.amount > 0 ? 'tax:schedule-c-income' : 'tax:schedule-c-expense'
  }

  // 2. CR + capex → depreciable Airbnb investment.
  if (txn.geo === 'CR' && txn.purpose === 'capex') {
    return 'tax:capex-airbnb'
  }

  // 3. Category-based.
  const tag = CATEGORY_TAGS[category]
  if (tag === 'tax:medical') {
    if (txn.amount > 0 || HEALTH_INCOME_SUBCATEGORIES.has(subcategory)) {
      return 'tax:none'
    }
    return 'tax:medical'
  }
  if (tag) return tag

  // 4. Default.
  return 'tax:none'
}

export function taxYearFromDate(date: string): number | null {
  // Expects ISO 'YYYY-MM-DD'. Reject anything else so a typo doesn't get
  // bucketed into year 0.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return Number.parseInt(date.slice(0, 4), 10)
}

/**
 * Decides whether a re-tag pass should overwrite the existing tag.
 * User overrides (`taxTagSource === 'user'`) are sticky and never overwritten.
 */
export function shouldOverwrite(currentSource: TaxTagSource | string | null | undefined): boolean {
  return currentSource !== 'user'
}

/**
 * Tag a batch of transactions with `taxTag` + `taxYear`. Idempotent — runs
 * AFTER tagGeoAndPurpose so geo/purpose are populated.
 */
export function tagTax(txns: RawTxn[]): RawTxn[] {
  return txns.map((t) => ({
    ...t,
    taxTag: classifyTax({
      amount: t.amount,
      account: t.account,
      category: t.category,
      subcategory: t.subcategory,
      geo: (t.geo ?? 'US') as Geo,
      purpose: (t.purpose ?? null) as Purpose | null
    }),
    taxYear: taxYearFromDate(t.date)
  }))
}
