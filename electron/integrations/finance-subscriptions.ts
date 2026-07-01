/**
 * Subscription audit — detects recurring charges, computes annualized cost,
 * and surfaces zombies (no charge in 60-180 days but historically recurring)
 * + duplicates (same merchant on multiple accounts) + price-bump suspects.
 *
 * Filters to subscription-like categories so groceries/restaurants don't
 * pollute the result. Only-monthly/weekly/biweekly/quarterly/semi-annual/yearly
 * cadences get reported; "irregular" is dropped.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { type Cadence, PER_YEAR, detectCadence, median, normalizeMerchant } from '../lib/normalize'

export type { Cadence }

const SUB_CATEGORIES = new Set([
  'Subscriptions',
  'Housing', // phone, internet, utilities — recurring fees
  'Insurance',
  'Education',
  'Charity',
  'Gifts',
  'Entertainment',
  'Fees'
])

export type SubscriptionStatus = 'active' | 'zombie' | 'expired'

export type Subscription = {
  merchant: string
  account: string
  category: string
  subcategory: string
  cadence: Cadence
  medianAmount: number
  minAmount: number
  maxAmount: number
  annualCost: number
  firstSeen: string
  lastSeen: string
  daysSinceLast: number
  nCharges: number
  status: SubscriptionStatus
  // True if max - min crosses 50% of the median: a coarse "amounts vary"
  // signal that captures both genuine hikes and noisy promotional charges.
  priceBump: boolean
  // Recent-vs-historical price-hike detection (May 2026 strategic review
  // Tier 2 #8). Splits the charge stream into the last N charges (recent)
  // vs everything before (historical). When the recent median is materially
  // higher than the historical median we mark `priceHike: true` and report
  // the delta + pct so the UI can surface a "+$X / +Y%" badge.
  priceHike: boolean
  priceHikeDelta: number
  priceHikePct: number
  recentMedian: number
  historicalMedian: number
}

export type SubscriptionAudit = {
  totalActiveAnnual: number
  active: Subscription[]
  zombies: Subscription[]
  expired: Subscription[]
  duplicates: { merchant: string; accounts: string[]; combinedAnnual: number }[]
}

export function auditSubscriptions(
  db: BetterSQLite3Database<typeof schema>,
  options: { today?: Date; activeWindowDays?: number; zombieWindowDays?: number } = {}
): SubscriptionAudit {
  const today = options.today ?? new Date()
  const activeWindow = options.activeWindowDays ?? 60
  const zombieWindow = options.zombieWindowDays ?? 180

  // Pull rows from sub-like categories, expenses only.
  const rows = db
    .select({
      date: schema.financeTransactions.date,
      amount: schema.financeTransactions.amount,
      description: schema.financeTransactions.description,
      account: schema.financeTransactions.accountId,
      category: schema.financeTransactions.category,
      subcategory: schema.financeTransactions.subcategory
    })
    .from(schema.financeTransactions)
    .all()

  // Resolve account names (the FK lookup once)
  const accounts = db.select().from(schema.financeAccounts).all()
  const accountById = new Map(accounts.map((a) => [a.id, a.name]))

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    if (r.amount >= 0) continue
    const cat = r.category ?? 'Uncategorized'
    if (!SUB_CATEGORIES.has(cat)) continue
    if ((r.subcategory ?? '') === 'Interest') continue // CC interest, not a sub
    const m = normalizeMerchant(r.description)
    if (!m) continue
    const acctName = (r.account != null && accountById.get(r.account)) || '—'
    const key = `${m}::${acctName}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const subs: Subscription[] = []
  for (const [key, entries] of groups) {
    if (entries.length < 3) continue
    const sorted = entries.sort((a, b) => a.date.localeCompare(b.date))
    const dates = sorted.map((e) => new Date(e.date))
    const cadence = detectCadence(dates)
    if (!cadence) continue
    const amounts = sorted.map((e) => Math.abs(e.amount))
    const med = median(amounts)
    const min = Math.min(...amounts)
    const max = Math.max(...amounts)
    const last = dates[dates.length - 1]
    const daysSinceLast = Math.floor((today.getTime() - last.getTime()) / 86400000)
    let status: SubscriptionStatus
    if (daysSinceLast > zombieWindow) status = 'expired'
    else if (daysSinceLast > activeWindow) status = 'zombie'
    else status = 'active'
    const priceBump = max - min > 0.5 * med && med > 5

    // Recent-vs-historical hike: split off the last ~3 charges (or 1/3 of
    // the stream when shorter) and compare medians. Threshold: > $0.50 of
    // absolute delta AND > 8% relative — anything below is plausibly tax
    // / surcharge drift, not a real price increase.
    const recentCount = Math.max(1, Math.min(3, Math.floor(amounts.length / 3)))
    const recentAmounts = amounts.slice(-recentCount)
    const historicalAmounts = amounts.slice(0, amounts.length - recentCount)
    const recentMedian = median(recentAmounts)
    const historicalMedian = historicalAmounts.length > 0 ? median(historicalAmounts) : recentMedian
    const priceHikeDelta = recentMedian - historicalMedian
    const priceHikePct = historicalMedian > 0 ? (priceHikeDelta / historicalMedian) * 100 : 0
    const priceHike =
      historicalAmounts.length > 0 &&
      priceHikeDelta > 0.5 &&
      priceHikePct > 8 &&
      historicalMedian > 1

    const [merchant, account] = key.split('::')
    subs.push({
      merchant,
      account,
      category: sorted[0].category ?? 'Uncategorized',
      subcategory: sorted[0].subcategory ?? '',
      cadence,
      medianAmount: Math.round(med * 100) / 100,
      minAmount: Math.round(min * 100) / 100,
      maxAmount: Math.round(max * 100) / 100,
      annualCost: Math.round(med * PER_YEAR[cadence] * 100) / 100,
      firstSeen: sorted[0].date,
      lastSeen: sorted[sorted.length - 1].date,
      daysSinceLast,
      nCharges: entries.length,
      status,
      priceBump,
      priceHike,
      priceHikeDelta: Math.round(priceHikeDelta * 100) / 100,
      priceHikePct: Math.round(priceHikePct * 10) / 10,
      recentMedian: Math.round(recentMedian * 100) / 100,
      historicalMedian: Math.round(historicalMedian * 100) / 100
    })
  }

  subs.sort((a, b) => b.annualCost - a.annualCost)
  const active = subs.filter((s) => s.status === 'active')
  const zombies = subs.filter((s) => s.status === 'zombie')
  const expired = subs.filter((s) => s.status === 'expired')

  // Duplicates: same merchant key on >1 account.
  const byMerchant = new Map<string, Subscription[]>()
  for (const s of subs) {
    if (!byMerchant.has(s.merchant)) byMerchant.set(s.merchant, [])
    byMerchant.get(s.merchant)!.push(s)
  }
  const duplicates: SubscriptionAudit['duplicates'] = []
  for (const [m, list] of byMerchant) {
    if (list.length < 2) continue
    duplicates.push({
      merchant: m,
      accounts: list.map((s) => s.account),
      combinedAnnual: Math.round(list.reduce((sum, s) => sum + s.annualCost, 0) * 100) / 100
    })
  }
  duplicates.sort((a, b) => b.combinedAnnual - a.combinedAnnual)

  return {
    totalActiveAnnual: Math.round(active.reduce((sum, s) => sum + s.annualCost, 0) * 100) / 100,
    active,
    zombies,
    expired,
    duplicates
  }
}

// Exported for unit tests on pure helpers.
export const _internal = { normalizeMerchant, detectCadence, median }
