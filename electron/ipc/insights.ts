/**
 * Proactive insights — Phase 7 Track E.
 *
 * One read-only aggregator (`insights:get`) that scans local data for things
 * worth surfacing before the user goes looking: category spending anomalies,
 * uncategorized-spend buildup, habit slippage, and stale notes. Pure
 * detectors over the DB — no network, no LLM, no writes.
 *
 * `buildInsights(db, now)` is exported for tests (same pattern as
 * `buildMorningBrief`). Thresholds are exported consts so tests pin them.
 */
import { and, eq, gte, isNull, lt, or } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { financeTransactions, habitEntries, habits, knowledgeFiles } from '../db/schema'
import { localYm, localYmd } from '../lib/dates'

export interface Insight {
  kind: 'spending-anomaly' | 'uncategorized-spend' | 'habit-slippage' | 'stale-notes'
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

// ── Aggregator ───────────────────────────────────────────────────────────────

export function buildInsights(db: Db, now: Date = new Date()): InsightsResult {
  const insights: Insight[] = [
    ...detectSpendingAnomalies(db, now),
    ...detectUncategorizedSpend(db, now),
    ...detectHabitSlippage(db, now),
    ...detectStaleNotes(db, now)
  ]
  // Warnings first, stable within severity (detector order is intentional).
  insights.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1))
  return { generatedAt: now.toISOString(), insights }
}

export function registerInsightsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('insights:get', (): InsightsResult => {
    return buildInsights(getDb())
  })
}
