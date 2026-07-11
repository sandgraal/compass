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
    | 'dev-productivity-vs-recovery'
    | 'calendar-load-vs-habits'
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
/** Dev productivity vs recovery: commit-day counts × a recovery axis, N-day window.
 *  Heavy = ≥ BUSY commits, quiet = ≤ QUIET (the 2-4 gap is excluded for clean split).
 *  Each axis has its own "meaningful drop" in that axis's worse direction. */
export const DEV_RECOVERY_LOOKBACK_DAYS = 60
export const DEV_RECOVERY_MIN_DAYS = 20
export const DEV_RECOVERY_BUSY_COMMITS = 5
export const DEV_RECOVERY_QUIET_COMMITS = 1
export const DEV_RECOVERY_MIN_GROUP = 5
export const DEV_RECOVERY_READINESS_DROP = 5 // Oura readiness points (higher = better)
export const DEV_RECOVERY_HRV_DROP = 8 // Apple HRV ms (higher = better)
export const DEV_RECOVERY_RHR_RISE = 3 // Apple resting HR bpm (lower = better)
/** Calendar load vs habits: weekly event density × habit-check completion rate.
 *  Heavy weeks must be genuinely busy (≥ MIN_EVENTS); fire when lighter weeks beat
 *  heavier ones on completion rate by ≥ RATE_DROP (fractions, 0.2 = 20 points). */
export const CAL_HABITS_MIN_WEEKS = 6
export const CAL_HABITS_MIN_EVENTS = 5
export const CAL_HABITS_RATE_DROP = 0.2
export const CAL_HABITS_MIN_GROUP = 3

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

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
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
  const mapped = subs
    .map((sub) => ({ sub, map: STREAMING_USAGE.find((m) => m.match.test(sub.name)) }))
    .filter(
      (entry): entry is { sub: (typeof subs)[number]; map: (typeof STREAMING_USAGE)[number] } =>
        Boolean(entry.map)
    )
  if (mapped.length === 0) return []
  const sources = [...new Set(mapped.flatMap((entry) => entry.map.sources))]
  const types = [...new Set(mapped.flatMap((entry) => entry.map.types))]
  const usedPairs = new Set(
    db
      .select({ source: records.source, type: records.type })
      .from(records)
      .where(
        and(
          inArray(records.source, sources),
          inArray(records.type, types),
          gte(records.occurredAt, since)
        )
      )
      .all()
      .map((row) => `${row.source}\u0000${row.type}`)
  )
  const out: Insight[] = []
  for (const { sub, map } of mapped) {
    const used = map.sources.some((source) =>
      map.types.some((type) => usedPairs.has(`${source}\u0000${type}`))
    )
    if (used) continue
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
 * Total sleep per week — apple-health sleep hours when we have enough weeks of
 * it, otherwise Oura's daily sleepScore averaged per week. Apple Health takes
 * precedence; Oura only fills in for users without an Apple Health export, so a
 * wearable-only user still gets the sleep-vs-spend nudge. Both series are
 * "higher = more/better sleep," so the downstream mean-split is identical.
 */
function readSleepByWeek(
  db: Db,
  since: Date
): { byWeek: Map<string, number>; source: 'apple-health' | 'oura' } {
  const ah = new Map<string, number>()
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
  for (const r of sleepRows) {
    if (!r.occurredAt) continue
    let ms = 0
    try {
      ms = Number((JSON.parse(r.payload ?? '{}') as { ms?: number }).ms) || 0
    } catch {
      ms = 0
    }
    const k = weekKey(r.occurredAt)
    ah.set(k, (ah.get(k) ?? 0) + ms / 3_600_000)
  }
  if (ah.size >= SLEEP_SPEND_MIN_WEEKS) return { byWeek: ah, source: 'apple-health' }
  // Fallback: Oura daily sleepScore, averaged per week.
  const ouraRows = db
    .select({ occurredAt: records.occurredAt, payload: records.payload })
    .from(records)
    .where(
      and(eq(records.source, 'oura'), eq(records.type, 'wellness'), gte(records.occurredAt, since))
    )
    .all()
  const acc = new Map<string, { sum: number; n: number }>()
  for (const r of ouraRows) {
    if (!r.occurredAt) continue
    let score: number | null = null
    try {
      const v = (JSON.parse(r.payload ?? '{}') as { sleepScore?: number | null }).sleepScore
      score = v == null ? null : Number(v)
    } catch {
      score = null
    }
    if (score == null || Number.isNaN(score)) continue
    const k = weekKey(r.occurredAt)
    const cur = acc.get(k) ?? { sum: 0, n: 0 }
    cur.sum += score
    cur.n += 1
    acc.set(k, cur)
  }
  const oura = new Map<string, number>()
  for (const [k, { sum, n }] of acc) oura.set(k, sum / n)
  // Oura only wins when Apple Health was too sparse to reach the threshold.
  return oura.size > ah.size
    ? { byWeek: oura, source: 'oura' }
    : { byWeek: ah, source: 'apple-health' }
}

/** Discretionary spend per week (abs of negative txns in the watched categories). */
function readDiscretionarySpendByWeek(db: Db, since: Date): Map<string, number> {
  const sinceYmd = localYmd(since)
  const txns = db
    .select({
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      category: financeTransactions.category
    })
    .from(financeTransactions)
    .where(and(gte(financeTransactions.date, sinceYmd), lt(financeTransactions.amount, 0)))
    .all()
  const byWeek = new Map<string, number>()
  for (const t of txns) {
    if (!DISCRETIONARY_CATEGORIES.has(t.category ?? '')) continue
    const d = new Date(`${t.date}T00:00:00`)
    if (Number.isNaN(d.getTime())) continue
    const k = weekKey(d)
    byWeek.set(k, (byWeek.get(k) ?? 0) + Math.abs(t.amount))
  }
  return byWeek
}

/**
 * Sleep (apple-health, or Oura fallback) vs discretionary spend (finance),
 * bucketed by week: do the weeks you sleep least line up with heavier impulse
 * spending? A correlation nudge, not a causal claim — surfaces only with enough
 * overlap.
 */
function detectSleepVsSpend(db: Db, now: Date): Insight[] {
  const since = new Date(now.getTime() - (SLEEP_SPEND_MIN_WEEKS + 2) * 7 * 24 * 3600 * 1000)
  const { byWeek: sleepByWeek } = readSleepByWeek(db, since)
  const spendByWeek = readDiscretionarySpendByWeek(db, since)
  // Weeks present in BOTH series.
  const weeks = [...sleepByWeek.keys()].filter((k) => spendByWeek.has(k))
  if (weeks.length < SLEEP_SPEND_MIN_WEEKS) return []
  const paired = weeks.map((k) => ({
    sleep: sleepByWeek.get(k) as number,
    spend: spendByWeek.get(k) as number
  }))
  // Split on the MEAN, not the median: sleep is often bimodal (good weeks vs
  // bad weeks), and a median can land exactly on the low cluster and empty one
  // side. The mean sits between the clusters and separates them cleanly.
  const meanSleep = mean(paired.map((p) => p.sleep))
  const low = paired.filter((p) => p.sleep < meanSleep)
  const high = paired.filter((p) => p.sleep >= meanSleep)
  if (low.length === 0 || high.length === 0) return []
  const lowSpend = mean(low.map((p) => p.spend))
  const highSpend = mean(high.map((p) => p.spend))
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
    const start = new Date(`${localYmd(ev.occurredAt)}T00:00:00`).getTime()
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

// ── Dev productivity × recovery ──────────────────────────────────────────────

/** Commits per local day from the github spine (one record per commit). */
function readCommitsByDay(db: Db, since: Date): Map<string, number> {
  const rows = db
    .select({ occurredAt: records.occurredAt })
    .from(records)
    .where(
      and(eq(records.source, 'github'), eq(records.type, 'commit'), gte(records.occurredAt, since))
    )
    .all()
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (!r.occurredAt) continue
    const k = localYmd(r.occurredAt)
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }
  return byDay
}

interface RecoveryAxis {
  byDay: Map<string, number>
  /** Human label for the axis, e.g. "Oura readiness". */
  axis: string
  /** true when a HIGHER value means better recovery (readiness / HRV). */
  betterIsHigher: boolean
  /** Minimum meaningful gap between heavy- and quiet-day means, in axis units. */
  drop: number
}

/**
 * The best available daily recovery signal: Oura readiness → Apple Health HRV →
 * Apple Health resting heart rate. Returns the first axis with ≥ MIN_DAYS days
 * of readings in the window, or null if none is rich enough.
 */
function readRecoveryByDay(db: Db, since: Date): RecoveryAxis | null {
  const readNumeric = (
    source: string,
    type: string,
    field: 'readinessScore' | 'value'
  ): Map<string, number> => {
    const rows = db
      .select({ occurredAt: records.occurredAt, payload: records.payload })
      .from(records)
      .where(
        and(eq(records.source, source), eq(records.type, type), gte(records.occurredAt, since))
      )
      .all()
    const acc = new Map<string, { sum: number; n: number }>()
    for (const r of rows) {
      if (!r.occurredAt) continue
      let v: number | null = null
      try {
        const raw = (JSON.parse(r.payload ?? '{}') as Record<string, unknown>)[field]
        v = raw == null ? null : Number(raw)
      } catch {
        v = null
      }
      if (v == null || Number.isNaN(v)) continue
      const k = localYmd(r.occurredAt)
      const cur = acc.get(k) ?? { sum: 0, n: 0 }
      cur.sum += v
      cur.n += 1
      acc.set(k, cur)
    }
    const byDay = new Map<string, number>()
    for (const [k, { sum, n }] of acc) byDay.set(k, sum / n)
    return byDay
  }
  const readiness = readNumeric('oura', 'wellness', 'readinessScore')
  if (readiness.size >= DEV_RECOVERY_MIN_DAYS)
    return {
      byDay: readiness,
      axis: 'Oura readiness',
      betterIsHigher: true,
      drop: DEV_RECOVERY_READINESS_DROP
    }
  const hrv = readNumeric('apple-health', 'hrv', 'value')
  if (hrv.size >= DEV_RECOVERY_MIN_DAYS)
    return { byDay: hrv, axis: 'HRV', betterIsHigher: true, drop: DEV_RECOVERY_HRV_DROP }
  const rhr = readNumeric('apple-health', 'resting-hr', 'value')
  if (rhr.size >= DEV_RECOVERY_MIN_DAYS)
    return {
      byDay: rhr,
      axis: 'resting heart rate',
      betterIsHigher: false,
      drop: DEV_RECOVERY_RHR_RISE
    }
  return null
}

/**
 * Developer productivity (github commits/day) vs recovery (Oura readiness / HRV
 * / resting HR): do your heaviest coding days track measurably worse recovery?
 * Correlation, not causation — both streams already live on the spine.
 */
function detectDevProductivityVsRecovery(db: Db, now: Date): Insight[] {
  const since = new Date(now.getTime() - DEV_RECOVERY_LOOKBACK_DAYS * 24 * 3600 * 1000)
  const recovery = readRecoveryByDay(db, since)
  if (!recovery) return []
  const commitsByDay = readCommitsByDay(db, since)
  const heavy: number[] = []
  const quiet: number[] = []
  for (const [day, value] of recovery.byDay) {
    const commits = commitsByDay.get(day) ?? 0
    if (commits >= DEV_RECOVERY_BUSY_COMMITS) heavy.push(value)
    else if (commits <= DEV_RECOVERY_QUIET_COMMITS) quiet.push(value)
    // days with 2..4 commits sit in the gap and are intentionally ignored
  }
  if (heavy.length < DEV_RECOVERY_MIN_GROUP || quiet.length < DEV_RECOVERY_MIN_GROUP) return []
  const heavyMean = mean(heavy)
  const quietMean = mean(quiet)
  // "Worse" depends on the axis polarity (readiness/HRV higher = better; RHR lower = better).
  const worseBy = recovery.betterIsHigher ? quietMean - heavyMean : heavyMean - quietMean
  if (worseBy < recovery.drop) return []
  const r = (n: number): string => `${Math.round(n)}`
  return [
    {
      kind: 'dev-productivity-vs-recovery',
      severity: 'info',
      title: 'Your heavy coding days track worse recovery',
      detail: `${recovery.axis} averaged ${r(heavyMean)} on your ${heavy.length} heaviest commit days (≥${DEV_RECOVERY_BUSY_COMMITS}) vs ${r(quietMean)} on ${quiet.length} quiet ones.`,
      route: '/insights'
    }
  ]
}

// ── Calendar load × habits ───────────────────────────────────────────────────

/** Count of active habits (0 → no habit signal at all). */
function activeHabitCount(db: Db): number {
  return db.select({ id: habits.id }).from(habits).where(eq(habits.active, true)).all().length
}

/** Calendar events per week from the gcal spine. */
function readCalendarByWeek(db: Db, since: Date): Map<string, number> {
  const rows = db
    .select({ occurredAt: records.occurredAt })
    .from(records)
    .where(
      and(eq(records.source, 'gcal'), eq(records.type, 'event'), gte(records.occurredAt, since))
    )
    .all()
  const byWeek = new Map<string, number>()
  for (const r of rows) {
    if (!r.occurredAt) continue
    const k = weekKey(r.occurredAt)
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1)
  }
  return byWeek
}

/** Habit completion RATE per week = completed checks / (activeHabits × 7). */
function readHabitRateByWeek(db: Db, since: Date, activeCount: number): Map<string, number> {
  if (activeCount <= 0) return new Map()
  const sinceYmd = localYmd(since)
  const rows = db
    .select({ date: habitEntries.date, completed: habitEntries.completed })
    .from(habitEntries)
    .where(gte(habitEntries.date, sinceYmd))
    .all()
  const counts = new Map<string, number>()
  for (const e of rows) {
    if (!e.completed) continue
    const d = new Date(`${e.date}T00:00:00`)
    if (Number.isNaN(d.getTime())) continue
    const k = weekKey(d)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const rate = new Map<string, number>()
  for (const [k, c] of counts) rate.set(k, c / (activeCount * 7))
  return rate
}

/**
 * Calendar load (events/week) vs habit completion: do your busiest weeks come at
 * the cost of the habits you're trying to hold? Fires when lighter weeks beat
 * genuinely-busy weeks on completion by a clear margin.
 */
function detectCalendarLoadVsHabits(db: Db, now: Date): Insight[] {
  const activeCount = activeHabitCount(db)
  if (activeCount <= 0) return []
  const since = new Date(now.getTime() - (CAL_HABITS_MIN_WEEKS + 2) * 7 * 24 * 3600 * 1000)
  const eventsByWeek = readCalendarByWeek(db, since)
  const rateByWeek = readHabitRateByWeek(db, since, activeCount)
  const weeks = [...eventsByWeek.keys()].filter((k) => rateByWeek.has(k))
  if (weeks.length < CAL_HABITS_MIN_WEEKS) return []
  const paired = weeks.map((k) => ({
    events: eventsByWeek.get(k) as number,
    rate: rateByWeek.get(k) as number
  }))
  const meanEvents = mean(paired.map((p) => p.events))
  const heavy = paired.filter((p) => p.events >= meanEvents)
  const light = paired.filter((p) => p.events < meanEvents)
  if (heavy.length < CAL_HABITS_MIN_GROUP || light.length < CAL_HABITS_MIN_GROUP) return []
  const heavyEventsMean = mean(heavy.map((p) => p.events))
  if (heavyEventsMean < CAL_HABITS_MIN_EVENTS) return [] // not genuinely busy → no signal
  const heavyRate = mean(heavy.map((p) => p.rate))
  const lightRate = mean(light.map((p) => p.rate))
  if (lightRate - heavyRate < CAL_HABITS_RATE_DROP) return []
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  return [
    {
      kind: 'calendar-load-vs-habits',
      severity: 'info',
      title: 'Busy calendar weeks, slipping habits',
      detail: `On your busier weeks (${Math.round(heavyEventsMean)}+ events) you hit ${pct(heavyRate)} of your habit checks vs ${pct(lightRate)} on lighter ones.`,
      route: '/insights'
    }
  ]
}

// ── Correlations (chart data for the /insights page) ─────────────────────────

export interface CorrelationsResult {
  generatedAt: string
  sleepVsSpend: {
    source: 'apple-health' | 'oura'
    points: Array<{ week: string; sleep: number; spend: number }>
  } | null
  devVsRecovery: {
    axis: string
    betterIsHigher: boolean
    points: Array<{ day: string; commits: number; recovery: number }>
  } | null
  calendarVsHabits: {
    points: Array<{ week: string; events: number; completionRate: number }>
  } | null
}

function safeSection<T>(fn: () => T | null): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

/**
 * The underlying paired series behind the cross-domain detectors, for charting
 * on the /insights page. Unlike the detectors (which fire only past a delta),
 * these surface whenever there's ENOUGH DATA to be worth plotting — so the user
 * sees the relationship even when it isn't alarming. Reuses the same read
 * helpers as the detectors so chart data and nudges can never drift apart.
 */
export function buildCorrelations(db: Db, now: Date = new Date()): CorrelationsResult {
  const sleepVsSpend = safeSection(() => {
    const since = new Date(now.getTime() - (SLEEP_SPEND_MIN_WEEKS + 2) * 7 * 24 * 3600 * 1000)
    const { byWeek: sleepByWeek, source } = readSleepByWeek(db, since)
    const spendByWeek = readDiscretionarySpendByWeek(db, since)
    const weeks = [...sleepByWeek.keys()].filter((k) => spendByWeek.has(k)).sort()
    if (weeks.length < SLEEP_SPEND_MIN_WEEKS) return null
    return {
      source,
      points: weeks.map((week) => ({
        week,
        sleep: Math.round((sleepByWeek.get(week) as number) * 10) / 10,
        spend: Math.round(spendByWeek.get(week) as number)
      }))
    }
  })

  const devVsRecovery = safeSection(() => {
    const since = new Date(now.getTime() - DEV_RECOVERY_LOOKBACK_DAYS * 24 * 3600 * 1000)
    const recovery = readRecoveryByDay(db, since)
    if (!recovery) return null
    const commitsByDay = readCommitsByDay(db, since)
    const days = [...recovery.byDay.keys()].sort()
    const points = days.map((day) => ({
      day,
      commits: commitsByDay.get(day) ?? 0,
      recovery: Math.round((recovery.byDay.get(day) as number) * 10) / 10
    }))
    const heavy = points.filter((p) => p.commits >= DEV_RECOVERY_BUSY_COMMITS).length
    const quiet = points.filter((p) => p.commits <= DEV_RECOVERY_QUIET_COMMITS).length
    if (heavy < DEV_RECOVERY_MIN_GROUP || quiet < DEV_RECOVERY_MIN_GROUP) return null
    return { axis: recovery.axis, betterIsHigher: recovery.betterIsHigher, points }
  })

  const calendarVsHabits = safeSection(() => {
    const activeCount = activeHabitCount(db)
    if (activeCount <= 0) return null
    const since = new Date(now.getTime() - (CAL_HABITS_MIN_WEEKS + 2) * 7 * 24 * 3600 * 1000)
    const eventsByWeek = readCalendarByWeek(db, since)
    const rateByWeek = readHabitRateByWeek(db, since, activeCount)
    const weeks = [...eventsByWeek.keys()].filter((k) => rateByWeek.has(k)).sort()
    if (weeks.length < CAL_HABITS_MIN_WEEKS) return null
    return {
      points: weeks.map((week) => ({
        week,
        events: eventsByWeek.get(week) as number,
        completionRate: Math.round((rateByWeek.get(week) as number) * 100) / 100
      }))
    }
  })

  return { generatedAt: now.toISOString(), sleepVsSpend, devVsRecovery, calendarVsHabits }
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
    ...safeDetect(() => detectMedicalOutOfPocket(db, now)),
    ...safeDetect(() => detectDevProductivityVsRecovery(db, now)),
    ...safeDetect(() => detectCalendarLoadVsHabits(db, now))
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
  ipcMain.handle('insights:correlations', (): CorrelationsResult => {
    return buildCorrelations(getDb())
  })
}
