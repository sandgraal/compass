/**
 * Proactive insights — Phase 7 Track E, expanded by the data-access policy's
 * cross-domain wiring.
 *
 * One read-only aggregator (`insights:get`) that scans local data for things
 * worth surfacing before the user goes looking: category spending anomalies,
 * uncategorized-spend buildup, habit slippage, stale notes, off-track savings
 * goals, upcoming renewals (assets + subscriptions), paycheck anomalies, and
 * utility-bill spikes. Pure detectors over the DB — no network, no LLM, no
 * writes.
 *
 * `buildInsights(db, now)` is exported for tests (same pattern as
 * `buildMorningBrief`). Thresholds are exported consts so tests pin them.
 */
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import {
  argylePaystubs,
  assets,
  financeTransactions,
  financialGoals,
  habitEntries,
  habits,
  knowledgeFiles,
  subscriptions,
  utilityBills
} from '../db/schema'
import { localYm, localYmd } from '../lib/dates'

export interface Insight {
  kind:
    | 'spending-anomaly'
    | 'uncategorized-spend'
    | 'habit-slippage'
    | 'stale-notes'
    | 'goal-off-track'
    | 'renewal-due'
    | 'paycheck-anomaly'
    | 'utility-spike'
  severity: 'info' | 'warn'
  title: string
  detail: string
  /** Renderer route the insight links to. */
  route: string
}

export interface InsightsResult {
  generatedAt: string
  insights: Insight[]
}

// ── Thresholds (exported so tests pin behavior, not magic numbers) ──────────

/** Current-month category spend must be ≥ this multiple of the 3-month avg. */
export const ANOMALY_RATIO = 1.5
/** …AND at least this many dollars over the average (filters tiny categories). */
export const ANOMALY_MIN_DELTA = 50
/** Max anomaly insights per run (top by dollar delta). */
export const ANOMALY_MAX = 3
/** Uncategorized lookback window (days) and trigger floor. */
export const UNCATEGORIZED_DAYS = 60
export const UNCATEGORIZED_MIN_COUNT = 5
export const UNCATEGORIZED_MIN_TOTAL = 100
/** Habit slippage: prior-3-weeks completion rate floor + this-week ceiling. */
export const SLIPPAGE_PRIOR_RATE = 0.5
export const SLIPPAGE_WEEK_MAX = 1
/** Stale notes: untouched for this many days (user-authored, non-mirror). */
export const STALE_NOTE_DAYS = 90
/** Goal off-track: required monthly must exceed planned by this ratio. */
export const GOAL_OFF_TRACK_RATIO = 1.25
/** Renewals (assets + subscriptions) due within this many days. */
export const RENEWAL_WINDOW_DAYS = 30
/** Paycheck anomaly: |net − trailing median| must exceed both of these. */
export const PAYCHECK_DEVIATION_RATIO = 0.1
export const PAYCHECK_MIN_DELTA = 100
/** Utility spike: latest bill vs the provider's trailing average. */
export const UTILITY_SPIKE_RATIO = 1.5
export const UTILITY_MIN_DELTA = 25

const EXCLUDED_ANOMALY_CATEGORIES = new Set(['Transfers', 'Transfer', 'Uncategorized'])
/** Mirror namespaces (Notion/Obsidian imports) aren't user-authored notes. */
const MIRROR_PREFIXES = ['notion/', 'obsidian/']

type Db = ReturnType<typeof getDb>

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return localYm(d)
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

// ── Detectors ────────────────────────────────────────────────────────────────

function detectSpendingAnomalies(db: Db, now: Date): Insight[] {
  const thisMonth = localYm(now)
  const baselineStart = `${addMonths(thisMonth, -3)}-01`
  const monthStart = `${thisMonth}-01`

  // One slice covers both the 3-month baseline and the current month.
  const rows = db
    .select({
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      category: financeTransactions.category
    })
    .from(financeTransactions)
    .where(and(gte(financeTransactions.date, baselineStart), lt(financeTransactions.amount, 0)))
    .all()

  const baseline = new Map<string, number>()
  const current = new Map<string, number>()
  for (const r of rows) {
    const cat = r.category ?? 'Uncategorized'
    if (EXCLUDED_ANOMALY_CATEGORIES.has(cat)) continue
    const spend = Math.abs(r.amount)
    if (r.date >= monthStart) {
      current.set(cat, (current.get(cat) ?? 0) + spend)
    } else {
      baseline.set(cat, (baseline.get(cat) ?? 0) + spend)
    }
  }

  const flagged: Array<{ cat: string; spent: number; avg: number; delta: number }> = []
  for (const [cat, spent] of current) {
    const avg = (baseline.get(cat) ?? 0) / 3
    if (avg <= 0) continue
    // Partial month vs full-month average: under-flags early in the month,
    // which is the conservative direction — a partial month already ≥150%
    // of a FULL month's average is a strong signal.
    if (spent >= avg * ANOMALY_RATIO && spent - avg >= ANOMALY_MIN_DELTA) {
      flagged.push({ cat, spent, avg, delta: spent - avg })
    }
  }
  flagged.sort((a, b) => b.delta - a.delta)

  return flagged.slice(0, ANOMALY_MAX).map(({ cat, spent, avg }) => ({
    kind: 'spending-anomaly' as const,
    severity: 'warn' as const,
    title: `${cat} spending is up ${Math.round((spent / avg - 1) * 100)}% this month`,
    detail: `${money(spent)} so far vs a ${money(avg)}/month average — ${money(spent - avg)} over.`,
    route: '/finance'
  }))
}

function detectUncategorizedSpend(db: Db, now: Date): Insight[] {
  const since = localYmd(new Date(now.getTime() - UNCATEGORIZED_DAYS * 24 * 60 * 60 * 1000))
  const rows = db
    .select({ amount: financeTransactions.amount })
    .from(financeTransactions)
    .where(
      and(
        gte(financeTransactions.date, since),
        // Legacy rows can carry NULL instead of the 'Uncategorized' default.
        or(eq(financeTransactions.category, 'Uncategorized'), isNull(financeTransactions.category)),
        lt(financeTransactions.amount, 0)
      )
    )
    .all()
  const total = rows.reduce((sum, r) => sum + Math.abs(r.amount), 0)
  if (rows.length < UNCATEGORIZED_MIN_COUNT && total < UNCATEGORIZED_MIN_TOTAL) return []
  return [
    {
      kind: 'uncategorized-spend',
      severity: 'info',
      title: `${money(total)} of spending is uncategorized`,
      detail: `${rows.length} transaction${rows.length === 1 ? '' : 's'} in the last ${UNCATEGORIZED_DAYS} days have no category — budgets and tax tags miss them.`,
      route: '/finance'
    }
  ]
}

function detectHabitSlippage(db: Db, now: Date): Insight[] {
  const activeHabits = db.select().from(habits).where(eq(habits.active, true)).all()
  if (activeHabits.length === 0) return []

  const dayMs = 24 * 60 * 60 * 1000
  const weekAgo = localYmd(new Date(now.getTime() - 7 * dayMs))
  // Exactly 21 prior-window dates: (now-27 … now-7) inclusive under the
  // gte filter — 28 would make it 22 and inflate the prior rate.
  const priorStart = localYmd(new Date(now.getTime() - 27 * dayMs))
  const today = localYmd(now)

  const insights: Insight[] = []
  for (const habit of activeHabits) {
    if (habit.id == null) continue
    const entries = db
      .select({ date: habitEntries.date, completed: habitEntries.completed })
      .from(habitEntries)
      .where(and(eq(habitEntries.habitId, habit.id), gte(habitEntries.date, priorStart)))
      .all()
    let priorDone = 0
    let weekDone = 0
    for (const e of entries) {
      if (!e.completed || e.date > today) continue
      if (e.date > weekAgo) weekDone++
      else priorDone++
    }
    const priorRate = priorDone / 21
    if (priorRate >= SLIPPAGE_PRIOR_RATE && weekDone <= SLIPPAGE_WEEK_MAX) {
      insights.push({
        kind: 'habit-slippage',
        severity: 'warn',
        title: `${habit.name} is slipping`,
        detail: `${weekDone} check-in${weekDone === 1 ? '' : 's'} this week vs ${Math.round(priorRate * 100)}% over the prior three weeks.`,
        route: '/monthly'
      })
    }
  }
  return insights
}

function detectStaleNotes(db: Db, now: Date): Insight[] {
  const cutoff = new Date(now.getTime() - STALE_NOTE_DAYS * 24 * 60 * 60 * 1000)
  const rows = db
    .select({
      path: knowledgeFiles.path,
      title: knowledgeFiles.title,
      lastModified: knowledgeFiles.lastModified
    })
    .from(knowledgeFiles)
    .where(eq(knowledgeFiles.autoUpdated, false))
    .all()
  const stale = rows
    .filter(
      (r) =>
        r.lastModified != null &&
        r.lastModified < cutoff &&
        !MIRROR_PREFIXES.some((p) => r.path.startsWith(p)) &&
        !r.path.startsWith('templates/')
    )
    .sort((a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0))
  if (stale.length === 0) return []
  const top = stale.slice(0, 3).map((r) => r.title)
  return [
    {
      kind: 'stale-notes',
      severity: 'info',
      title: `${stale.length} note${stale.length === 1 ? '' : 's'} untouched for ${STALE_NOTE_DAYS}+ days`,
      detail: `Oldest: ${top.join(', ')}. Worth a review or an archive.`,
      route: '/knowledge'
    }
  ]
}

/**
 * Manual-source savings goals whose planned monthly contribution can't reach
 * the target by its date. (Auto-linked goals track live aggregates and need
 * the finance engines to resolve a current value — the Goals page covers those.)
 */
function detectGoalsOffTrack(db: Db, now: Date): Insight[] {
  const today = localYmd(now)
  const rows = db
    .select({
      name: financialGoals.name,
      targetAmount: financialGoals.targetAmount,
      targetDate: financialGoals.targetDate,
      manualCurrent: financialGoals.manualCurrent,
      monthlyContribution: financialGoals.monthlyContribution
    })
    .from(financialGoals)
    .where(and(eq(financialGoals.source, 'manual'), isNotNull(financialGoals.targetDate)))
    .all()
  const insights: Insight[] = []
  for (const g of rows) {
    if (!g.targetDate || g.targetDate <= today) continue
    const needed = g.targetAmount - g.manualCurrent
    if (needed <= 0) continue
    const monthsLeft = Math.max(
      1,
      (new Date(`${g.targetDate}T00:00:00`).getTime() - now.getTime()) / (30.44 * 24 * 3600 * 1000)
    )
    const requiredMonthly = needed / monthsLeft
    if (
      g.monthlyContribution <= 0 ||
      requiredMonthly >= g.monthlyContribution * GOAL_OFF_TRACK_RATIO
    ) {
      insights.push({
        kind: 'goal-off-track',
        severity: 'warn',
        title: `"${g.name}" is off track`,
        detail: `Needs ${money(requiredMonthly)}/month to hit ${money(g.targetAmount)} by ${g.targetDate}; planned contribution is ${money(g.monthlyContribution)}/month.`,
        route: '/finance'
      })
    }
  }
  return insights
}

/** Assets (insurance, memberships, warranties) + subscriptions renewing soon. */
function detectRenewalsDue(db: Db, now: Date): Insight[] {
  const today = localYmd(now)
  const windowEnd = localYmd(new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 3600 * 1000))
  const dueAssets = db
    .select({ name: assets.name, type: assets.type, renewalDate: assets.renewalDate })
    .from(assets)
    .where(
      and(
        eq(assets.status, 'active'),
        gte(assets.renewalDate, today),
        lte(assets.renewalDate, windowEnd)
      )
    )
    .orderBy(asc(assets.renewalDate))
    .all()
    .map((a) => `${a.name} (${a.type}, ${a.renewalDate})`)
  const dueSubs = db
    .select({
      name: subscriptions.name,
      cost: subscriptions.cost,
      cadence: subscriptions.cadence,
      nextRenewal: subscriptions.nextRenewal
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, 'active'),
        // Only the longer cadences are worth a heads-up — a monthly renewal
        // is routine, an annual one is a decision point.
        or(eq(subscriptions.cadence, 'yearly'), eq(subscriptions.cadence, 'semi-annual')),
        gte(subscriptions.nextRenewal, today),
        lte(subscriptions.nextRenewal, windowEnd)
      )
    )
    .orderBy(asc(subscriptions.nextRenewal))
    .all()
    .map((s) => `${s.name} (${money(s.cost)}/${s.cadence}, ${s.nextRenewal})`)
  const due = [...dueAssets, ...dueSubs]
  if (due.length === 0) return []
  return [
    {
      kind: 'renewal-due',
      severity: 'info',
      title: `${due.length} renewal${due.length === 1 ? '' : 's'} in the next ${RENEWAL_WINDOW_DAYS} days`,
      detail: due.slice(0, 4).join('; ') + (due.length > 4 ? '…' : '.'),
      route: due.length === dueSubs.length ? '/subscriptions' : '/assets'
    }
  ]
}

/** Latest paycheck's net pay deviating from the trailing median. */
function detectPaycheckAnomaly(db: Db): Insight[] {
  const stubs = db
    .select({
      employer: argylePaystubs.employer,
      netPay: argylePaystubs.netPay,
      paidAt: argylePaystubs.paidAt
    })
    .from(argylePaystubs)
    .where(and(isNotNull(argylePaystubs.netPay), isNotNull(argylePaystubs.paidAt)))
    .all()
    .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''))
  if (stubs.length < 3) return [] // not enough history for a meaningful median
  const [latest, ...prior] = stubs
  const trailing = prior
    .slice(0, 6)
    .map((s) => s.netPay as number)
    .sort((a, b) => a - b)
  const mid = Math.floor(trailing.length / 2)
  const median =
    trailing.length % 2 === 0 ? (trailing[mid - 1] + trailing[mid]) / 2 : trailing[mid]
  const latestNet = latest.netPay as number
  const delta = latestNet - median
  if (Math.abs(delta) < PAYCHECK_MIN_DELTA || Math.abs(delta) < median * PAYCHECK_DEVIATION_RATIO) {
    return []
  }
  const dir = delta > 0 ? 'higher' : 'lower'
  return [
    {
      kind: 'paycheck-anomaly',
      severity: 'warn',
      title: `Latest paycheck is ${money(Math.abs(delta))} ${dir} than usual`,
      detail: `${latest.employer ?? 'Your employer'} deposited ${money(latestNet)} on ${latest.paidAt} vs a ${money(median)} trailing median.`,
      route: '/finance'
    }
  ]
}

/** Latest utility statement per provider vs that provider's trailing average. */
function detectUtilitySpikes(db: Db): Insight[] {
  const bills = db
    .select({
      provider: utilityBills.provider,
      amount: utilityBills.amount,
      statementDate: utilityBills.statementDate
    })
    .from(utilityBills)
    .where(and(isNotNull(utilityBills.amount), isNotNull(utilityBills.statementDate)))
    .all()
  const byProvider = new Map<string, Array<{ amount: number; date: string }>>()
  for (const b of bills) {
    const key = b.provider ?? 'Utility'
    const list = byProvider.get(key) ?? []
    list.push({ amount: b.amount as number, date: b.statementDate as string })
    byProvider.set(key, list)
  }
  const insights: Insight[] = []
  for (const [provider, list] of byProvider) {
    if (list.length < 3) continue
    list.sort((a, b) => b.date.localeCompare(a.date))
    const [latest, ...prior] = list
    const baseline = prior.slice(0, 3)
    const avg = baseline.reduce((s, b) => s + b.amount, 0) / baseline.length
    if (avg <= 0) continue
    if (latest.amount >= avg * UTILITY_SPIKE_RATIO && latest.amount - avg >= UTILITY_MIN_DELTA) {
      insights.push({
        kind: 'utility-spike',
        severity: 'warn',
        title: `${provider} bill is up ${Math.round((latest.amount / avg - 1) * 100)}%`,
        detail: `${money(latest.amount)} on ${latest.date} vs a ${money(avg)} average over the prior ${baseline.length} statements.`,
        route: '/finance'
      })
    }
  }
  return insights
}

// ── Aggregator ───────────────────────────────────────────────────────────────

export function buildInsights(db: Db, now: Date = new Date()): InsightsResult {
  const insights: Insight[] = [
    ...detectSpendingAnomalies(db, now),
    ...detectUncategorizedSpend(db, now),
    ...detectHabitSlippage(db, now),
    ...detectStaleNotes(db, now),
    ...safeDetect(() => detectGoalsOffTrack(db, now)),
    ...safeDetect(() => detectRenewalsDue(db, now)),
    ...safeDetect(() => detectPaycheckAnomaly(db)),
    ...safeDetect(() => detectUtilitySpikes(db))
  ]
  // Warnings first, stable within severity (detector order is intentional).
  insights.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1))
  return { generatedAt: now.toISOString(), insights }
}

/**
 * The cross-domain detectors read tables that may not exist on an older DB
 * (goals/assets/subscriptions/paystubs/bills post-date several releases) —
 * a missing table must not take down the whole insights card.
 */
function safeDetect(fn: () => Insight[]): Insight[] {
  try {
    return fn()
  } catch {
    return []
  }
}

export function registerInsightsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('insights:get', (): InsightsResult => {
    return buildInsights(getDb())
  })
}
