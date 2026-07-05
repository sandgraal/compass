/**
 * Income engine (Phase 10.9 — "Argyle → forecast"). Turns real Argyle paystubs into
 * the cash-flow forecast's income streams and an aggregates-only income summary.
 *
 * The forecast today INFERS income from bank deposits (`detectRecurringIncome` over
 * `finance_transactions` — positive amounts, cadence guessed from gaps). That works but
 * is fuzzy: it only sees NET deposits, guesses cadence, and can't see gross/withholding.
 * When real paystubs exist, they're ground truth — so `buildForecast` PREFERS paystub-
 * derived streams and suppresses the matching inferred bank-deposit stream (dedupe by
 * net amount), avoiding a double count. When no paystubs exist, the merge returns the
 * inferred streams unchanged → ZERO behavior change for users without Argyle.
 *
 * Pure + SQLite-only (no Drizzle, no network) so it unit-tests against a real DB. The
 * type-only import from `finance-forecast` keeps the two modules free of a runtime cycle.
 */

import type { RecurringIncomeStream, SqliteForForecast } from './finance-forecast'
import type { Cadence } from './finance-subscriptions'

const DAY_MS = 86_400_000

// Cadence → payouts per year (for annualizing) and step days (for the next-payday estimate).
const CADENCE_PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  'semi-annual': 2,
  yearly: 1
}
const CADENCE_STEP_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  'semi-annual': 182,
  yearly: 365
}

export type PaystubRow = {
  employer: string | null
  grossPay: number | null
  netPay: number | null
  withholding: number | null
  deductions: number | null
  currency: string
  periodStart: string | null
  periodEnd: string | null
  paidAt: string | null
  payCycle: string | null
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Map a stated Argyle pay-cycle string to a forecast cadence (best-effort). */
function cadenceFromCycle(raw: string | null): Cadence | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (/week/.test(s) && /(bi|two|2|fortn)/.test(s)) return 'biweekly'
  // Semimonthly (15th + last day, 24/yr) has no fixed-step cadence — approximate as
  // biweekly (26/yr) for a 90-day cash forecast; the ≤2-events/yr drift is immaterial.
  if (/(semi|twice|15th)/.test(s)) return 'biweekly'
  if (/week/.test(s)) return 'weekly'
  if (/month/.test(s)) return 'monthly'
  if (/quarter/.test(s)) return 'quarterly'
  if (/(year|annual)/.test(s)) return 'yearly'
  return null
}

/** Infer cadence from the median gap between sorted paid dates. */
function cadenceFromGaps(paidDates: string[]): Cadence | null {
  const ds = [...paidDates].sort()
  if (ds.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < ds.length; i++) {
    const g = Math.round((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / DAY_MS)
    if (g > 0) gaps.push(g)
  }
  if (!gaps.length) return null
  const med = median(gaps)
  if (med >= 5 && med <= 9) return 'weekly'
  if (med >= 12 && med <= 18) return 'biweekly' // covers biweekly (14) + semimonthly (~15)
  if (med >= 25 && med <= 35) return 'monthly'
  if (med >= 80 && med <= 100) return 'quarterly'
  return null
}

type Grouped = { employer: string; currency: string; rows: PaystubRow[] }

/** Group usable paystubs by employer + currency. */
function groupPaystubs(paystubs: PaystubRow[]): Grouped[] {
  const groups = new Map<string, Grouped>()
  for (const p of paystubs) {
    if (p.netPay == null || p.netPay <= 0 || !p.paidAt) continue
    const employer = p.employer?.trim() || 'Payroll'
    const currency = p.currency || 'USD'
    const key = `${employer.toLowerCase()}::${currency}`
    const g = groups.get(key) ?? { employer, currency, rows: [] }
    g.rows.push(p)
    groups.set(key, g)
  }
  return [...groups.values()]
}

/**
 * Real paystubs → forecast income streams. Net pay is the cash inflow; the stream is
 * routed to `defaultCashAccountId` (the forecast answers "will my cash be short?", and
 * a paystub carries no bank-account id of its own). Returns [] when there's no cash
 * account to route to (so the caller keeps the inferred streams unchanged).
 */
export function paystubsToIncomeStreams(
  paystubs: PaystubRow[],
  opts: { defaultCashAccountId: number | null }
): RecurringIncomeStream[] {
  if (opts.defaultCashAccountId == null) return []
  const streams: RecurringIncomeStream[] = []
  for (const g of groupPaystubs(paystubs)) {
    const paidDates = g.rows.map((r) => r.paidAt as string).sort()
    const cadence = cadenceFromCycle(g.rows[0].payCycle) ?? cadenceFromGaps(paidDates)
    if (!cadence) continue
    const nets = g.rows.map((r) => r.netPay as number)
    streams.push({
      accountId: opts.defaultCashAccountId,
      label: `${g.employer} · paystub`,
      cadence,
      medianAmount: median(nets),
      lastSeen: paidDates[paidDates.length - 1],
      nDeposits: g.rows.length
    })
  }
  return streams
}

/**
 * Prefer real paystub streams over inferred bank-deposit streams. An inferred stream is
 * dropped when its median amount matches a paystub stream's net pay within `tolerancePct`
 * — that's the same paycheck seen from the bank side, and keeping both would double-count.
 */
export function mergeIncomeStreams(
  paystubStreams: RecurringIncomeStream[],
  inferredStreams: RecurringIncomeStream[],
  opts: { tolerancePct?: number } = {}
): RecurringIncomeStream[] {
  const tol = opts.tolerancePct ?? 0.05
  const paystubNets = paystubStreams.map((s) => Math.abs(s.medianAmount)).filter((a) => a > 0)
  const kept = inferredStreams.filter((inf) => {
    const amt = Math.abs(inf.medianAmount)
    return !paystubNets.some((net) => Math.abs(amt - net) <= net * tol)
  })
  return [...paystubStreams, ...kept]
}

/** Read the stored paystubs for the forecast/summary. Empty on older installs (table-less). */
export function readArgylePaystubs(sqlite: SqliteForForecast): PaystubRow[] {
  try {
    return sqlite
      .prepare(
        `SELECT employer,
                gross_pay    AS grossPay,
                net_pay      AS netPay,
                withholding,
                deductions,
                currency,
                period_start AS periodStart,
                period_end   AS periodEnd,
                paid_at      AS paidAt,
                pay_cycle    AS payCycle
           FROM argyle_paystubs`
      )
      .all() as PaystubRow[]
  } catch {
    return []
  }
}

// ── Income summary (aggregates-only surface for the UI + MCP) ───────────────────

export type IncomeSource = {
  employer: string
  currency: string
  cadence: Cadence
  annualizedGross: number | null
  annualizedNet: number
  effectiveWithholdingRate: number | null // 0..1, Σwithholding / Σgross
  lastPaidAt: string
  nextExpectedPayday: string | null
  paystubs: number
}

export type IncomeSummary = {
  hasPaystubs: boolean
  sources: IncomeSource[]
  totalAnnualizedNet: number
  totalAnnualizedGross: number | null
  blendedWithholdingRate: number | null // 0..1 across all sources
}

function addDaysStr(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Next payday estimate: step forward from the last paystub until strictly after `today`. */
function nextPayday(lastPaidAt: string, cadence: Cadence, today: string): string {
  const step = CADENCE_STEP_DAYS[cadence]
  let next = addDaysStr(lastPaidAt, step)
  let guard = 0
  while (next <= today && guard++ < 400) next = addDaysStr(next, step)
  return next
}

/**
 * Aggregates-only income summary over stored paystubs: per-employer annualized gross/net,
 * effective withholding rate, cadence, and next expected payday. No raw paystub lines or
 * per-tax detail — safe for the MCP boundary (payroll = aggregates-only).
 */
export function buildIncomeSummary(
  sqlite: SqliteForForecast,
  opts: { today?: string } = {}
): IncomeSummary {
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const paystubs = readArgylePaystubs(sqlite)
  const sources: IncomeSource[] = []
  let totalNet = 0
  let totalGross = 0
  let totalWithholding = 0
  let anyGross = false

  for (const g of groupPaystubs(paystubs)) {
    const paidDates = g.rows.map((r) => r.paidAt as string).sort()
    const cadence = cadenceFromCycle(g.rows[0].payCycle) ?? cadenceFromGaps(paidDates)
    if (!cadence) continue
    const perYear = CADENCE_PER_YEAR[cadence]
    const medNet = median(g.rows.map((r) => r.netPay as number))
    const grossVals = g.rows.map((r) => r.grossPay).filter((v): v is number => v != null && v > 0)
    const medGross = grossVals.length ? median(grossVals) : null
    const sumGross = grossVals.reduce((a, b) => a + b, 0)
    const sumWithholding = g.rows
      .map((r) => r.withholding)
      .filter((v): v is number => v != null)
      .reduce((a, b) => a + b, 0)
    const effRate = sumGross > 0 ? Math.min(1, Math.max(0, sumWithholding / sumGross)) : null

    const annualizedNet = Math.round(medNet * perYear)
    const annualizedGross = medGross != null ? Math.round(medGross * perYear) : null
    sources.push({
      employer: g.employer,
      currency: g.currency,
      cadence,
      annualizedGross,
      annualizedNet,
      effectiveWithholdingRate: effRate,
      lastPaidAt: paidDates[paidDates.length - 1],
      nextExpectedPayday: nextPayday(paidDates[paidDates.length - 1], cadence, today),
      paystubs: g.rows.length
    })
    totalNet += annualizedNet
    if (annualizedGross != null) {
      totalGross += annualizedGross
      anyGross = true
    }
    totalWithholding += sumWithholding * (perYear / g.rows.length)
  }

  sources.sort((a, b) => b.annualizedNet - a.annualizedNet)
  return {
    hasPaystubs: sources.length > 0,
    sources,
    totalAnnualizedNet: Math.round(totalNet),
    totalAnnualizedGross: anyGross ? Math.round(totalGross) : null,
    blendedWithholdingRate: totalGross > 0 ? Math.min(1, totalWithholding / totalGross) : null
  }
}
