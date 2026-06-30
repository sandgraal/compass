/**
 * Financial goals & milestones (Phase 11.6).
 *
 * Target-date savings goals that tie the cross-border picture together — a tax
 * reserve, the next CR capex draw, the retirement number, an emergency fund. A
 * goal's CURRENT value is either entered manually or auto-linked to a live
 * aggregate (net worth, retirement assets, property cost basis) so it tracks
 * itself. All amounts are in the user's base currency (Phase 11.1).
 *
 * `computeGoalProgress` is pure (remaining / % / required-monthly / on-track);
 * a thin DB layer does CRUD and resolves the auto-linked currents.
 */

import { getBaseCurrency } from './finance-fx'
import { buildPropertyPnl, getPropertyConfig } from './finance-property'
import { type SqliteForSnapshot, getNetWorthSnapshot } from './finance-snapshot'

export type GoalSource = 'manual' | 'net-worth' | 'retirement' | 'property-basis'

export type GoalInput = {
  name: string
  category?: string
  targetAmount: number
  targetDate?: string | null
  source?: GoalSource
  manualCurrent?: number
  monthlyContribution?: number
  notes?: string | null
}

export type GoalRow = {
  id: number
  name: string
  category: string
  target_amount: number
  target_date: string | null
  source: string
  manual_current: number
  monthly_contribution: number
  notes: string | null
}

export type GoalStatus = 'reached' | 'on-track' | 'behind' | 'no-date'

export type GoalProgress = {
  id: number
  name: string
  category: string
  source: string
  targetAmount: number
  targetDate: string | null
  current: number
  remaining: number
  pct: number // 0..1
  reached: boolean
  monthlyContribution: number
  requiredMonthly: number | null // to hit targetDate (null if no date or reached)
  projectedMonths: number | null // months to reach at the planned contribution
  onTrack: boolean | null // contribution covers requiredMonthly (null if no date)
  status: GoalStatus
  notes: string | null
}

const DAYS_PER_MONTH = 30.4375

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isYmd(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Whole-ish months between two ISO dates (UTC day diff / 30.44). */
function monthsBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10))
  )
  const to = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10))
  )
  return (to - from) / (1000 * 60 * 60 * 24) / DAYS_PER_MONTH
}

/**
 * Pure progress for one goal given its resolved `current` value and today.
 * `requiredMonthly` is what you'd need to save each month to hit the target
 * date; `onTrack` compares that to the planned `monthlyContribution`.
 */
export function computeGoalProgress(
  goal: {
    id: number
    name: string
    category: string
    source: string
    targetAmount: number
    targetDate: string | null
    monthlyContribution: number
    notes: string | null
  },
  current: number,
  today: string
): GoalProgress {
  const target = goal.targetAmount
  const remaining = round2(Math.max(0, target - current))
  const reached = target > 0 ? current >= target : current > 0
  const pct = target > 0 ? Math.max(0, Math.min(1, current / target)) : reached ? 1 : 0
  const contribution = goal.monthlyContribution

  let requiredMonthly: number | null = null
  let onTrack: boolean | null = null
  if (isYmd(goal.targetDate) && !reached) {
    const months = monthsBetween(today, goal.targetDate)
    // Past-due or same-month → you'd need the whole remainder now.
    requiredMonthly = months > 0 ? round2(remaining / months) : remaining
    onTrack = contribution >= requiredMonthly
  } else if (isYmd(goal.targetDate) && reached) {
    onTrack = true
  }

  const projectedMonths = reached
    ? 0
    : contribution > 0
      ? Math.ceil(remaining / contribution)
      : null

  let status: GoalStatus
  if (reached) status = 'reached'
  else if (!isYmd(goal.targetDate)) status = 'no-date'
  else status = onTrack ? 'on-track' : 'behind'

  return {
    id: goal.id,
    name: goal.name,
    category: goal.category,
    source: goal.source,
    targetAmount: round2(target),
    targetDate: goal.targetDate,
    current: round2(current),
    remaining,
    pct: Math.round(pct * 10000) / 10000,
    reached,
    monthlyContribution: contribution,
    requiredMonthly,
    projectedMonths,
    onTrack,
    status,
    notes: goal.notes
  }
}

// ─── DB layer ────────────────────────────────────────────────────────────────

export type SqliteForGoals = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

export function listGoals(sqlite: SqliteForGoals): GoalRow[] {
  return sqlite
    .prepare(
      `SELECT id, name, category, target_amount, target_date, source, manual_current,
              monthly_contribution, notes
         FROM financial_goals
        ORDER BY COALESCE(target_date, '9999-12-31') ASC, id ASC`
    )
    .all() as GoalRow[]
}

export function addGoal(
  sqlite: SqliteForGoals,
  input: GoalInput,
  now: number = Date.now()
): number {
  const info = sqlite
    .prepare(
      `INSERT INTO financial_goals
         (name, category, target_amount, target_date, source, manual_current,
          monthly_contribution, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.category ?? 'other',
      input.targetAmount,
      input.targetDate ?? null,
      input.source ?? 'manual',
      input.manualCurrent ?? 0,
      input.monthlyContribution ?? 0,
      input.notes ?? null,
      now,
      now
    )
  return Number(info.lastInsertRowid)
}

export function updateGoal(
  sqlite: SqliteForGoals,
  id: number,
  patch: Partial<GoalInput>,
  now: number = Date.now()
): void {
  const cols: Array<[string, unknown]> = []
  if ('name' in patch) cols.push(['name', patch.name])
  if ('category' in patch) cols.push(['category', patch.category])
  if ('targetAmount' in patch) cols.push(['target_amount', patch.targetAmount])
  if ('targetDate' in patch) cols.push(['target_date', patch.targetDate ?? null])
  if ('source' in patch) cols.push(['source', patch.source])
  if ('manualCurrent' in patch) cols.push(['manual_current', patch.manualCurrent])
  if ('monthlyContribution' in patch) cols.push(['monthly_contribution', patch.monthlyContribution])
  if ('notes' in patch) cols.push(['notes', patch.notes ?? null])
  if (cols.length === 0) return
  cols.push(['updated_at', now])
  const setSql = cols.map(([c]) => `${c} = ?`).join(', ')
  sqlite
    .prepare(`UPDATE financial_goals SET ${setSql} WHERE id = ?`)
    .run(...cols.map(([, v]) => v), id)
}

export function deleteGoal(sqlite: SqliteForGoals, id: number): void {
  sqlite.prepare('DELETE FROM financial_goals WHERE id = ?').run(id)
}

export type GoalsSummary = {
  baseCurrency: string
  goals: GoalProgress[]
  totals: { target: number; current: number; remaining: number }
}

/**
 * List goals with computed progress, resolving auto-linked currents from net
 * worth / retirement / property — each computed at most once. `today` injected
 * for determinism.
 */
export function buildGoalsSummary(
  sqlite: SqliteForGoals & SqliteForSnapshot,
  today: string
): GoalsSummary {
  const rows = listGoals(sqlite)
  const base = getBaseCurrency(sqlite)

  // Lazy-resolve the shared aggregates only when a goal actually references them.
  let netWorth: number | null = null
  let retirementAssets: number | null = null
  let propertyBasis: number | null = null
  const needs = (s: string): boolean => rows.some((r) => r.source === s)
  if (needs('net-worth') || needs('retirement')) {
    const snap = getNetWorthSnapshot(sqlite)
    netWorth = snap.net
    retirementAssets = round2(
      snap.byAccount
        .filter((a) => a.assetClass === 'retirement' || a.assetClass === 'savings')
        .reduce((sum, a) => sum + (a.baseBalance ?? 0), 0)
    )
  }
  if (needs('property-basis')) {
    propertyBasis = buildPropertyPnl(sqlite, getPropertyConfig(sqlite)).basisToDate
  }

  const resolveCurrent = (r: GoalRow): number => {
    switch (r.source) {
      case 'net-worth':
        return netWorth ?? 0
      case 'retirement':
        return retirementAssets ?? 0
      case 'property-basis':
        return propertyBasis ?? 0
      default:
        return r.manual_current
    }
  }

  const goals = rows.map((r) =>
    computeGoalProgress(
      {
        id: r.id,
        name: r.name,
        category: r.category,
        source: r.source,
        targetAmount: r.target_amount,
        targetDate: r.target_date,
        monthlyContribution: r.monthly_contribution,
        notes: r.notes
      },
      resolveCurrent(r),
      today
    )
  )

  const totals = goals.reduce(
    (acc, g) => ({
      target: acc.target + g.targetAmount,
      current: acc.current + g.current,
      remaining: acc.remaining + g.remaining
    }),
    { target: 0, current: 0, remaining: 0 }
  )

  return {
    baseCurrency: base,
    goals,
    totals: {
      target: round2(totals.target),
      current: round2(totals.current),
      remaining: round2(totals.remaining)
    }
  }
}
