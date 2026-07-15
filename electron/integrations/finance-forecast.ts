/**
 * 90-day forward cash-flow projection (Phase 4.5).
 *
 * Combines five event streams into a per-account daily balance trajectory:
 *   1. Active subscriptions (from auditSubscriptions) → recurring outflows
 *   1b. Owned subscriptions (the Storehouse `subscriptions` table) with no
 *      active ledger match → recurring outflows for cash-paid,
 *      family-plan-split, or newly-added-but-not-yet-charged subscriptions
 *      that auditSubscriptions() can never see, since it only reads
 *      transaction history
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
import { matchKeyForSubscription } from '../lib/merchant-match'
import { convert, getBaseCurrency, loadFxRates } from './finance-fx'
import { mergeIncomeStreams, paystubsToIncomeStreams, readArgylePaystubs } from './finance-income'
import { type Cadence, type Subscription, auditSubscriptions } from './finance-subscriptions'

const DAY_MS = 24 * 60 * 60 * 1000

export type ForecastSource = 'subscription' | 'income' | 'debt' | 'calendar' | 'override'

export type ForecastEvent = {
  date: string // YYYY-MM-DD — DISPLAY date (after any shift)
  accountId: number | null
  amount: number // negative = outflow, positive = inflow
  label: string
  source: ForecastSource
  confidence: 'high' | 'medium' | 'low'
  // Original auto-event date — set whenever the row was produced from a
  // 'shift' override so the UI can call delete-forecast-override with the
  // ORIGINAL date the row is keyed by in the DB. Undefined for non-shifted
  // rows (in which case `date` is the original).
  originalDate?: string
  // True for events the user marked 'skip'. The trajectory walker excludes
  // these from balance math, but they remain in the events list so the UI
  // can offer a Reset path. Without this flag a skipped event would
  // disappear entirely from the UI and become un-restorable.
  skipped?: boolean
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
  balance: number // in the account's NATIVE currency
  // The same balance converted to the user's base currency (Phase 11.1 rollup).
  // Equals `balance` for base-currency accounts and when no FX rate is available.
  balanceBase: number
}

export type ForecastResult = {
  events: ForecastEvent[]
  trajectory: TrajectoryPoint[]
  // `balance` is native; `balanceBase` is the base-currency value the low-cash
  // threshold is actually compared against (so a colón account's dip is caught).
  lowDates: Array<{ accountId: number; date: string; balance: number; balanceBase: number }>
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

/** Returns a new Date at local midnight of the same calendar day. */
export function startOfDayLocal(d: Date): Date {
  const next = new Date(d)
  next.setHours(0, 0, 0, 0)
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

export type OwnedSubscriptionInput = {
  externalId: string
  name: string
  cost: number
  cadence: string
  paymentAccount: string | null
  nextRenewal: string | null
}

/**
 * Match against the ACTIVE audited stream only — scoped to `active` (not
 * `findAuditMatch`'s all-statuses search in electron/ipc/subscriptions.ts)
 * because only active audit entries feed `projectSubscriptionEvents`; a
 * match against a zombie/expired entry means nothing is currently being
 * projected for that merchant, so the owned row still needs its own event.
 *
 * Deliberately NOT account-fallback like `findAuditMatch`: when the owned
 * row names a specific `paymentAccount`, a merchant match on a DIFFERENT
 * account is treated as a distinct instance, not a duplicate — the
 * family-plan-split case (same merchant, separately charged to two
 * accounts) must produce two forecast events, not collapse to one. Only
 * when the owned row has no account on file do we fall back to a
 * merchant-only match, giving it the benefit of the doubt that it's the
 * same subscription the ledger already detected.
 */
function hasActiveAuditMatch(
  activeAudited: Subscription[],
  matchKey: string,
  accountHint: string | null
): boolean {
  if (accountHint) {
    return activeAudited.some((s) => s.merchant === matchKey && s.account === accountHint)
  }
  return activeAudited.some((s) => s.merchant === matchKey)
}

/** Runtime-narrows a raw DB string to `Cadence` instead of an unchecked `as Cadence` cast. */
function isCadence(value: string): value is Cadence {
  return Object.hasOwn(CADENCE_DAYS, value)
}

/**
 * Project forecast events for user-OWNED subscriptions (the Storehouse
 * `subscriptions` table, electron/ipc/subscriptions.ts) that have no active
 * match in the ledger-derived audit stream — cash-paid, family-plan-split,
 * or newly added but not yet charged. `auditSubscriptions()` only sees
 * transaction history, so these would otherwise silently contribute nothing
 * to the forecast even though their cost/cadence/next renewal are known.
 *
 * Dedup uses `matchKeyForSubscription`, the same key that links an owned row
 * to a detected one everywhere else in the app — so a subscription that's
 * both owned AND transaction-detected is counted exactly once (via the
 * `audit.active`-driven `projectSubscriptionEvents` stream, not this one).
 *
 * Anchors on `nextRenewal` when known (fast-forwarding past any stale date,
 * same as the lastSeen+cadence anchor in `projectSubscriptionEvents`); falls
 * back to "one cadence out from today" for rows with no renewal date on file.
 */
export function projectOwnedSubscriptionEvents(
  subs: OwnedSubscriptionInput[],
  activeAudited: Subscription[],
  accountIdByName: Map<string, number>,
  defaultCashAccountId: number | null,
  today: Date,
  windowDays: number
): ForecastEvent[] {
  const out: ForecastEvent[] = []
  const horizon = addDays(today, windowDays)

  for (const sub of subs) {
    if (!isCadence(sub.cadence) || !(sub.cost > 0)) continue
    const stepDays = CADENCE_DAYS[sub.cadence]

    const matchKey = matchKeyForSubscription(sub.externalId, sub.name)
    if (hasActiveAuditMatch(activeAudited, matchKey, sub.paymentAccount)) continue

    // No resolvable account and no default cash account → nothing to route
    // the outflow to (better silent than misleading, same rule as debt/
    // calendar events).
    const accountId =
      (sub.paymentAccount ? accountIdByName.get(sub.paymentAccount) : undefined) ??
      defaultCashAccountId ??
      undefined
    if (accountId === undefined) continue

    // nextRenewal is user-entered and never format-validated at write time —
    // a malformed value (partial date, garbage string) parses to an Invalid
    // Date, and `Invalid Date <= x` is always false, which would silently
    // skip both fast-forward loops below and emit zero events. Fall back to
    // the same "one cadence out from today" anchor used when it's unset.
    const parsedRenewal = sub.nextRenewal ? parseLocalDate(sub.nextRenewal) : null
    let next =
      parsedRenewal && !Number.isNaN(parsedRenewal.getTime())
        ? parsedRenewal
        : addDays(today, stepDays)
    while (next <= today) next = addDays(next, stepDays)

    while (next <= horizon) {
      out.push({
        date: localDateString(next),
        accountId,
        amount: -Math.abs(sub.cost),
        label: sub.name,
        source: 'subscription',
        // User-declared, not verified against transaction history — never
        // 'high' the way a long charge history can be.
        confidence: 'medium'
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
 * Match key is `accountId:date:label` — label is required so two events on
 * the same account+day (e.g. payroll and rent, or two subscriptions) can be
 * edited independently. The DB enforces uniqueness via the unique index
 * `uq_forecast_overrides_account_date_label`, and the IPC rejects writes
 * without a label, so the (accountId, date, label) tuple is the only valid
 * shape going forward. Override rows with a null label are ignored — they
 * can only enter the DB through direct writes that bypass the IPC, and we
 * don't want to silently apply a no-label override to multiple events.
 */
export function applyOverrides(
  events: ForecastEvent[],
  overrides: ForecastOverride[]
): ForecastEvent[] {
  const byKey = new Map<string, ForecastOverride>()
  for (const o of overrides) {
    if (o.accountId === null || !o.date || !o.label) continue
    byKey.set(`${o.accountId}:${o.date}:${o.label}`, o)
  }

  const out: ForecastEvent[] = []
  for (const ev of events) {
    if (ev.accountId === null) {
      out.push(ev)
      continue
    }
    const o = byKey.get(`${ev.accountId}:${ev.date}:${ev.label}`)
    if (!o) {
      out.push(ev)
      continue
    }
    if (o.kind === 'skip') {
      // Keep the row but flag it skipped so the UI can offer Reset.
      // projectCashflow filters these out before walking balances.
      out.push({ ...ev, source: 'override', confidence: 'high', skipped: true })
      continue
    }
    if (o.kind === 'shift' && o.shiftToDate) {
      // `date` becomes the shifted display date; preserve the original so
      // the UI can call delete-forecast-override with the right key.
      out.push({
        ...ev,
        date: o.shiftToDate,
        originalDate: ev.date,
        source: 'override',
        confidence: 'high'
      })
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
 * Returns one TrajectoryPoint per (account, day) when the balance changed.
 *
 * Same-day events for the same account are AGGREGATED before walking — so
 * a $100 outflow and a $200 inflow on 5/15 become a single +$100 day-end
 * change. Without this, walking events in arbitrary within-day order could
 * spuriously dip the intermediate balance below the low-cash threshold even
 * though the day ends in a net surplus.
 */
export function projectCashflow(
  events: ForecastEvent[],
  startingBalances: Record<number, number>,
  today: Date,
  windowDays: number,
  lowCashThreshold: number = LOW_CASH_DEFAULT,
  toBase: (accountId: number, amount: number) => number | null = () => null
): ForecastResult {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date))
  const balances: Record<number, number> = { ...startingBalances }
  const trajectory: TrajectoryPoint[] = []
  const lowDates: ForecastResult['lowDates'] = []
  const seenLow = new Set<number>()

  // Convert an account-native balance to base currency for the rollup + the
  // low-cash check; fall back to the native value when no rate is available
  // (best effort — matches pre-multi-currency behaviour for that account).
  const inBase = (accountId: number, amount: number): number =>
    round2(toBase(accountId, amount) ?? amount)

  const todayKey = localDateString(today)
  const horizonKey = localDateString(addDays(today, windowDays))

  // Seed: today's balance for every known account.
  for (const [acctIdStr, bal] of Object.entries(balances)) {
    const acctId = Number(acctIdStr)
    trajectory.push({
      date: todayKey,
      accountId: acctId,
      balance: round2(bal),
      balanceBase: inBase(acctId, bal)
    })
  }

  // Aggregate by (date, accountId) so same-day events fold into one net change.
  // Skipped events are kept in `events` for UI rendering (so the user can
  // restore them) but excluded from the trajectory math here.
  const aggregated = new Map<string, { date: string; accountId: number; netAmount: number }>()
  for (const ev of sorted) {
    if (ev.accountId === null) continue
    if (ev.skipped) continue
    if (ev.date < todayKey || ev.date > horizonKey) continue
    const key = `${ev.date}:${ev.accountId}`
    const existing = aggregated.get(key)
    if (existing) {
      existing.netAmount += ev.amount
    } else {
      aggregated.set(key, { date: ev.date, accountId: ev.accountId, netAmount: ev.amount })
    }
  }

  // Walk in chronological order. Same-day entries are already merged.
  const inOrder = [...aggregated.values()].sort((a, b) => a.date.localeCompare(b.date))
  for (const day of inOrder) {
    const prev = balances[day.accountId] ?? 0
    const next = prev + day.netAmount
    balances[day.accountId] = next
    const nextBase = inBase(day.accountId, next)
    trajectory.push({
      date: day.date,
      accountId: day.accountId,
      balance: round2(next),
      balanceBase: nextBase
    })
    if (nextBase < lowCashThreshold && !seenLow.has(day.accountId)) {
      seenLow.add(day.accountId)
      lowDates.push({
        accountId: day.accountId,
        date: day.date,
        balance: round2(next),
        balanceBase: nextBase
      })
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
  // Normalize to local midnight so the projection is stable within a calendar
  // day regardless of when the user opens the Forecast tab. Without this,
  // `cursor <= today` comparisons in the per-stream projections would shift
  // event inclusion based on time-of-day.
  const today = options.today ? startOfDayLocal(options.today) : startOfDayLocal(new Date())
  const windowDays = options.windowDays ?? 90
  const lowCashThreshold = options.lowCashThreshold ?? LOW_CASH_DEFAULT

  // 1. Subscriptions.
  const audit = auditSubscriptions(db, { today })
  const accounts = sqlite
    .prepare(
      'SELECT id, name, currency, is_debt, min_payment, payment_day_of_month, payment_due_date FROM finance_accounts'
    )
    .all() as Array<{
    id: number
    name: string
    currency: string
    is_debt: number
    min_payment: number | null
    payment_day_of_month: number | null
    payment_due_date: string | null
  }>
  const accountIdByName = new Map<string, number>()
  for (const a of accounts) accountIdByName.set(a.name, a.id)
  const subEvents = projectSubscriptionEvents(audit.active, accountIdByName, today, windowDays)

  // The default cash account — where paystub income and debt/bill outflows are
  // routed (the forecast answers "will my cash be short?").
  const defaultCashAccountId = accounts.find((a) => a.is_debt !== 1)?.id ?? null

  // 1b. Owned subscriptions (Storehouse) with no active ledger match — see
  // projectOwnedSubscriptionEvents for why this stream exists.
  const ownedSubRows = sqlite
    .prepare(
      `SELECT external_id, name, cost, cadence, payment_account, next_renewal
         FROM subscriptions WHERE status = 'active'`
    )
    .all() as Array<{
    external_id: string
    name: string
    cost: number
    cadence: string
    payment_account: string | null
    next_renewal: string | null
  }>
  const ownedSubEvents = projectOwnedSubscriptionEvents(
    ownedSubRows.map((r) => ({
      externalId: r.external_id,
      name: r.name,
      cost: r.cost,
      cadence: r.cadence,
      paymentAccount: r.payment_account,
      nextRenewal: r.next_renewal
    })),
    audit.active,
    accountIdByName,
    defaultCashAccountId,
    today,
    windowDays
  )

  // 2. Recurring income. Prefer REAL Argyle paystubs (ground-truth cadence + net
  // pay) over bank-deposit inference; the matching inferred stream is suppressed
  // so the same paycheck isn't double-counted. With no paystubs the merge returns
  // the inferred streams unchanged → zero change for users without Argyle.
  const inferredIncome = detectRecurringIncome(sqlite, { today })
  const paystubIncome = paystubsToIncomeStreams(readArgylePaystubs(sqlite), {
    defaultCashAccountId
  })
  const incomeStreams = mergeIncomeStreams(paystubIncome, inferredIncome)
  const incomeEvents = projectIncomeEvents(incomeStreams, today, windowDays)

  // 3. Debt minimums — routed to a cash account so the forecast captures
  // the cash impact (the whole point of "will I be short?"). Net Worth
  // tracks the corresponding liability decrease.
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
    [...subEvents, ...ownedSubEvents, ...incomeEvents, ...debtEvents, ...calEvents],
    overrides
  )

  // Base-currency rollup: convert each account's projected balance into the
  // user's base currency so the low-cash threshold (a base-currency number) is
  // compared apples-to-apples across a multi-currency ledger. A colón account
  // whose huge CRC balances never tripped a $500 threshold now does once its
  // USD-equivalent dips. Accounts already in the base currency, or with no FX
  // rate available, pass through unconverted.
  const baseCurrency = getBaseCurrency(sqlite)
  const fxRates = loadFxRates(sqlite)
  const currencyByAccount = new Map<number, string>()
  for (const a of accounts) currencyByAccount.set(a.id, a.currency)
  const toBase = (accountId: number, amount: number): number | null => {
    const cur = currencyByAccount.get(accountId) ?? baseCurrency
    return cur === baseCurrency ? amount : convert(amount, cur, baseCurrency, fxRates)
  }

  return projectCashflow(allEvents, startingBalances, today, windowDays, lowCashThreshold, toBase)
}
