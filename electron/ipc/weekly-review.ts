/**
 * Weekly review ritual (Phase 7 Track A) — the data side of the Weekly page's
 * guided close-out:
 *
 *   - `weekly-review:get`  → completion stats for the week (done/total/%),
 *     week-over-week delta vs the prior 7 days, a per-day breakdown, and the
 *     carry-over candidates (unchecked manual daily items still open).
 *   - `weekly-review:carry-over` → copy those unfinished manual tasks forward
 *     to a target day (default: today), skipping titles already present there
 *     so re-running is safe.
 *
 * `buildWeeklyReview(db, weekStartYmd)` is exported + pure (no clock) so it's
 * unit-testable and reusable. Local-day throughout: the week is the 7 keys
 * Mon..Sun derived from the caller's Monday `YYYY-MM-DD`, matching how daily
 * checklist rows are stored (see electron/lib/dates.ts).
 */

import { and, between, eq, gte, inArray, lt } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { checklistItems, financeTransactions, habitEntries, habits, records } from '../db/schema'
import { localYmd } from '../lib/dates'
import { rankMemories } from '../lib/timeline-memories'

const MAX_CARRYOVER_PREVIEW = 10
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Spend categories excluded from the week's discretionary total (internal plumbing). */
const NON_SPEND_CATEGORIES = new Set(['Transfers', 'Transfer'])

/** This week across every domain — the cross-domain half of the review. */
export interface WeeklyCrossDomain {
  spend: {
    total: number
    prevTotal: number
    topCategories: Array<{ category: string; amount: number }>
  } | null
  habits: Array<{ name: string; done: number }>
  health: {
    steps: number | null
    prevSteps: number | null
    sleepHours: number | null
    prevSleepHours: number | null
  } | null
  highlights: Array<{ source: string; type: string; title: string; occurredAt: number | null }>
}

export interface WeeklyReview {
  weekStart: string
  weekEnd: string
  totalTasks: number
  completedTasks: number
  completionPct: number
  prevCompletionPct: number | null
  deltaPct: number | null
  perDay: Array<{ date: string; total: number; done: number }>
  carryOver: {
    count: number
    items: Array<{ id: number; title: string; listDate: string; category: string | null }>
  }
  /** Spend + habits + health + biggest events for the week — the leverage layer. */
  crossDomain: WeeklyCrossDomain
}

function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime()) && localYmd(parsed) === value
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() + n)
  return localYmd(d)
}

function weekDayKeys(weekStartYmd: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStartYmd, i))
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0
}

type DailyRow = {
  id: number
  title: string
  listDate: string
  checked: boolean | null
  category: string | null
  source: string | null
  body: string | null
  sortOrder: number | null
}

function dailyRowsForKeys(db: ReturnType<typeof getDb>, keys: string[]): DailyRow[] {
  return db
    .select({
      id: checklistItems.id,
      title: checklistItems.title,
      listDate: checklistItems.listDate,
      checked: checklistItems.checked,
      category: checklistItems.category,
      source: checklistItems.source,
      body: checklistItems.body,
      sortOrder: checklistItems.sortOrder
    })
    .from(checklistItems)
    .where(and(eq(checklistItems.listType, 'daily'), inArray(checklistItems.listDate, keys)))
    .all()
}

/** Never let one cross-domain section (a table absent on an older DB) break the review. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Sum of |negative amounts| (spend) for a finance-date range, excluding transfers, + top categories. */
function weekSpend(
  db: ReturnType<typeof getDb>,
  from: string,
  to: string
): { total: number; byCategory: Map<string, number> } {
  const rows = db
    .select({ amount: financeTransactions.amount, category: financeTransactions.category })
    .from(financeTransactions)
    .where(and(between(financeTransactions.date, from, to), lt(financeTransactions.amount, 0)))
    .all()
  let total = 0
  const byCategory = new Map<string, number>()
  for (const r of rows) {
    const cat = r.category ?? 'Uncategorized'
    if (NON_SPEND_CATEGORIES.has(cat)) continue
    const v = Math.abs(r.amount)
    total += v
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + v)
  }
  return { total: Math.round(total * 100) / 100, byCategory }
}

/** Sum a numeric field from `apple-health` records of a given type over [startMs, endMs). */
function weekHealthMetric(
  db: ReturnType<typeof getDb>,
  type: string,
  field: 'value' | 'ms',
  startMs: number,
  endMs: number
): number | null {
  const rows = db
    .select({ payload: records.payload })
    .from(records)
    .where(
      and(
        eq(records.source, 'apple-health'),
        eq(records.type, type),
        gte(records.occurredAt, new Date(startMs)),
        lt(records.occurredAt, new Date(endMs))
      )
    )
    .all()
  if (rows.length === 0) return null
  let sum = 0
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload ?? '{}') as Record<string, number>
      const v = Number(p[field])
      if (Number.isFinite(v)) sum += v
    } catch {
      /* skip unparseable payload */
    }
  }
  return Math.round(sum)
}

/** Compute the cross-domain half of the review — each section guarded independently. */
function buildCrossDomain(
  db: ReturnType<typeof getDb>,
  weekStartYmd: string,
  weekEndYmd: string
): WeeklyCrossDomain {
  const startMs = new Date(`${weekStartYmd}T00:00:00`).getTime()
  const endMs = startMs + 7 * 86_400_000
  const prevStartMs = startMs - 7 * 86_400_000
  const prevStartYmd = addDaysYmd(weekStartYmd, -7)
  const prevEndYmd = addDaysYmd(weekStartYmd, -1)

  const spend = safe<WeeklyCrossDomain['spend']>(() => {
    const cur = weekSpend(db, weekStartYmd, weekEndYmd)
    const prev = weekSpend(db, prevStartYmd, prevEndYmd)
    if (cur.total === 0 && prev.total === 0) return null
    const topCategories = [...cur.byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
    return { total: cur.total, prevTotal: prev.total, topCategories }
  }, null)

  const habitList = safe<WeeklyCrossDomain['habits']>(() => {
    const active = db.select().from(habits).where(eq(habits.active, true)).all()
    if (active.length === 0) return []
    const keys = weekDayKeys(weekStartYmd)
    const out: Array<{ name: string; done: number }> = []
    for (const h of active) {
      if (h.id == null) continue
      const done = db
        .select({ date: habitEntries.date })
        .from(habitEntries)
        .where(
          and(
            eq(habitEntries.habitId, h.id),
            eq(habitEntries.completed, true),
            inArray(habitEntries.date, keys)
          )
        )
        .all().length
      if (done > 0) out.push({ name: h.name, done })
    }
    return out.sort((a, b) => b.done - a.done)
  }, [])

  const health = safe<WeeklyCrossDomain['health']>(() => {
    const steps = weekHealthMetric(db, 'steps', 'value', startMs, endMs)
    const prevSteps = weekHealthMetric(db, 'steps', 'value', prevStartMs, startMs)
    const sleepMs = weekHealthMetric(db, 'sleep', 'ms', startMs, endMs)
    const prevSleepMs = weekHealthMetric(db, 'sleep', 'ms', prevStartMs, startMs)
    if (steps == null && sleepMs == null) return null
    const hrs = (ms: number | null): number | null =>
      ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10
    return { steps, prevSteps, sleepHours: hrs(sleepMs), prevSleepHours: hrs(prevSleepMs) }
  }, null)

  const highlights = safe<WeeklyCrossDomain['highlights']>(() => {
    const weekRecords = db
      .select({
        id: records.id,
        source: records.source,
        type: records.type,
        occurredAt: records.occurredAt,
        title: records.title,
        body: records.body
      })
      .from(records)
      .where(
        and(gte(records.occurredAt, new Date(startMs)), lt(records.occurredAt, new Date(endMs)))
      )
      .all()
      .map((r) => ({ ...r, occurredAt: r.occurredAt ? r.occurredAt.getTime() : null }))
    // Reuse the on-this-day memory ranker to pick the week's most notable events.
    return rankMemories(weekRecords, { cap: 5 }).map((r) => ({
      source: r.source,
      type: r.type,
      title: r.title,
      occurredAt: r.occurredAt
    }))
  }, [])

  return { spend, habits: habitList, health, highlights }
}

export function buildWeeklyReview(
  db: ReturnType<typeof getDb>,
  weekStartYmd: string
): WeeklyReview {
  const keys = weekDayKeys(weekStartYmd)
  const rows = dailyRowsForKeys(db, keys)

  const totalTasks = rows.length
  const completedTasks = rows.filter((r) => r.checked).length

  // Per-day breakdown, in Mon..Sun order.
  const perDay = keys.map((date) => {
    const dayRows = rows.filter((r) => r.listDate === date)
    return { date, total: dayRows.length, done: dayRows.filter((r) => r.checked).length }
  })

  // Previous week (prior 7 days) for the delta.
  const prevKeys = weekDayKeys(addDaysYmd(weekStartYmd, -7))
  const prevRows = dailyRowsForKeys(db, prevKeys)
  const prevCompletionPct =
    prevRows.length > 0 ? pct(prevRows.filter((r) => r.checked).length, prevRows.length) : null

  const completionPct = pct(completedTasks, totalTasks)

  // Carry-over candidates: unchecked, manually-added daily items (mirrors the
  // checklist roll-over predicate — synced/imported items aren't carried).
  const carryRows = rows.filter((r) => !r.checked && r.source === 'manual')

  return {
    weekStart: weekStartYmd,
    weekEnd: keys[6],
    totalTasks,
    completedTasks,
    completionPct,
    prevCompletionPct,
    deltaPct: prevCompletionPct === null ? null : completionPct - prevCompletionPct,
    perDay,
    carryOver: {
      count: carryRows.length,
      items: carryRows.slice(0, MAX_CARRYOVER_PREVIEW).map((r) => ({
        id: r.id,
        title: r.title,
        listDate: r.listDate,
        category: r.category
      }))
    },
    crossDomain: buildCrossDomain(db, weekStartYmd, keys[6])
  }
}

export function registerWeeklyReviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('weekly-review:get', (_event, weekStart: unknown): WeeklyReview => {
    if (!isValidYmd(weekStart)) {
      throw new Error(
        `weekly-review:get: weekStart must be a YYYY-MM-DD string (got ${String(weekStart)})`
      )
    }
    return buildWeeklyReview(getDb(), weekStart)
  })

  // Copy unfinished manual daily tasks from the week to `toDate` (default today).
  // Skips titles already present on the target day so re-running doesn't dupe.
  ipcMain.handle(
    'weekly-review:carry-over',
    (
      _event,
      weekStart: unknown,
      toDate: unknown
    ): { success: boolean; carried?: number; error?: string } => {
      if (!isValidYmd(weekStart)) return { success: false, error: 'Invalid weekStart date' }
      // Omitted toDate → default to today. An explicitly-provided but invalid
      // toDate is an error (don't silently retarget the user's tasks).
      let target: string
      if (toDate === undefined || toDate === null) {
        target = localYmd()
      } else if (isValidYmd(toDate)) {
        target = toDate
      } else {
        return { success: false, error: 'Invalid toDate' }
      }

      const db = getDb()
      const keys = weekDayKeys(weekStart)
      const unfinished = dailyRowsForKeys(db, keys).filter(
        (r) => !r.checked && r.source === 'manual'
      )

      const existingTitles = new Set(
        db
          .select({ title: checklistItems.title })
          .from(checklistItems)
          .where(and(eq(checklistItems.listType, 'daily'), eq(checklistItems.listDate, target)))
          .all()
          .map((r) => r.title)
      )

      let carried = 0
      for (const item of unfinished) {
        if (existingTitles.has(item.title)) continue
        db.insert(checklistItems)
          .values({
            listType: 'daily',
            listDate: target,
            title: item.title,
            body: item.body,
            category: item.category ?? 'personal',
            sortOrder: item.sortOrder ?? 0,
            source: 'manual',
            createdAt: new Date()
          })
          .run()
        existingTitles.add(item.title)
        carried++
      }

      return { success: true, carried }
    }
  )
}
