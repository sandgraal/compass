/**
 * Morning Brief digest (Phase 7 Track A) — a single server-side aggregation of
 * "what matters today" the renderer can render as one glanceable card:
 *
 *   - today's calendar events (local-day window)
 *   - today's unchecked daily tasks
 *   - debt payments due within the next 7 days
 *   - unresolved inbox (Gmail) action items
 *   - a one-line summary string
 *
 * Exposed as `morning-brief:get`. `buildMorningBrief` is exported (and takes an
 * injectable `now`) so the digest can be reused later by the optional
 * scheduled system-notification without going through IPC, and so it's
 * unit-testable without faking the clock at the handler boundary.
 *
 * Date handling is LOCAL-day throughout (see electron/lib/dates.ts): calendar
 * events use a local-midnight window and tasks key off `localYmd`, so the
 * "today" boundary matches how the rest of the app stores date-only data.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { calendarEvents, checklistItems, financeAccounts, gmailActions } from '../db/schema'
import { localYmd } from '../lib/dates'

const MAX_PER_SECTION = 5
const PAYMENT_WINDOW_DAYS = 7

export interface MorningBrief {
  date: string
  greeting: string
  calendar: {
    count: number
    events: Array<{ title: string; startAt: string | null; allDay: boolean }>
  }
  tasks: {
    dueCount: number
    items: Array<{ id: number; title: string; category: string | null }>
  }
  payments: {
    count: number
    items: Array<{
      id: number
      name: string
      paymentDueDate: string
      daysRemaining: number
      minPayment: number
    }>
  }
  inbox: {
    count: number
    items: Array<{ id: number; subject: string; from: string }>
  }
  summary: string
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function buildSummary(events: number, tasks: number, payments: number, inbox: number): string {
  const parts = [`${pluralize(events, 'event')} today`, `${pluralize(tasks, 'task')} due`]
  if (payments > 0) parts.push(`${pluralize(payments, 'payment')} this week`)
  if (inbox > 0) parts.push(`${pluralize(inbox, 'inbox item')}`)
  return parts.join(' · ')
}

/**
 * Assemble the digest from current DB state. `now` is injectable for tests +
 * the future scheduled-notification caller; defaults to the live clock.
 */
export function buildMorningBrief(
  db: ReturnType<typeof getDb> = getDb(),
  now: Date = new Date()
): MorningBrief {
  const today = localYmd(now)

  // ── Today's calendar events (local-midnight → next local midnight) ──────────
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const calRows = db
    .select()
    .from(calendarEvents)
    .where(inArray(calendarEvents.source, ['google', 'apple']))
    .all()
    .filter(
      (e) =>
        e.startAt &&
        e.startAt.getTime() >= dayStart.getTime() &&
        e.startAt.getTime() < dayEnd.getTime()
    )
    .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0))

  const calendar = {
    count: calRows.length,
    events: calRows.slice(0, MAX_PER_SECTION).map((e) => ({
      title: e.title,
      startAt: e.startAt ? e.startAt.toISOString() : null,
      allDay: Boolean(e.allDay)
    }))
  }

  // ── Today's unchecked daily tasks ───────────────────────────────────────────
  const taskRows = db
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.listType, 'daily'), eq(checklistItems.listDate, today)))
    .all()
    .filter((t) => !t.checked)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))

  const tasks = {
    dueCount: taskRows.length,
    items: taskRows.slice(0, MAX_PER_SECTION).map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category ?? null
    }))
  }

  // ── Debt payments due within the next 7 days ────────────────────────────────
  const cutoff = new Date(dayStart)
  cutoff.setDate(cutoff.getDate() + PAYMENT_WINDOW_DAYS)
  const payItems = db
    .select()
    .from(financeAccounts)
    .where(eq(financeAccounts.isDebt, true))
    .all()
    .filter((d): d is typeof d & { paymentDueDate: string } => Boolean(d.paymentDueDate))
    .map((d) => {
      const due = new Date(`${d.paymentDueDate}T00:00:00`)
      return {
        id: d.id,
        name: d.name,
        paymentDueDate: d.paymentDueDate,
        daysRemaining: Math.round((due.getTime() - dayStart.getTime()) / 86_400_000),
        minPayment: d.minPayment ?? 0
      }
    })
    .filter((p) => {
      const due = new Date(`${p.paymentDueDate}T00:00:00`).getTime()
      return due >= dayStart.getTime() && due <= cutoff.getTime()
    })
    .sort((a, b) => (a.paymentDueDate < b.paymentDueDate ? -1 : 1))

  const payments = { count: payItems.length, items: payItems }

  // ── Unresolved inbox (Gmail) actions ────────────────────────────────────────
  const inboxRows = db.select().from(gmailActions).where(eq(gmailActions.done, false)).all()
  const inbox = {
    count: inboxRows.length,
    items: inboxRows.slice(0, MAX_PER_SECTION).map((g) => ({
      id: g.id,
      subject: g.subject,
      from: g.fromAddress
    }))
  }

  return {
    date: today,
    greeting: greetingFor(now.getHours()),
    calendar,
    tasks,
    payments,
    inbox,
    summary: buildSummary(calendar.count, tasks.dueCount, payments.count, inbox.count)
  }
}

export function registerMorningBriefHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('morning-brief:get', (): MorningBrief => buildMorningBrief())
}
