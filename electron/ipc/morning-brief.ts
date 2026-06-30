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
import { type IpcMain, Notification } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import {
  appSettings,
  calendarEvents,
  checklistItems,
  financeAccounts,
  gmailActions
} from '../db/schema'
import { type ForecastResult, buildForecast } from '../integrations/finance-forecast'
import { type Subscription, auditSubscriptions } from '../integrations/finance-subscriptions'
import { localYmd } from '../lib/dates'

const MAX_PER_SECTION = 5
const PAYMENT_WINDOW_DAYS = 7
// Near-term horizon for the brief's low-cash projection — a morning glance
// cares about the next couple of weeks, not the full 90-day Forecast tab.
const LOW_CASH_HORIZON_DAYS = 14
const LOW_CASH_DEFAULT_THRESHOLD = 500

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
  lowCash: LowCashAlert
  priceHikes: PriceHikeAlert
  summary: string
}

/**
 * Recent subscription price hikes surfaced from the subscription audit
 * (`auditSubscriptions`, which already computes recent-vs-historical median
 * deltas per active recurring charge). `items` is the largest-delta hikes;
 * `count` is the total. Opt-in via the `priceHikeAlertEnabled` setting.
 */
export interface PriceHikeAlert {
  enabled: boolean
  count: number
  items: Array<{
    merchant: string
    cadence: string
    recentMedian: number
    historicalMedian: number
    delta: number
    pct: number
  }>
}

function emptyPriceHikes(): PriceHikeAlert {
  return { enabled: false, count: 0, items: [] }
}

/**
 * Forward-looking low-cash warning derived from the 90-day cash-flow forecast
 * (Phase 4.5), evaluated over the brief's near-term horizon. `soonest` is the
 * earliest projected dip below `threshold` across the user's cash (non-debt)
 * accounts; null when nothing dips (or the alert is disabled). Opt-in via the
 * `lowCashAlertEnabled` setting so it never surprises users who haven't set a
 * threshold.
 */
export interface LowCashAlert {
  enabled: boolean
  threshold: number
  count: number
  soonest: {
    accountId: number
    accountName: string
    date: string
    balance: number
    daysRemaining: number
  } | null
}

function emptyLowCash(threshold = 0): LowCashAlert {
  return { enabled: false, threshold, count: 0, soonest: null }
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function buildSummary(
  events: number,
  tasks: number,
  payments: number,
  inbox: number,
  lowCash: LowCashAlert,
  priceHikes: PriceHikeAlert
): string {
  const parts = [`${pluralize(events, 'event')} today`, `${pluralize(tasks, 'task')} due`]
  if (payments > 0) parts.push(`${pluralize(payments, 'payment')} this week`)
  if (inbox > 0) parts.push(`${pluralize(inbox, 'inbox item')}`)
  if (lowCash.soonest) parts.push('⚠️ low cash ahead')
  if (priceHikes.count > 0) parts.push(`⚠️ ${pluralize(priceHikes.count, 'price hike')}`)
  return parts.join(' · ')
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const from = new Date(`${fromYmd}T00:00:00`).getTime()
  const to = new Date(`${toYmd}T00:00:00`).getTime()
  return Math.round((to - from) / 86_400_000)
}

/**
 * Pure summarizer: turn the forecast's `lowDates` into a single near-term
 * alert. Considers only accounts present in `cashNameById` (the user's cash
 * accounts), picks the earliest dip, and reports how many cash accounts dip.
 */
export function buildLowCashAlert(
  lowDates: ForecastResult['lowDates'],
  cashNameById: Map<number, string>,
  opts: { enabled: boolean; threshold: number; today: string }
): LowCashAlert {
  if (!opts.enabled) return emptyLowCash(opts.threshold)
  const known = lowDates.filter((d) => cashNameById.has(d.accountId))
  const sorted = [...known].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const first = sorted[0]
  const soonest = first
    ? {
        accountId: first.accountId,
        accountName: cashNameById.get(first.accountId) as string,
        date: first.date,
        // Base-currency dip — consistent with the base-currency threshold.
        // Identical to the native balance for base-currency accounts.
        balance: first.balanceBase,
        daysRemaining: daysBetweenYmd(opts.today, first.date)
      }
    : null
  return { enabled: true, threshold: opts.threshold, count: known.length, soonest }
}

/**
 * Boundary helper: read the user's low-cash settings, run the cash-flow
 * forecast over the brief's near-term horizon, and summarize. Lives outside
 * `buildMorningBrief` (which stays a pure assembler) because the forecast needs
 * raw SQLite. Disabled → returns an empty alert without touching the forecast.
 */
export function computeLowCashAlert(
  db: ReturnType<typeof getDb> = getDb(),
  sqlite: ReturnType<typeof getRawSqlite> = getRawSqlite(),
  now: Date = new Date()
): LowCashAlert {
  const enabledRow = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'lowCashAlertEnabled'))
    .get()
  const enabled = enabledRow?.value === 'true'

  const thresholdRow = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'lowCashThreshold'))
    .get()
  const parsed = Number(thresholdRow?.value)
  const threshold = Number.isFinite(parsed)
    ? Math.max(0, Math.min(1_000_000_000, parsed))
    : LOW_CASH_DEFAULT_THRESHOLD

  if (!enabled) return emptyLowCash(threshold)

  // Cash (non-debt) accounts only — a low-cash threshold is meaningless for
  // debt balances (where positive = amount owed).
  const accounts = sqlite.prepare('SELECT id, name, is_debt FROM finance_accounts').all() as Array<{
    id: number
    name: string
    is_debt: number
  }>
  const cashNameById = new Map<number, string>()
  for (const a of accounts) if (a.is_debt !== 1) cashNameById.set(a.id, a.name)

  // Starting balances: latest snapshot per account, defaulting to 0 (mirrors
  // finance:get-forecast so brand-new accounts aren't silently omitted).
  const latest = sqlite
    .prepare(
      `SELECT s.account_id, s.balance
         FROM finance_balance_snapshots s
         JOIN (
           SELECT account_id, MAX(captured_at) AS m
             FROM finance_balance_snapshots GROUP BY account_id
         ) latest ON latest.account_id = s.account_id AND latest.m = s.captured_at`
    )
    .all() as Array<{ account_id: number; balance: number }>
  const balById = new Map<number, number>()
  for (const r of latest) balById.set(r.account_id, r.balance)
  const startingBalances: Record<number, number> = {}
  for (const a of accounts) startingBalances[a.id] = balById.get(a.id) ?? 0

  const forecast = buildForecast(db, sqlite, startingBalances, {
    windowDays: LOW_CASH_HORIZON_DAYS,
    lowCashThreshold: threshold,
    today: now
  })

  return buildLowCashAlert(forecast.lowDates, cashNameById, {
    enabled: true,
    threshold,
    today: localYmd(now)
  })
}

/**
 * Pure summarizer: keep only the audited subscriptions flagged with a recent
 * price hike, largest dollar delta first, and cap the surfaced list.
 */
export function buildPriceHikeAlert(
  subscriptions: Subscription[],
  opts: { enabled: boolean }
): PriceHikeAlert {
  if (!opts.enabled) return emptyPriceHikes()
  const hikes = subscriptions
    .filter((s) => s.priceHike)
    .sort((a, b) => b.priceHikeDelta - a.priceHikeDelta)
  return {
    enabled: true,
    count: hikes.length,
    items: hikes.slice(0, MAX_PER_SECTION).map((s) => ({
      merchant: s.merchant,
      cadence: s.cadence,
      recentMedian: s.recentMedian,
      historicalMedian: s.historicalMedian,
      delta: s.priceHikeDelta,
      pct: s.priceHikePct
    }))
  }
}

/**
 * Boundary helper: read the opt-in `priceHikeAlertEnabled` setting, run the
 * subscription audit (which computes the recent-vs-historical hike deltas), and
 * summarize. Disabled → empty without touching the audit.
 */
export function computePriceHikeAlert(
  db: ReturnType<typeof getDb> = getDb(),
  now: Date = new Date()
): PriceHikeAlert {
  const enabledRow = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'priceHikeAlertEnabled'))
    .get()
  if (enabledRow?.value !== 'true') return emptyPriceHikes()

  const audit = auditSubscriptions(db, { today: now })
  return buildPriceHikeAlert(audit.active, { enabled: true })
}

/**
 * Assemble the digest from current DB state. `now` is injectable for tests +
 * the future scheduled-notification caller; defaults to the live clock.
 */
export function buildMorningBrief(
  db: ReturnType<typeof getDb> = getDb(),
  now: Date = new Date(),
  lowCash: LowCashAlert = emptyLowCash(),
  priceHikes: PriceHikeAlert = emptyPriceHikes()
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

  const payments = { count: payItems.length, items: payItems.slice(0, MAX_PER_SECTION) }

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
    lowCash,
    priceHikes,
    summary: buildSummary(
      calendar.count,
      tasks.dueCount,
      payments.count,
      inbox.count,
      lowCash,
      priceHikes
    )
  }
}

export function registerMorningBriefHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('morning-brief:get', (): MorningBrief => {
    const db = getDb()
    const now = new Date()
    return buildMorningBrief(
      db,
      now,
      computeLowCashAlert(db, getRawSqlite(), now),
      computePriceHikeAlert(db, now)
    )
  })
}

/**
 * Translate a local `HH:MM` (24h) into a daily cron expression (`M H * * *`),
 * or null when the time is empty/invalid (= notification off). Pure — used by
 * the cron scheduler and unit-tested directly.
 */
export function morningBriefCronExpr(time: string | null | undefined): string | null {
  if (!time) return null
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (!match) return null
  return `${Number(match[2])} ${Number(match[1])} * * *`
}

/**
 * Build the digest and fire a single OS notification summarizing it. Best-effort
 * (mirrors `sync.ts maybeSendNotification`): respects the `notificationsEnabled`
 * setting, no-ops when nothing is actionable, and when the platform has no
 * notification support. Returns whether a notification was shown — handy for
 * the cron caller's logs and for tests.
 */
export function notifyMorningBrief(
  db: ReturnType<typeof getDb> = getDb(),
  now: Date = new Date(),
  lowCash: LowCashAlert = emptyLowCash(),
  priceHikes: PriceHikeAlert = emptyPriceHikes()
): boolean {
  const brief = buildMorningBrief(db, now, lowCash, priceHikes)
  const total =
    brief.calendar.count +
    brief.tasks.dueCount +
    brief.payments.count +
    brief.inbox.count +
    (brief.lowCash.soonest ? 1 : 0) +
    brief.priceHikes.count
  if (total === 0) return false // nothing worth interrupting the user for
  if (!Notification.isSupported()) return false

  const row = db.select().from(appSettings).where(eq(appSettings.key, 'notificationsEnabled')).get()
  if (row && row.value === 'false') return false

  new Notification({ title: `${brief.greeting} — today's brief`, body: brief.summary }).show()
  return true
}
