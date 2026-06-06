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

import { and, eq, inArray } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { checklistItems } from '../db/schema'
import { localYmd } from '../lib/dates'

const MAX_CARRYOVER_PREVIEW = 10
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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
    }
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
