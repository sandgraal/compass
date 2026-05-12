/**
 * 90-day forward cash-flow projection (Phase 4.5).
 *
 * Combines four event streams into a per-account daily balance trajectory:
 *   1. Active subscriptions (from auditSubscriptions) → recurring outflows
 *   2. Recurring income (detected from positive-amount transaction history)
 *      → payroll / retainer inflows
 *   3. Debt minimum payments (from financeAccounts.minPayment +
 *      paymentDayOfMonth) → monthly outflows
 *   4. Calendar bills (events whose title matches finance keywords) →
 *      one-shot outflows
 *
 * User overrides (skip / shift / override) live in `forecast_overrides` and
 * mutate the auto-generated stream before projection.
 *
 * The math is pure — `projectCashflow()` takes already-prepared events and
 * starting balances, applies overrides, and walks day-by-day. The DB-backed
 * `buildForecast()` orchestrates loading the inputs.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../db/schema'
import { type Cadence, type Subscription, auditSubscriptions } from './finance-subscriptions'

const DAY_MS = 24 * 60 * 60 * 1000

export type ForecastSource = 'subscription' | 'income' | 'debt' | 'calendar' | 'override'

export type ForecastEvent = {
  date: string // YYYY-MM-DD
  accountId: number | null
  amount: number // negative = outflow, positive = inflow
  label: string
  source: ForecastSource
  confidence: 'high' | 'medium' | 'low'
}

export type ForecastOverride = {
  accountId: number
  date: string // ISO date of the auto-event being overridden
  amount: number | null
  label: string | null
  kind: 'skip' | 'shift' | 'override'
  shiftToDate: string | null
}

export type TrajectoryPoint = {
  date: string // YYYY-MM-DD
  accountId: number
  balance: number
}

export type ForecastResult = {
  events: ForecastEvent[]
  trajectory: TrajectoryPoint[]
  lowDates: Array<{ accountId: number; date: string; balance: number }>
}

const LOW_CASH_DEFAULT = 500

const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30, // approximation — real-world months vary; trajectory smooths over 90d
  quarterly: 91,
  'semi-annual': 182,
  yearly: 365
}

// Calendar-event titles whose words flag the event as a finance bill.
const CALENDAR_BILL_KEYWORDS = [
  'bill',
  'rent',
  'mortgage',
  'utilities',
  'insurance',
  'tuition',
  'tax',
  'hoa',
  'lease',
  'payment due'
]

// ─── Pure helpers (testable in isolation) ───────────────────────────────────

/** Format a Date as 'YYYY-MM-DD' using local-time fields. */
export function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** Parse a 'YYYY-MM-DD' string back to a local-midnight Date. */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** Add `days` to a local Date (returns a new Date, leaves the input intact). */
function addDays(d: Date, days: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + days)
  return next
}

function confidenceFromCharges(n: number): 'high' | 'medium' | 'low' {
  if (n > 6) return 'high'
  if (n >= 3) return 'medium'
  return 'low'
}

/**
 * Project subscription events forward over `windowDays`. The first
 * projection lands `cadence-days` after `lastSeen` (with a min of `today + 1`
 * so we never project a charge for today or earlier).
 */
export function projectSubscriptionEvents(
  subs: Subscription[],
  accountIdByName: Map<string, number>,
  today: Date,
  windowDays: number
): ForecastEvent[] {
  const out: ForecastEvent[] = []
  const horizon = addDays(today, windowDays)

  for (const sub of subs) {
    const stepDays = CADENCE_DAYS[sub.cadence]
    if (!stepDays) continue
    const accountId = accountIdByName.get(sub.account) ?? null
    if (accountId === null) continue
    const lastSeen = parseLocalDate(sub.lastSeen)
    let next = addDays(lastSeen, stepDays)
    // Skip past-due projections — fast-forward to the first future date.
    while (next <= today) next = addDays(next, stepDays)

    while (next <= horizon) {
      out.push({
        date: localDateString(next),
        accountId,
        amount: -Math.abs(sub.medianAmount),
        label: sub.merchant,
        source: 'subscription',
        confidence: confidenceFromCharges(sub.nCharges)
      })
      next = addDays(next, stepDays)
    }
  }
  return out
}

export type RecurringIncomeStream = {
  accountId: number
  label: string
  cadence: Cadence
  medianAmount: number
  lastSeen: string // 'YYYY-MM-DD'
  nDeposits: number
}

/**
 * Project recurring income forward identically to subscriptions. Stream is
 * already detected by detectRecurringIncome(); this just walks the cadence.
 */
export function projectIncomeEvents(
  streams: RecurringIncomeStream[],
  today: Date,
  windowDays: number
): ForecastEvent[] {
  const out: ForecastEvent[] = []
  const horizon = addDays(today, windowDays)

  for (const stream of streams) {
    const stepDays = CADENCE_DAYS[stream.cadence]
    if (!stepDays) continue
    let next = addDays(parseLocalDate(stream.lastSeen), stepDays)
    while (next <= today) next = addDays(next, stepDays)

    const conf = stream.nDeposits >= 6 ? 'high' : stream.nDeposits >= 3 ? 'medium' : 'low'

    while (next <= horizon) {
      out.push({
        date: localDateString(next),
        accountId: stream.accountId,
        amount: Math.abs(stream.medianAmount),
        label: stream.label,
        source: 'income',
        confidence: conf
      })
      next = addDays(next, stepDays)
    }
  }
  return out
}

/**
 * Detect recurring positive-amount inflows (payroll, retainers) per
 * (account_id, normalized-description) group. Requires at least 2 deposits
 * with detectable cadence. Pure SQLite — no Drizzle.
 */
export type SqliteForForecast = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

export function detectRecurringIncome(
  sqlite: SqliteForForecast,
  options: { lookbackDays?: number; today?: Date } = {}
): RecurringIncomeStream[] {
  const today = options.today ?? new Date()
  const lookback = options.lookbackDays ?? 365
  const cutoff = localDateString(addDays(today, -lookback))

  // Exclude debt accounts — for those, positive amounts are PAYMENTS that
  // reduce what's owed, not income. Without this filter, monthly credit-
  // card payments get mis-detected as recurring income and the forecast
  // projects them forward as inflows on the debt account, inflating both
  // the debt balance AND total assets.
  const rows = sqlite
    .prepare(
      `SELECT t.account_id, t.description, t.date, t.amount
         FROM finance_transactions t
         JOIN finance_accounts a ON a.id = t.account_id
        WHERE t.amount > 0
          AND t.account_id IS NOT NULL
          AND t.date >= ?
          AND COALESCE(a.is_debt, 0) = 0
        ORDER BY t.date ASC`
    )
    .all(cutoff) as Array<{
    account_id: number
    description: string
    date: string
    amount: number
  }>

  // Group by (accountId, normalizedDesc). Reuse the merchant normalizer
  // shape from finance-subscriptions: lowercased, stripped of IDs.
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const norm = normalizeIncomeDescription(row.description)
    if (!norm) continue
    const key = `${row.account_id}::${norm}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const streams: RecurringIncomeStream[] = []
  for (const [key, list] of groups.entries()) {
    if (list.length < 2) continue
    const accountId = list[0].account_id
    const dates = list.map((r) => parseLocalDate(r.date))
    const cadence = detectCadenceFromDates(dates)
    if (!cadence) continue
    const amounts = list.map((r) => r.amount)
    streams.push({
      accountId,
      label: key.split('::').slice(1).join('::'),
      cadence,
      medianAmount: median(amounts),
      lastSeen: list[list.length - 1].date,
      nDeposits: list.length
    })
  }
  return streams
}

function normalizeIncomeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\b(direct deposit|payroll|salary|deposit)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ')
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function detectCadenceFromDates(dates: Date[]): Cadence | null {
  if (dates.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < dates.length; i++) {
    gaps.push(Math.round((dates[i].getTime() - dates[i - 1].getTime()) / DAY_MS))
  }
  const med = median(gaps)
  if (med >= 25 && med <= 35) return 'monthly'
  if (med >= 6 && med <= 9) return 'weekly'
  if (med >= 12 && med <= 16) return 'biweekly'
  if (med >= 80 && med <= 100) return 'quarterly'
  return null
}

/**
 * Project debt minimum-payment events for every debt account that has a
 * non-zero minPayment. Schedules them on `paymentDayOfMonth` (or the 1st if
 * unset). Each month within the window emits one event per debt account.
 *
 * IMPORTANT: the outflow is routed to `defaultCashAccountId` rather than the
 * debt account itself. The forecast's job is to answer "will my cash be
 * short?" — paying a credit-card minimum withdraws money from a checking
 * account. Tracking the corresponding debt-balance reduction belongs to the
 * Net Worth view (Phase 4.4), not the cash forecast. If no cash account is
 * supplied, debt events are skipped (better silent than misleading).
 */
export function projectDebtEvents(
  debts: Array<{
    id: number
    minPayment: number | null
    paymentDayOfMonth: number | null
    paymentDueDate: string | null
    name: string
  }>,
  defaultCashAccountId: number | null,
  today: Date,
  windowDays: number
): ForecastEvent[] {
  if (defaultCashAccountId === null) return []
  const out: ForecastEvent[] = []
  const horizon = addDays(today, windowDays)

  for (const d of debts) {
    const min = d.minPayment ?? 0
    if (!Number.isFinite(min) || min <= 0) continue
    const dayOfMonth = clampDayOfMonth(
      d.paymentDayOfMonth ?? deriveDayFromDueDate(d.paymentDueDate) ?? 1
    )

    let cursor = new Date(today.getFullYear(), today.getMonth(), dayOfMonth)
    if (cursor <= today) cursor = addMonths(cursor, 1)
    while (cursor <= horizon) {
      out.push({
        date: localDateString(cursor),
        accountId: defaultCashAccountId,
        amount: -min,
        label: `${d.name} minimum payment`,
        source: 'debt',
        confidence: 'high'
      })
      cursor = addMonths(cursor, 1)
    }
  }
  return out
}

function clampDayOfMonth(day: number): number {
  if (!Number.isFinite(day)) return 1
  return Math.min(28, Math.max(1, Math.floor(day)))
}

function deriveDayFromDueDate(due: string | null): number | null {
  if (!due) return null
  const m = due.match(/^\d{4}-\d{2}-(\d{2})$/)
  if (!m) return null
  return Number.parseInt(m[1], 10)
}

function addMonths(d: Date, months: number): Date {
  const next = new Date(d)
  next.setMonth(next.getMonth() + months)
  return next
}

/**
 * Pull calendar events whose title matches a finance keyword and project
 * them as one-shot outflows. Amount is unknown → 0 (UI flags low-confidence).
 */
export function projectCalendarEvents(
  events: Array<{ title: string; startAt: number | null }>,
  defaultAccountId: number | null,
  today: Date,
  windowDays: number
): ForecastEvent[] {
  if (defaultAccountId === null) return []
  const out: ForecastEvent[] = []
  const horizon = addDays(today, windowDays)
  const horizonMs = horizon.getTime()
  const todayMs = today.getTime()

  for (const ev of events) {
    if (ev.startAt == null) continue
    if (ev.startAt < todayMs || ev.startAt > horizonMs) continue
    const titleLower = ev.title.toLowerCase()
    if (!CALENDAR_BILL_KEYWORDS.some((kw) => titleLower.includes(kw))) continue
    out.push({
      date: localDateString(new Date(ev.startAt)),
      accountId: defaultAccountId,
      amount: 0,
      label: ev.title,
      source: 'calendar',
      confidence: 'low'
    })
  }
  return out
}

/**
 * Apply user overrides to an auto-generated event stream. Returns a NEW
 * array with skip/shift/override semantics applied; original input is not
 * mutated.
 *
 * Match key is `accountId:date:label` — including label so two events on
 * the same account+day (e.g. payroll and rent, or two subscriptions) can
 * be edited independently. An override row stored without a label
 * (`label: null`) falls back to date-only matching for backward compat,
 * but the IPC `set-forecast-override` handler should always pass one.
 */
export function applyOverrides(
  events: ForecastEvent[],
  overrides: ForecastOverride[]
): ForecastEvent[] {
  // Two lookup tables: precise (accountId+date+label) and a fallback
  // (accountId+date) for legacy rows that didn't supply a label.
  const byPreciseKey = new Map<string, ForecastOverride>()
  const byFallbackKey = new Map<string, ForecastOverride>()
  for (const o of overrides) {
    if (o.accountId === null || !o.date) continue
    if (o.label) {
      byPreciseKey.set(`${o.accountId}:${o.date}:${o.label}`, o)
    } else {
      byFallbackKey.set(`${o.accountId}:${o.date}`, o)
    }
  }

  const out: ForecastEvent[] = []
  for (const ev of events) {
    if (ev.accountId === null) {
      out.push(ev)
      continue
    }
    const o =
      byPreciseKey.get(`${ev.accountId}:${ev.date}:${ev.label}`) ??
      byFallbackKey.get(`${ev.accountId}:${ev.date}`)
    if (!o) {
      out.push(ev)
      continue
    }
    if (o.kind === 'skip') continue
    if (o.kind === 'shift' && o.shiftToDate) {
      out.push({ ...ev, date: o.shiftToDate, source: 'override', confidence: 'high' })
      continue
    }
    if (o.kind === 'override') {
      // Label is the match key — it stays. Only amount is replaced.
      out.push({
        ...ev,
        amount: o.amount ?? ev.amount,
        source: 'override',
        confidence: 'high'
      })
      continue
    }
    out.push(ev)
  }
  return out
}

/**
 * Walk events day-by-day applying them to per-account starting balances.
 * Returns one TrajectoryPoint per (account, day) where the balance changed
 * (no point on quiet days — the UI fills horizontally).
 *
 * This is the hot loop. ~90 days × 12 accounts × ~30 events = trivial.
 */
export function projectCashflow(
  events: ForecastEvent[],
  startingBalances: Record<number, number>,
  today: Date,
  windowDays: number,
  lowCashThreshold: number = LOW_CASH_DEFAULT
): ForecastResult {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date))
  const balances: Record<number, number> = { ...startingBalances }
  const trajectory: TrajectoryPoint[] = []
  const lowDates: ForecastResult['lowDates'] = []
  const seenLow = new Set<number>()

  // Seed: today's balance for every known account.
  const todayKey = localDateString(today)
  for (const [acctIdStr, bal] of Object.entries(balances)) {
    const acctId = Number(acctIdStr)
    trajectory.push({ date: todayKey, accountId: acctId, balance: round2(bal) })
  }

  const horizonKey = localDateString(addDays(today, windowDays))

  for (const ev of sorted) {
    if (ev.accountId === null) continue
    if (ev.date < todayKey || ev.date > horizonKey) continue
    const prev = balances[ev.accountId] ?? 0
    const next = prev + ev.amount
    balances[ev.accountId] = next
    trajectory.push({ date: ev.date, accountId: ev.accountId, balance: round2(next) })
    if (next < lowCashThreshold && !seenLow.has(ev.accountId)) {
      seenLow.add(ev.accountId)
      lowDates.push({ accountId: ev.accountId, date: ev.date, balance: round2(next) })
    }
  }

  return { events: sorted, trajectory, lowDates }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── DB orchestration ───────────────────────────────────────────────────────

export type BuildForecastOptions = {
  windowDays?: number
  today?: Date
  lowCashThreshold?: number
}

/**
 * Pull every input the engine needs and produce the forecast. Caller
 * supplies starting balances (typically from `getNetWorthSnapshot().byAccount`).
 */
export function buildForecast(
  db: BetterSQLite3Database<typeof schema>,
  sqlite: SqliteForForecast,
  startingBalances: Record<number, number>,
  options: BuildForecastOptions = {}
): ForecastResult {
  const today = options.today ?? new Date()
  const windowDays = options.windowDays ?? 90
  const lowCashThreshold = options.lowCashThreshold ?? LOW_CASH_DEFAULT

  // 1. Subscriptions.
  const audit = auditSubscriptions(db, { today })
  const accounts = sqlite
    .prepare(
      'SELECT id, name, is_debt, min_payment, payment_day_of_month, payment_due_date FROM finance_accounts'
    )
    .all() as Array<{
    id: number
    name: string
    is_debt: number
    min_payment: number | null
    payment_day_of_month: number | null
    payment_due_date: string | null
  }>
  const accountIdByName = new Map<string, number>()
  for (const a of accounts) accountIdByName.set(a.name, a.id)
  const subEvents = projectSubscriptionEvents(audit.active, accountIdByName, today, windowDays)

  // 2. Recurring income.
  const incomeStreams = detectRecurringIncome(sqlite, { today })
  const incomeEvents = projectIncomeEvents(incomeStreams, today, windowDays)

  // 3. Debt minimums — routed to a cash account so the forecast captures
  // the cash impact (the whole point of "will I be short?"). Net Worth
  // tracks the corresponding liability decrease.
  const defaultCashAccountId = accounts.find((a) => a.is_debt !== 1)?.id ?? null
  const debts = accounts
    .filter((a) => a.is_debt === 1)
    .map((a) => ({
      id: a.id,
      name: a.name,
      minPayment: a.min_payment,
      paymentDayOfMonth: a.payment_day_of_month,
      paymentDueDate: a.payment_due_date
    }))
  const debtEvents = projectDebtEvents(debts, defaultCashAccountId, today, windowDays)

  // 4. Calendar bills — same default cash account as debt payments.
  const calRows = sqlite
    .prepare('SELECT title, start_at FROM calendar_events WHERE start_at IS NOT NULL')
    .all() as Array<{ title: string; start_at: number }>
  const calEvents = projectCalendarEvents(
    calRows.map((r) => ({ title: r.title, startAt: r.start_at })),
    defaultCashAccountId,
    today,
    windowDays
  )

  // 5. Apply overrides.
  const overrideRows = sqlite
    .prepare('SELECT account_id, date, amount, label, kind, shift_to_date FROM forecast_overrides')
    .all() as Array<{
    account_id: number
    date: string
    amount: number | null
    label: string | null
    kind: string
    shift_to_date: string | null
  }>
  const overrides: ForecastOverride[] = overrideRows
    .filter((r) => r.kind === 'skip' || r.kind === 'shift' || r.kind === 'override')
    .map((r) => ({
      accountId: r.account_id,
      date: r.date,
      amount: r.amount,
      label: r.label,
      kind: r.kind as 'skip' | 'shift' | 'override',
      shiftToDate: r.shift_to_date
    }))

  const allEvents = applyOverrides(
    [...subEvents, ...incomeEvents, ...debtEvents, ...calEvents],
    overrides
  )

  return projectCashflow(allEvents, startingBalances, today, windowDays, lowCashThreshold)
}
