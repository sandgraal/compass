/**
 * Foreign-account & expat-tax surface (Phase 11.2).
 *
 * The foreign side of a US person's return, assembled from data Compass already
 * holds — foreign-account balances (snapshots) + the Phase 11.1 currency/FX
 * layer + a `tax:foreign-tax` tag. Pure SQLite; no secrets touched (account
 * IDENTIFIERS live in the encrypted `foreign-accounts` vault category and never
 * reach this module).
 *
 * Three outputs:
 *   - FBAR (FinCEN 114): per year, the MAXIMUM USD value of each foreign account
 *     during the year (FBAR reports the max, converted at the Treasury year-end
 *     rate), the aggregate, and a flag when the aggregate exceeds **$10,000 at
 *     any point in the year** *(verify the threshold + use official year-end
 *     rates at filing)*.
 *   - FATCA (Form 8938): the same aggregate vs a higher, filing-status-dependent
 *     threshold (default $50k — *verify*; the real value varies by status +
 *     residence). Reusing the FBAR max-aggregate is a conservative proxy.
 *   - Foreign-tax-credit (Form 1116): foreign income/property tax paid per year,
 *     from `tax:foreign-tax`-tagged rows.
 *
 * Only NON-debt foreign accounts count toward FBAR/FATCA (a foreign credit card
 * you owe on isn't a reportable financial account).
 */

import { type FxRate, type SqliteForFx, loadFxRates, pickRate } from './finance-fx'

export const FBAR_THRESHOLD_USD = 10_000 // aggregate foreign value at any point (verify)
export const FATCA_THRESHOLD_DEFAULT_USD = 50_000 // single/domestic year-end (verify; varies)
export const FATCA_THRESHOLD_SETTING_KEY = 'fatcaThresholdUsd'

// FBAR (FinCEN 114) + FATCA (8938) are US filings denominated in USD — the
// thresholds above are USD. So this surface ALWAYS reports in USD, independent
// of the user's configurable net-worth base currency (which could be EUR, etc.).
const REPORTING_CURRENCY = 'USD'

export type FbarAccountYear = {
  accountId: number
  name: string
  currency: string
  maxNative: number // max balance during the year, native currency
  maxBaseUsd: number | null // converted to base currency (null = no FX rate)
}

export type FbarYear = {
  year: number
  accounts: FbarAccountYear[]
  aggregateMaxUsd: number // sum of per-account max USD values
  exceedsThreshold: boolean // aggregate > FBAR_THRESHOLD_USD
  unconvertedCount: number
}

export type FatcaYear = {
  year: number
  aggregateMaxUsd: number
  threshold: number
  exceedsThreshold: boolean
}

export type ForeignTaxCreditYear = {
  year: number
  foreignTaxPaidUsd: number
}

export type ExpatTaxSummary = {
  reportingCurrency: string // always 'USD' — FBAR/FATCA are USD filings
  fbarThreshold: number
  fatcaThreshold: number
  fbar: FbarYear[]
  fatca: FatcaYear[]
  foreignTaxCredit: ForeignTaxCreditYear[]
  hasForeignAccounts: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Rate to value `currency` in `base` as of year-end, falling back to latest. */
function yearEndRate(rates: FxRate[], currency: string, base: string, year: number): number | null {
  if (currency === base) return 1
  return pickRate(rates, currency, base, `${year}-12-31`) ?? pickRate(rates, currency, base)
}

type ForeignAccountRow = { id: number; name: string; currency: string; balance: number | null }
type SnapshotRow = { account_id: number; captured_at: number; balance: number }

/**
 * FBAR max-aggregate-foreign-balance by year. `currentYear` is injected so the
 * live balance can seed the current year (a freshly-marked account with no
 * snapshot still shows) and so the function stays deterministic in tests.
 */
export function buildFbarByYear(
  sqlite: SqliteForFx,
  base: string,
  rates: FxRate[],
  currentYear: number
): FbarYear[] {
  const accounts = sqlite
    .prepare(
      'SELECT id, name, currency, balance FROM finance_accounts WHERE is_foreign = 1 AND COALESCE(is_debt, 0) = 0'
    )
    .all() as ForeignAccountRow[]
  if (accounts.length === 0) return []

  const snaps = sqlite
    .prepare(
      `SELECT s.account_id, s.captured_at, s.balance
         FROM finance_balance_snapshots s
         JOIN finance_accounts a ON a.id = s.account_id
        WHERE a.is_foreign = 1 AND COALESCE(a.is_debt, 0) = 0`
    )
    .all() as SnapshotRow[]

  // Max native balance per (year, account).
  const maxByYearAccount = new Map<string, number>()
  const years = new Set<number>()
  const note = (year: number, accountId: number, balance: number): void => {
    years.add(year)
    const key = `${year}:${accountId}`
    const cur = maxByYearAccount.get(key)
    if (cur == null || balance > cur) maxByYearAccount.set(key, balance)
  }
  for (const s of snaps) note(new Date(s.captured_at).getFullYear(), s.account_id, s.balance)
  // Seed the current year with each account's live balance.
  for (const a of accounts) note(currentYear, a.id, a.balance ?? 0)

  const out: FbarYear[] = []
  for (const year of [...years].sort((a, b) => a - b)) {
    const accs: FbarAccountYear[] = []
    let aggregate = 0
    let unconvertedCount = 0
    for (const a of accounts) {
      const key = `${year}:${a.id}`
      const max = maxByYearAccount.get(key)
      if (max == null) continue
      const currency = (a.currency || base).toUpperCase()
      const maxNative = round2(max)
      const rate = yearEndRate(rates, currency, base, year)
      const maxBaseUsd = rate == null ? null : round2(maxNative * rate)
      accs.push({ accountId: a.id, name: a.name, currency, maxNative, maxBaseUsd })
      if (maxBaseUsd == null) unconvertedCount++
      else aggregate += maxBaseUsd
    }
    if (accs.length === 0) continue
    aggregate = round2(aggregate)
    out.push({
      year,
      accounts: accs,
      aggregateMaxUsd: aggregate,
      exceedsThreshold: aggregate > FBAR_THRESHOLD_USD,
      unconvertedCount
    })
  }
  return out
}

/** FATCA check per year — the FBAR aggregate vs a higher threshold. */
export function buildFatcaByYear(fbar: FbarYear[], threshold: number): FatcaYear[] {
  return fbar.map((y) => ({
    year: y.year,
    aggregateMaxUsd: y.aggregateMaxUsd,
    threshold,
    exceedsThreshold: y.aggregateMaxUsd > threshold
  }))
}

/** Foreign tax paid (Form 1116) per year, from `tax:foreign-tax` rows, in base. */
export function buildForeignTaxCredit(
  sqlite: SqliteForFx,
  base: string,
  rates: FxRate[]
): ForeignTaxCreditYear[] {
  const rows = sqlite
    .prepare(
      "SELECT date, amount, currency FROM finance_transactions WHERE tax_tag = 'tax:foreign-tax'"
    )
    .all() as Array<{ date: string; amount: number; currency: string | null }>

  const byYear = new Map<number, number>()
  for (const r of rows) {
    const year = Number.parseInt(r.date.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    const currency = (r.currency || base).toUpperCase()
    const rate =
      currency === base
        ? 1
        : (pickRate(rates, currency, base, r.date) ?? pickRate(rates, currency, base))
    if (rate == null) continue
    // Tax paid is an expense (negative amount) → take the magnitude.
    byYear.set(year, (byYear.get(year) ?? 0) + -r.amount * rate)
  }

  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, v]) => ({ year, foreignTaxPaidUsd: round2(v) }))
}

export function getFatcaThreshold(sqlite: SqliteForFx): number {
  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(FATCA_THRESHOLD_SETTING_KEY) as { value?: string } | undefined
    const v = Number(row?.value)
    return Number.isFinite(v) && v > 0 ? v : FATCA_THRESHOLD_DEFAULT_USD
  } catch {
    return FATCA_THRESHOLD_DEFAULT_USD
  }
}

/** Assemble the full expat-tax summary. `currentYear` injected for determinism. */
export function buildExpatTaxSummary(sqlite: SqliteForFx, currentYear: number): ExpatTaxSummary {
  const rates = loadFxRates(sqlite)
  const fbar = buildFbarByYear(sqlite, REPORTING_CURRENCY, rates, currentYear)
  const fatcaThreshold = getFatcaThreshold(sqlite)
  return {
    reportingCurrency: REPORTING_CURRENCY,
    fbarThreshold: FBAR_THRESHOLD_USD,
    fatcaThreshold,
    fbar,
    fatca: buildFatcaByYear(fbar, fatcaThreshold),
    foreignTaxCredit: buildForeignTaxCredit(sqlite, REPORTING_CURRENCY, rates),
    hasForeignAccounts:
      sqlite.prepare('SELECT 1 FROM finance_accounts WHERE is_foreign = 1 LIMIT 1').get() != null
  }
}
