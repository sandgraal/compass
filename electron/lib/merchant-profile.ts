/**
 * Merchant profile aggregation (merchants redesign, 2026-07) — the pure math
 * behind a tracked merchant's "everything we know" view. Callers (the
 * `merchants:*` IPC, the MCP readers, the morning brief) load a merchant's
 * slim transaction rows once (matched by the persisted `normalized_merchant`
 * key — see electron/lib/merchant-match.ts) and derive stats, monthly spend
 * buckets, cadence, and price trend here.
 *
 * Conventions: `amount < 0` is an expense; spend figures are Σ|expense| in the
 * merchant's DOMINANT currency (mixed-currency merchants are summed per
 * currency and reported in whichever has the most rows — never fake-converted).
 * Refunds/credits (amount > 0) are counted and totaled but excluded from spend.
 */

import { type Cadence, detectCadence, median } from './normalize'

/** The slim transaction shape every aggregate here consumes. */
export interface MerchantSlimTxn {
  date: string // ISO 'YYYY-MM-DD'
  amount: number // negative = expense
  currency: string
  taxTag?: string | null
  taxYear?: number | null
}

export interface MerchantStats {
  /** Σ|amount| of expenses in the dominant currency. */
  totalSpend: number
  /** Σ amount of credits/refunds (positive rows) in the dominant currency. */
  refundTotal: number
  /** All matched rows, any currency/sign. */
  txnCount: number
  /** Expense rows in the dominant currency (the denominator of avgTxn). */
  spendCount: number
  avgTxn: number
  firstTxnDate: string | null
  lastTxnDate: string | null
  /** Spend this calendar year to date vs the same span last year. */
  thisYearSpend: number
  lastYearSameSpanSpend: number
  /** % change YTD vs same span last year; null when last year had no spend. */
  trendPct: number | null
  /** Median spend across active months; null under 3 active months. */
  monthlyMedian: number | null
  cadence: Cadence | null
  /** Dominant (most rows) currency the money figures are denominated in. */
  currency: string
}

export interface MonthlyBucket {
  month: string // 'YYYY-MM'
  spend: number
  count: number
}

export interface MerchantPriceTrend {
  direction: 'up' | 'down'
  pct: number
  recentMedian: number
  historicalMedian: number
}

export interface MerchantTaxRow {
  taxTag: string
  taxYear: number | null
  total: number
  count: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Most-represented currency across the rows ('USD' for an empty set). */
export function dominantCurrency(txns: MerchantSlimTxn[]): string {
  const counts = new Map<string, number>()
  for (const t of txns) {
    const c = t.currency || 'USD'
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best = 'USD'
  let bestN = 0
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c
      bestN = n
    }
  }
  return best
}

/**
 * Headline stats for a merchant. `now` is injectable for tests; trend compares
 * calendar-year-to-date against the same Jan-1→month-day span last year so a
 * July check never reads "down 50%" just because last year is complete.
 */
export function computeMerchantStats(txns: MerchantSlimTxn[], now = new Date()): MerchantStats {
  const currency = dominantCurrency(txns)
  const inCur = txns.filter((t) => (t.currency || 'USD') === currency)
  const expenses = inCur.filter((t) => t.amount < 0)
  const refunds = inCur.filter((t) => t.amount > 0)

  const totalSpend = expenses.reduce((s, t) => s + -t.amount, 0)
  const refundTotal = refunds.reduce((s, t) => s + t.amount, 0)

  const dates = txns
    .map((t) => t.date)
    .filter(Boolean)
    .sort()
  const firstTxnDate = dates[0] ?? null
  const lastTxnDate = dates[dates.length - 1] ?? null

  const year = now.getFullYear()
  const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` // 'MM-DD'
  const spendIn = (from: string, to: string): number =>
    expenses.filter((t) => t.date >= from && t.date <= to).reduce((s, t) => s + -t.amount, 0)
  const thisYearSpend = spendIn(`${year}-01-01`, `${year}-${monthDay}`)
  const lastYearSameSpanSpend = spendIn(`${year - 1}-01-01`, `${year - 1}-${monthDay}`)
  const trendPct =
    lastYearSameSpanSpend > 0
      ? round2(((thisYearSpend - lastYearSameSpanSpend) / lastYearSameSpanSpend) * 100)
      : null

  const buckets = computeMonthlyBuckets(expenses)
  const activeMonths = buckets.filter((b) => b.spend > 0)
  const monthlyMedian =
    activeMonths.length >= 3 ? round2(median(activeMonths.map((b) => b.spend))) : null

  // Cadence over expense dates only (a refund shouldn't break a monthly rhythm).
  const expenseDates = expenses
    .map((t) => t.date)
    .sort()
    .map((d) => new Date(d))
  const cadence = detectCadence(expenseDates)

  return {
    totalSpend: round2(totalSpend),
    refundTotal: round2(refundTotal),
    txnCount: txns.length,
    spendCount: expenses.length,
    avgTxn: expenses.length > 0 ? round2(totalSpend / expenses.length) : 0,
    firstTxnDate,
    lastTxnDate,
    thisYearSpend: round2(thisYearSpend),
    lastYearSameSpanSpend: round2(lastYearSameSpanSpend),
    trendPct,
    monthlyMedian,
    cadence,
    currency
  }
}

/**
 * Month-bucketed spend (expenses only, dominant currency assumed pre-filtered
 * by the caller or via computeMerchantStats). Ascending by month; months with
 * no activity are absent (the chart renders gaps honestly).
 */
export function computeMonthlyBuckets(txns: MerchantSlimTxn[]): MonthlyBucket[] {
  const byMonth = new Map<string, { spend: number; count: number }>()
  for (const t of txns) {
    if (t.amount >= 0) continue
    const month = t.date.slice(0, 7)
    if (month.length !== 7) continue
    const b = byMonth.get(month) ?? { spend: 0, count: 0 }
    b.spend += -t.amount
    b.count += 1
    byMonth.set(month, b)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, b]) => ({ month, spend: round2(b.spend), count: b.count }))
}

/**
 * Recent-vs-historical price movement — the subscription audit's hike detector
 * (electron/integrations/finance-subscriptions.ts) generalized to any merchant
 * and both directions. Splits off the last ~3 charges (or 1/3 of the stream
 * when shorter) and compares medians; below $0.50 absolute AND 8% relative is
 * plausibly tax/surcharge drift, not a real change. Needs ≥4 charges.
 */
export function computePriceTrend(txns: MerchantSlimTxn[]): MerchantPriceTrend | null {
  const amounts = txns
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => -t.amount)
  if (amounts.length < 4) return null
  const recentCount = Math.max(1, Math.min(3, Math.floor(amounts.length / 3)))
  const recent = amounts.slice(-recentCount)
  const historical = amounts.slice(0, amounts.length - recentCount)
  const recentMedian = median(recent)
  const historicalMedian = median(historical)
  if (historicalMedian <= 1) return null
  const delta = recentMedian - historicalMedian
  const pct = (delta / historicalMedian) * 100
  if (Math.abs(delta) <= 0.5 && Math.abs(pct) <= 8) return null
  return {
    direction: delta > 0 ? 'up' : 'down',
    pct: round2(pct),
    recentMedian: round2(recentMedian),
    historicalMedian: round2(historicalMedian)
  }
}

/** Per-(taxTag, taxYear) expense totals, skipping untagged rows. */
export function computeTaxSummary(txns: MerchantSlimTxn[]): MerchantTaxRow[] {
  const byKey = new Map<string, MerchantTaxRow>()
  for (const t of txns) {
    if (t.amount >= 0) continue
    const tag = t.taxTag
    if (!tag || tag === 'tax:none') continue
    const key = `${tag}|${t.taxYear ?? ''}`
    const row = byKey.get(key) ?? { taxTag: tag, taxYear: t.taxYear ?? null, total: 0, count: 0 }
    row.total += -t.amount
    row.count += 1
    byKey.set(key, row)
  }
  return [...byKey.values()]
    .map((r) => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => (b.taxYear ?? 0) - (a.taxYear ?? 0) || b.total - a.total)
}
