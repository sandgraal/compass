/**
 * Monthly rollup (Phase 7 Track A) — the data side of the Monthly page's
 * end-of-month review. Zooms the weekly ritual out to a calendar month:
 *
 *   - `monthly-rollup:get` → completion stats for the whole month
 *     (done/total/%), month-over-month delta vs the previous calendar month,
 *     and a per-week breakdown (each ISO week — Mon..Sun — that overlaps the
 *     month) plus the best week.
 *
 * `buildMonthlyRollup(db, month)` is exported + pure (no clock) so it's
 * unit-testable. Local-day throughout: month totals come from the daily
 * checklist rows whose `list_date` falls within the calendar month, and each
 * week reuses `buildWeeklyReview` so the two rituals stay consistent (see
 * electron/lib/dates.ts + weekly-review.ts).
 */

import { and, eq, gte, lte } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { checklistItems } from '../db/schema'
import { localYmd } from '../lib/dates'
import { buildWeeklyReview } from './weekly-review'

const ISO_MONTH_RE = /^\d{4}-\d{2}$/

export interface MonthlyWeek {
  weekStart: string
  weekEnd: string
  totalTasks: number
  completedTasks: number
  completionPct: number
}

export interface MonthlyRollup {
  month: string
  monthStart: string
  monthEnd: string
  totalTasks: number
  completedTasks: number
  completionPct: number
  prevCompletionPct: number | null
  deltaPct: number | null
  weeks: MonthlyWeek[]
  bestWeek: { weekStart: string; completionPct: number } | null
}

function isValidMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_MONTH_RE.test(value)) return false
  const month = Number(value.slice(5, 7))
  return month >= 1 && month <= 12
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() + n)
  return localYmd(d)
}

/** Monday (local) of the ISO week containing `ymd`. */
function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00`).getDay() // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7
  return addDaysYmd(ymd, -offsetToMonday)
}

/** First (`YYYY-MM-01`) and last (`YYYY-MM-DD`) local day of a `YYYY-MM` month. */
function monthBounds(month: string): { start: string; end: string } {
  const year = Number(month.slice(0, 4))
  const monthNum = Number(month.slice(5, 7)) // 1..12
  const start = `${month}-01`
  const lastDay = new Date(year, monthNum, 0).getDate()
  const end = `${month}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

/** Total/completed daily checklist tasks whose `list_date` is within [start, end]. */
function monthTotals(
  db: ReturnType<typeof getDb>,
  start: string,
  end: string
): { total: number; done: number } {
  const rows = db
    .select({ checked: checklistItems.checked })
    .from(checklistItems)
    .where(
      and(
        eq(checklistItems.listType, 'daily'),
        gte(checklistItems.listDate, start),
        lte(checklistItems.listDate, end)
      )
    )
    .all()
  return { total: rows.length, done: rows.filter((r) => r.checked).length }
}

/** The Monday of each ISO week that overlaps the month, in chronological order. */
function weekStartsForMonth(start: string, end: string): string[] {
  const starts: string[] = []
  let monday = mondayOf(start)
  while (monday <= end) {
    starts.push(monday)
    monday = addDaysYmd(monday, 7)
  }
  return starts
}

export function buildMonthlyRollup(db: ReturnType<typeof getDb>, month: string): MonthlyRollup {
  const { start, end } = monthBounds(month)

  const { total: totalTasks, done: completedTasks } = monthTotals(db, start, end)
  const completionPct = pct(completedTasks, totalTasks)

  // Previous calendar month for the delta.
  const prevEnd = addDaysYmd(start, -1)
  const prevMonth = prevEnd.slice(0, 7)
  const { start: prevStart } = monthBounds(prevMonth)
  const prev = monthTotals(db, prevStart, prevEnd)
  const prevCompletionPct = prev.total > 0 ? pct(prev.done, prev.total) : null

  // Per-week breakdown — reuse the weekly ritual so the numbers line up with
  // what the Weekly page shows for that same Monday.
  const weeks: MonthlyWeek[] = weekStartsForMonth(start, end).map((weekStart) => {
    const wr = buildWeeklyReview(db, weekStart)
    return {
      weekStart: wr.weekStart,
      weekEnd: wr.weekEnd,
      totalTasks: wr.totalTasks,
      completedTasks: wr.completedTasks,
      completionPct: wr.completionPct
    }
  })

  const weeksWithTasks = weeks.filter((w) => w.totalTasks > 0)
  const bestWeek =
    weeksWithTasks.length > 0
      ? weeksWithTasks.reduce((best, w) => (w.completionPct > best.completionPct ? w : best))
      : null

  return {
    month,
    monthStart: start,
    monthEnd: end,
    totalTasks,
    completedTasks,
    completionPct,
    prevCompletionPct,
    deltaPct: prevCompletionPct === null ? null : completionPct - prevCompletionPct,
    weeks,
    bestWeek: bestWeek
      ? { weekStart: bestWeek.weekStart, completionPct: bestWeek.completionPct }
      : null
  }
}

export function registerMonthlyRollupHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('monthly-rollup:get', (_event, month: unknown): MonthlyRollup => {
    if (!isValidMonth(month)) {
      throw new Error(`monthly-rollup:get: month must be a YYYY-MM string (got ${String(month)})`)
    }
    return buildMonthlyRollup(getDb(), month)
  })
}
