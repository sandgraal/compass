/**
 * Proactive insights — Phase 7 Track E, expanded by the data-access policy's
 * cross-domain wiring.
 *
 * One read-only aggregator (`insights:get`) that scans local data for things
 * worth surfacing before the user goes looking. Two families:
 *  - SINGLE-DOMAIN nudges: spending anomalies, uncategorized buildup, habit
 *    slippage, stale notes, off-track goals, renewals, paycheck/utility spikes.
 *  - CROSS-DOMAIN correlations (the leverage layer the unified `records` spine
 *    unlocked): unused subscriptions (subs × media-usage records), sleep vs.
 *    discretionary spend (apple-health × finance), savings rate (paystubs ×
 *    finance), and medical out-of-pocket (medical records × finance).
 * Pure detectors over the DB — no network, no LLM, no writes.
 *
 * `buildInsights(db, now)` is exported for tests (same pattern as
 * `buildMorningBrief`). Thresholds are exported consts so tests pin them.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm'
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
  records,
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
    // Cross-domain (leverage layer) — each joins ≥2 domains on the spine.
    | 'unused-subscription'
    | 'sleep-vs-spend'
    | 'savings-rate'
    | 'medical-out-of-pocket'
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

// ── Cross-domain thresholds ─────────────────────────────────────────────────
/** Unused subscription: an active streaming sub with 0 usage records in N days. */
export const UNUSED_SUB_DAYS = 60
export const UNUSED_SUB_MAX = 4
/** Sleep vs spend: need ≥ N full weeks of overlap; low-sleep weeks must average
 *  ≥ this much MORE discretionary spend than high-sleep weeks to surface. */
export const SLEEP_SPEND_MIN_WEEKS = 6
export const SLEEP_SPEND_MIN_DELTA = 40
/** Savings rate: need ≥ N prior months; latest rate must drop this many points
 *  below the trailing average to flag. Rates are fractions (0.2 = 20%). */
export const SAVINGS_MIN_MONTHS = 3
export const SAVINGS_DROP_POINTS = 0.1
/** Medical out-of-pocket: health spend within this window after an encounter. */
export const MEDICAL_OOP_LOOKBACK_DAYS = 90
export const MEDICAL_OOP_WINDOW_DAYS = 14
export const MEDICAL_OOP_MIN_TOTAL = 40
export const MEDICAL_OOP_MAX = 3

const EXCLUDED_ANOMALY_CATEGORIES = new Set(['Transfers', 'Transfer', 'Uncategorized'])

/** Discretionary categories the sleep×spend detector watches (impulse-sensitive). */
const DISCRETIONARY_CATEGORIES = new Set([
  'Dining',
  'Restaurants',
  'Food & Drink',
  'Entertainment',
  'Shopping',
  'Coffee',
  'Bars',
  'Alcohol'
])

/** Health-spend match for the medical out-of-pocket detector (category OR description). */
const HEALTH_SPEND_RE =
  /\b(pharmacy|medical|health|clinic|doctor|hospital|dental|dentist|optom|vision|rx|drug\s?store|walgreens|cvs|labcorp|quest)\b/i

/**
 * Which media-usage records "count" as using a subscription. Keyed by a
 * name-match against the subscription — only sources we actually recognize on
 * the spine, so a match is meaningful (no false "unused" on data we never see).
 */
const STREAMING_USAGE: Array<{ match: RegExp; sources: string[]; types: string[] }> = [
  { match: /netflix/i, sources: ['netflix'], types: ['watch'] },
  { match: /spotify/i, sources: ['spotify'], types: ['listen'] },
  { match: /you\s?tube/i, sources: ['youtube'], types: ['watch'] },
  { match: /prime\s?video|amazon\s?prime/i, sources: ['prime-video'], types: ['watch'] },
  { match: /kindle|prime\s?reading/i, sources: ['kindle'], types: ['read'] },
  { match: /amazon\s?music/i, sources: ['amazon-music'], types: ['listen', 'like', 'save'] }
]
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
  const median = trailing.length % 2 === 0 ? (trailing[mid - 1] + trailing[mid]) / 2 : trailing[mid]
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

// ── Cross-domain detectors (the leverage layer) ─────────────────────────────

/** Monday (local) of the week containing `d`, as 'YYYY-MM-DD' — the week bucket key. */
function weekKey(d: Date): string {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7)) // back up to Monday
  return localYmd(m)
}

/**
 * Active streaming subscriptions the user pays for but hasn't USED in the
 * window — subscriptions × the media-usage records now on the spine. Only
 * checks services we actually recognize (STREAMING_USAGE), so "0 uses" means
 * "we'd have seen it and didn't," not "we're blind to this one."
 */
function detectUnusedSubscriptions(db: Db, now: Date): Insight[] {
  const subs = db
    .select({ name: subscriptions.name, cost: subscriptions.cost, cadence: subscriptions.cadence })
    .from(subscriptions)
    .where(eq(subscriptions.status, 'active'))
    .all()
  if (subs.length === 0) return []
  const since = new Date(now.getTime() - UNUSED_SUB_DAYS * 24 * 3600 * 1000)
  const out: Insight[] = []
  for (const sub of subs) {
    const map = STREAMING_USAGE.find((m) => m.match.test(sub.name))
    if (!map) continue // not a service we can verify usage for → don't guess
    const used = db
      .select({ id: records.id })
      .from(records)
      .where(
        and(
          inArray(records.source, map.sources),
          inArray(records.type, map.types),
          gte(records.occurredAt, since)
        )
      )
      .limit(1)
      .all()
    if (used.length > 0) continue
    out.push({
      kind: 'unused-subscription',
      severity: 'info',
      title: `Paying for ${sub.name} but not using it`,
      detail: `${money(sub.cost)}/${sub.cadence} — no activity in the last ${UNUSED_SUB_DAYS} days. Worth a cancel or a pause.`,
      route: '/subscriptions'
    })
    if (out.length >= UNUSED_SUB_MAX) break
  }
  return out
}

/**
 * Sleep (apple-health) vs discretionary spend (finance), bucketed by week:
 * do the weeks you sleep least line up with heavier impulse spending? A
 * correlation nudge, not a causal claim — surfaces only with enough overlap.
 */
function detectSleepVsSpend(db: Db, now: Date): Insight[] {
  const since = new Date(now.getTime() - (SLEEP_SPEND_MIN_WEEKS + 2) * 7 * 24 * 3600 * 1000)
  const sinceYmd = localYmd(since)
  // Sleep hours per week (payload.ms → hours), from the apple-health sleep records.
  const sleepRows = db
    .select({ occurredAt: records.occurredAt, payload: records.payload })
    .from(records)
    .where(
      and(
        eq(records.source, 'apple-health'),
        eq(records.type, 'sleep'),
        gte(records.occurredAt, since)
      )
    )
    .all()
  const sleepByWeek = new Map<string, number>()
  for (const r of sleepRows) {
    if (!r.occurredAt) continue
    let ms = 0
    try {
      ms = Number((JSON.parse(r.payload ?? '{}') as { ms?: number }).ms) || 0
    } catch {
      ms = 0
    }
    const k = weekKey(r.occurredAt)
    sleepByWeek.set(k, (sleepByWeek.get(k) ?? 0) + ms / 3_600_000)
  }
  // Discretionary spend per week.
  const txns = db
    .select({
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      category: financeTransactions.category
    })
    .from(financeTransactions)
    .where(and(gte(financeTransactions.date, sinceYmd), lt(financeTransactions.amount, 0)))
    .all()
  const spendByWeek = new Map<string, number>()
  for (const t of txns) {
    if (!DISCRETIONARY_CATEGORIES.has(t.category ?? '')) continue
    const d = new Date(`${t.date}T00:00:00`)
    if (Number.isNaN(d.getTime())) continue
    const k = weekKey(d)
    spendByWeek.set(k, (spendByWeek.get(k) ?? 0) + Math.abs(t.amount))
  }
  // Weeks present in BOTH series.
  const weeks = [...sleepByWeek.keys()].filter((k) => spendByWeek.has(k))
  if (weeks.length < SLEEP_SPEND_MIN_WEEKS) return []
  const paired = weeks.map((k) => ({
    sleep: sleepByWeek.get(k) as number,
    spend: spendByWeek.get(k) as number
  }))
  const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
  // Split on the MEAN, not the median: sleep is often bimodal (good weeks vs
  // bad weeks), and a median can land exactly on the low cluster and empty one
  // side. The mean sits between the clusters and separates them cleanly.
  const meanSleep = avg(paired.map((p) => p.sleep))
  const low = paired.filter((p) => p.sleep < meanSleep)
  const high = paired.filter((p) => p.sleep >= meanSleep)
  if (low.length === 0 || high.length === 0) return []
  const lowSpend = avg(low.map((p) => p.spend))
  const highSpend = avg(high.map((p) => p.spend))
  const delta = lowSpend - highSpend
  if (delta < SLEEP_SPEND_MIN_DELTA) return []
  return [
    {
      kind: 'sleep-vs-spend',
      severity: 'info',
      title: `Your low-sleep weeks cost you ${money(delta)} more`,
      detail: `Across ${weeks.length} weeks, the ones you slept least averaged ${money(lowSpend)} in discretionary spend vs ${money(highSpend)} on your better-rested weeks.`,
      route: '/health'
    }
  ]
}

/**
 * Savings rate = (net income − expenses) / net income, per month, from
 * paystubs × finance. Flags when the latest complete month drops materially
 * below the trailing average.
 */
function detectSavingsRate(db: Db, now: Date): Insight[] {
  const thisMonth = localYm(now)
  const stubs = db
    .select({ netPay: argylePaystubs.netPay, paidAt: argylePaystubs.paidAt })
    .from(argylePaystubs)
    .where(and(isNotNull(argylePaystubs.netPay), isNotNull(argylePaystubs.paidAt)))
    .all()
  if (stubs.length === 0) return []
  const incomeByMonth = new Map<string, number>()
  for (const s of stubs) {
    const ym = (s.paidAt as string).slice(0, 7)
    incomeByMonth.set(ym, (incomeByMonth.get(ym) ?? 0) + (s.netPay as number))
  }
  const months = [...incomeByMonth.keys()].filter((ym) => ym < thisMonth).sort()
  if (months.length === 0) return []
  const startDate = `${months[0]}-01`
  const endDate = `${thisMonth}-01`

  const txns = db
    .select({
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      category: financeTransactions.category
    })
    .from(financeTransactions)
    .where(
      and(
        gte(financeTransactions.date, startDate),
        lt(financeTransactions.date, endDate),
        lt(financeTransactions.amount, 0)
      )
    )
    .all()
  const expenseByMonth = new Map<string, number>()
  for (const t of txns) {
    if (EXCLUDED_ANOMALY_CATEGORIES.has(t.category ?? 'Uncategorized')) continue
    const ym = t.date.slice(0, 7)
    expenseByMonth.set(ym, (expenseByMonth.get(ym) ?? 0) + Math.abs(t.amount))
  }
  // Rate per month that has income, EXCLUDING the current (incomplete) month.
  const rates = [...incomeByMonth.keys()]
    .filter((ym) => ym < thisMonth && (incomeByMonth.get(ym) as number) > 0)
    .sort()
    .map((ym) => ({
      ym,
      rate: 1 - (expenseByMonth.get(ym) ?? 0) / (incomeByMonth.get(ym) as number)
    }))
  if (rates.length < SAVINGS_MIN_MONTHS + 1) return []
  const latest = rates[rates.length - 1]
  const prior = rates.slice(0, -1)
  const trailing = prior.reduce((s, r) => s + r.rate, 0) / prior.length
  if (latest.rate >= trailing - SAVINGS_DROP_POINTS) return []
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  return [
    {
      kind: 'savings-rate',
      severity: 'warn',
      title: `You saved ${pct(latest.rate)} of income last month`,
      detail: `Down from a ${pct(trailing)} trailing average over the prior ${prior.length} months — expenses are eating more of your take-home.`,
      route: '/finance'
    }
  ]
}

/**
 * Medical encounters (now on the spine) followed by health-category spend —
 * the out-of-pocket cost of a visit, which no single domain could show.
 */
function detectMedicalOutOfPocket(db: Db, now: Date): Insight[] {
  const since = new Date(now.getTime() - MEDICAL_OOP_LOOKBACK_DAYS * 24 * 3600 * 1000)
  const events = db
    .select({ occurredAt: records.occurredAt, title: records.title, type: records.type })
    .from(records)
    .where(
      and(
        eq(records.source, 'medical'),
        inArray(records.type, ['encounter', 'procedure', 'condition']),
        gte(records.occurredAt, since)
      )
    )
    .orderBy(asc(records.occurredAt))
    .all()
  if (events.length === 0) return []
  const spend = db
    .select({
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      category: financeTransactions.category,
      description: financeTransactions.description
    })
    .from(financeTransactions)
    .where(and(gte(financeTransactions.date, localYmd(since)), lt(financeTransactions.amount, 0)))
    .all()
    .filter(
      (t) => HEALTH_SPEND_RE.test(t.category ?? '') || HEALTH_SPEND_RE.test(t.description ?? '')
    )
  if (spend.length === 0) return []
  const out: Insight[] = []
  for (const ev of events) {
    if (!ev.occurredAt) continue
    const start = ev.occurredAt.getTime()
    const end = start + MEDICAL_OOP_WINDOW_DAYS * 24 * 3600 * 1000
    let total = 0
    for (const t of spend) {
      const td = new Date(`${t.date}T00:00:00`).getTime()
      if (td >= start && td <= end) total += Math.abs(t.amount)
    }
    if (total < MEDICAL_OOP_MIN_TOTAL) continue
    out.push({
      kind: 'medical-out-of-pocket',
      severity: 'info',
      title: `${money(total)} in health charges after "${ev.title}"`,
      detail: `Your ${localYmd(ev.occurredAt)} ${ev.type} was followed by ${money(total)} in pharmacy/medical spend within ${MEDICAL_OOP_WINDOW_DAYS} days.`,
      route: '/health'
    })
    if (out.length >= MEDICAL_OOP_MAX) break
  }
  return out
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
    ...safeDetect(() => detectUtilitySpikes(db)),
    // Cross-domain — each reads the spine + a domain table, so safeDetect guards
    // an older DB missing `records`/`subscriptions`/`argyle_paystubs`.
    ...safeDetect(() => detectUnusedSubscriptions(db, now)),
    ...safeDetect(() => detectSleepVsSpend(db, now)),
    ...safeDetect(() => detectSavingsRate(db, now)),
    ...safeDetect(() => detectMedicalOutOfPocket(db, now))
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
