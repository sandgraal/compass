/**
 * Tests for the Morning Brief aggregator + handler (Phase 7 Track A).
 *
 * buildMorningBrief is exercised directly with a fixed `now` against a real
 * in-memory SQLite (so the local-day window, the 7-day payment cutoff, the
 * unchecked-task filter, and the done-inbox filter all run under true SQL +
 * real Date math). The `morning-brief:get` handler gets a registration +
 * empty-state smoke test.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { Subscription } from '../integrations/finance-subscriptions'
import type { MorningBrief } from './morning-brief'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

// Forecast engine is exercised by its own suite — here we control its output so
// computeLowCashAlert's settings-gating + cash-account filtering are tested in
// isolation (no need to seed the full subscription/income/calendar feed set).
type ForecastReturn = {
  events: unknown[]
  trajectory: unknown[]
  lowDates: Array<{ accountId: number; date: string; balance: number }>
}
const buildForecastMock = vi.fn<(...args: unknown[]) => ForecastReturn>(() => ({
  events: [],
  trajectory: [],
  lowDates: []
}))
vi.mock('../integrations/finance-forecast', () => ({
  buildForecast: (...args: unknown[]) => buildForecastMock(...args)
}))

// Subscription audit is likewise controlled here so computePriceHikeAlert's
// settings-gating + hike summarization are tested without seeding a full
// recurring-transaction stream (the audit has its own suite).
type AuditReturn = {
  totalActiveAnnual: number
  active: unknown[]
  zombies: unknown[]
  expired: unknown[]
  duplicates: unknown[]
}
const auditSubscriptionsMock = vi.fn<(...args: unknown[]) => AuditReturn>(() => ({
  totalActiveAnnual: 0,
  active: [],
  zombies: [],
  expired: [],
  duplicates: []
}))
vi.mock('../integrations/finance-subscriptions', () => ({
  auditSubscriptions: (...args: unknown[]) => auditSubscriptionsMock(...args)
}))

// electron Notification — a class (vitest 4 needs function/class under `new`),
// with a spy ctor + show + settable isSupported.
const notificationShowMock = vi.fn()
const notificationCtorMock = vi.fn()
const notificationIsSupportedMock = vi.fn(() => true)
class MockNotification {
  show = notificationShowMock
  constructor(options: unknown) {
    notificationCtorMock(options)
  }
}
vi.mock('electron', () => ({
  Notification: Object.assign(MockNotification, { isSupported: notificationIsSupportedMock })
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      description TEXT,
      html_link TEXT,
      synced_at INTEGER
    );
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      checked INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal',
      sort_order INTEGER DEFAULT 0,
      due_date TEXT,
      source TEXT DEFAULT 'manual',
      source_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      updated_at INTEGER,
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      plaid_item_id INTEGER,
      plaid_account_id TEXT,
      mask TEXT
    );
    CREATE TABLE gmail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      action_summary TEXT,
      snippet TEXT,
      received_at INTEGER,
      snoozed_until TEXT,
      done INTEGER DEFAULT 0,
      synced_at INTEGER
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  notificationIsSupportedMock.mockReturnValue(true)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

// ── Helpers (local-time frame matches the fixed `now` passed to the builder) ──

let evtSeq = 0
function seedEvent(
  title: string,
  startLocal: Date,
  opts: { source?: string; allDay?: boolean } = {}
) {
  evtSeq++
  sqlite
    .prepare(
      'INSERT INTO calendar_events (source, external_id, title, start_at, all_day) VALUES (?, ?, ?, ?, ?)'
    )
    .run(opts.source ?? 'google', `evt-${evtSeq}`, title, startLocal.getTime(), opts.allDay ? 1 : 0)
}
function seedTask(
  title: string,
  listDate: string,
  opts: { checked?: boolean; sortOrder?: number } = {}
) {
  sqlite
    .prepare(
      "INSERT INTO checklist_items (list_type, list_date, title, checked, sort_order, created_at) VALUES ('daily', ?, ?, ?, ?, 0)"
    )
    .run(listDate, title, opts.checked ? 1 : 0, opts.sortOrder ?? 0)
}
function seedDebt(
  name: string,
  paymentDueDate: string | null,
  opts: { isDebt?: boolean; minPayment?: number } = {}
) {
  sqlite
    .prepare(
      "INSERT INTO finance_accounts (name, type, is_debt, min_payment, payment_due_date) VALUES (?, 'credit', ?, ?, ?)"
    )
    .run(name, opts.isDebt === false ? 0 : 1, opts.minPayment ?? 0, paymentDueDate)
}
let gmailSeq = 0
function seedGmail(subject: string, opts: { done?: boolean } = {}) {
  gmailSeq++
  sqlite
    .prepare(
      "INSERT INTO gmail_actions (thread_id, subject, from_address, done) VALUES (?, ?, 'sam@example.com', ?)"
    )
    .run(`thr-${gmailSeq}`, subject, opts.done ? 1 : 0)
}

async function buildAt(now: Date) {
  const { buildMorningBrief } = await import('./morning-brief')
  return buildMorningBrief(drizzle(sqlite, { schema }), now)
}

// Fixed reference: 2026-05-15 09:00 LOCAL → today '2026-05-15', "Good morning".
const NOW = new Date(2026, 4, 15, 9, 0, 0)

// ── aggregation ──────────────────────────────────────────────────────────────

describe('buildMorningBrief', () => {
  it('greets by time of day and stamps the local date', async () => {
    expect((await buildAt(new Date(2026, 4, 15, 9, 0, 0))).greeting).toBe('Good morning')
    expect((await buildAt(new Date(2026, 4, 15, 13, 0, 0))).greeting).toBe('Good afternoon')
    expect((await buildAt(new Date(2026, 4, 15, 20, 0, 0))).greeting).toBe('Good evening')
    expect((await buildAt(NOW)).date).toBe('2026-05-15')
  })

  it("includes only today's calendar events, time-sorted", async () => {
    seedEvent('Standup', new Date(2026, 4, 15, 10, 0, 0))
    seedEvent('Coffee', new Date(2026, 4, 15, 8, 0, 0))
    seedEvent('Yesterday', new Date(2026, 4, 14, 10, 0, 0)) // excluded
    seedEvent('Tomorrow', new Date(2026, 4, 16, 10, 0, 0)) // excluded
    const brief = await buildAt(NOW)
    expect(brief.calendar.count).toBe(2)
    expect(brief.calendar.events.map((e) => e.title)).toEqual(['Coffee', 'Standup'])
  })

  it("counts only today's unchecked daily tasks", async () => {
    seedTask('Write report', '2026-05-15', { sortOrder: 2 })
    seedTask('Reply to Sam', '2026-05-15', { sortOrder: 1 })
    seedTask('Done thing', '2026-05-15', { checked: true }) // excluded
    seedTask('Yesterday task', '2026-05-14') // excluded
    const brief = await buildAt(NOW)
    expect(brief.tasks.dueCount).toBe(2)
    expect(brief.tasks.items.map((t) => t.title)).toEqual(['Reply to Sam', 'Write report'])
  })

  it('lists debt payments due within 7 days, with daysRemaining + minPayment', async () => {
    seedDebt('Visa', '2026-05-18', { minPayment: 35 }) // 3 days out — in window
    seedDebt('Amex', '2026-05-15', { minPayment: 50 }) // due today — in window
    seedDebt('Mortgage', '2026-05-30') // out of window — excluded
    seedDebt('Checking', '2026-05-16', { isDebt: false }) // not a debt — excluded
    const brief = await buildAt(NOW)
    expect(brief.payments.count).toBe(2)
    expect(brief.payments.items.map((p) => p.name)).toEqual(['Amex', 'Visa']) // sorted by date
    expect(brief.payments.items[0]).toMatchObject({ daysRemaining: 0, minPayment: 50 })
    expect(brief.payments.items[1]).toMatchObject({ daysRemaining: 3, minPayment: 35 })
  })

  it('counts unresolved inbox items only', async () => {
    seedGmail('Invoice due')
    seedGmail('Project ping')
    seedGmail('Already handled', { done: true }) // excluded
    const brief = await buildAt(NOW)
    expect(brief.inbox.count).toBe(2)
    expect(brief.inbox.items.map((m) => m.subject)).toEqual(['Invoice due', 'Project ping'])
  })

  it('builds a human summary that omits zero finance/inbox sections', async () => {
    seedEvent('Standup', new Date(2026, 4, 15, 10, 0, 0))
    seedTask('One task', '2026-05-15')
    // no payments, no inbox
    const brief = await buildAt(NOW)
    expect(brief.summary).toBe('1 event today · 1 task due')
  })

  it('caps every section at 5 items but keeps the true counts', async () => {
    for (let i = 0; i < 8; i++) {
      seedTask(`task ${i}`, '2026-05-15', { sortOrder: i })
      seedEvent(`event ${i}`, new Date(2026, 4, 15, 8, i, 0))
      seedGmail(`inbox ${i}`)
    }
    // 6 debts, each due on a distinct day within the 7-day window (05-15..05-21).
    for (let i = 0; i < 6; i++) seedDebt(`debt ${i}`, `2026-05-${15 + i}`)

    const brief = await buildAt(NOW)
    expect(brief.tasks.dueCount).toBe(8)
    expect(brief.tasks.items).toHaveLength(5)
    expect(brief.calendar.count).toBe(8)
    expect(brief.calendar.events).toHaveLength(5)
    expect(brief.inbox.count).toBe(8)
    expect(brief.inbox.items).toHaveLength(5)
    expect(brief.payments.count).toBe(6)
    expect(brief.payments.items).toHaveLength(5)
  })
})

// ── handler ──────────────────────────────────────────────────────────────────

describe('morning-brief:get handler', () => {
  it('registers and returns the digest shape on an empty DB', async () => {
    const mod = await import('./morning-brief')
    mod.registerMorningBriefHandlers(fakeIpcMain as IpcMain)
    const h = handlers['morning-brief:get']
    expect(h).toBeDefined()
    const brief = (await Promise.resolve().then(() => h({}))) as MorningBrief
    expect(brief).toMatchObject({
      calendar: { count: 0, events: [] },
      tasks: { dueCount: 0, items: [] },
      payments: { count: 0, items: [] },
      inbox: { count: 0, items: [] }
    })
    expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(brief.greeting)
    expect(brief.summary).toBe('0 events today · 0 tasks due')
  })
})

// ── morningBriefCronExpr ─────────────────────────────────────────────────────

describe('morningBriefCronExpr', () => {
  it('maps a valid HH:MM to a daily cron expression (M H * * *)', async () => {
    const { morningBriefCronExpr } = await import('./morning-brief')
    expect(morningBriefCronExpr('07:30')).toBe('30 7 * * *')
    expect(morningBriefCronExpr('00:00')).toBe('0 0 * * *')
    expect(morningBriefCronExpr('9:05')).toBe('5 9 * * *')
    expect(morningBriefCronExpr('23:59')).toBe('59 23 * * *')
  })

  it('returns null when off (empty / null / undefined)', async () => {
    const { morningBriefCronExpr } = await import('./morning-brief')
    expect(morningBriefCronExpr('')).toBeNull()
    expect(morningBriefCronExpr(null)).toBeNull()
    expect(morningBriefCronExpr(undefined)).toBeNull()
  })

  it('returns null for malformed times', async () => {
    const { morningBriefCronExpr } = await import('./morning-brief')
    for (const bad of ['24:00', '25:30', '12:60', '7', '7:5', 'abc', '08:00x']) {
      expect(morningBriefCronExpr(bad)).toBeNull()
    }
  })
})

// ── notifyMorningBrief ───────────────────────────────────────────────────────

describe('notifyMorningBrief', () => {
  async function notifyAt(now: Date) {
    const { notifyMorningBrief } = await import('./morning-brief')
    return notifyMorningBrief(drizzle(sqlite, { schema }), now)
  }

  it('fires a notification summarizing the day when something is actionable', async () => {
    seedTask('Reply to Sam', '2026-05-15')
    seedEvent('Standup', new Date(2026, 4, 15, 10, 0, 0))
    const shown = await notifyAt(NOW)
    expect(shown).toBe(true)
    expect(notificationCtorMock).toHaveBeenCalledOnce()
    const arg = notificationCtorMock.mock.calls[0][0] as { title: string; body: string }
    expect(arg.title).toBe("Good morning — today's brief")
    expect(arg.body).toBe('1 event today · 1 task due')
    expect(notificationShowMock).toHaveBeenCalledOnce()
  })

  it('no-ops when nothing is actionable (empty day)', async () => {
    const shown = await notifyAt(NOW)
    expect(shown).toBe(false)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('respects notificationsEnabled=false', async () => {
    seedTask('Reply to Sam', '2026-05-15')
    sqlite
      .prepare("INSERT INTO app_settings (key, value) VALUES ('notificationsEnabled', 'false')")
      .run()
    const shown = await notifyAt(NOW)
    expect(shown).toBe(false)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('no-ops when the platform has no notification support', async () => {
    seedTask('Reply to Sam', '2026-05-15')
    notificationIsSupportedMock.mockReturnValue(false)
    const shown = await notifyAt(NOW)
    expect(shown).toBe(false)
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })
})

// ── buildLowCashAlert (pure) ──────────────────────────────────────────────────

describe('buildLowCashAlert', () => {
  const names = new Map<number, string>([
    [1, 'Checking'],
    [2, 'Savings']
  ])

  it('returns a disabled empty alert when disabled (ignores lowDates)', async () => {
    const { buildLowCashAlert } = await import('./morning-brief')
    const r = buildLowCashAlert([{ accountId: 1, date: '2026-05-20', balance: 12 }], names, {
      enabled: false,
      threshold: 500,
      today: '2026-05-15'
    })
    expect(r).toEqual({ enabled: false, threshold: 500, count: 0, soonest: null })
  })

  it('picks the earliest dip and counts affected cash accounts', async () => {
    const { buildLowCashAlert } = await import('./morning-brief')
    const r = buildLowCashAlert(
      [
        { accountId: 2, date: '2026-05-25', balance: 100 },
        { accountId: 1, date: '2026-05-19', balance: -50 }
      ],
      names,
      { enabled: true, threshold: 500, today: '2026-05-15' }
    )
    expect(r.enabled).toBe(true)
    expect(r.count).toBe(2)
    expect(r.soonest).toEqual({
      accountId: 1,
      accountName: 'Checking',
      date: '2026-05-19',
      balance: -50,
      daysRemaining: 4
    })
  })

  it('ignores dips on accounts not in the cash map (e.g. debt accounts)', async () => {
    const { buildLowCashAlert } = await import('./morning-brief')
    const r = buildLowCashAlert(
      [
        { accountId: 9, date: '2026-05-16', balance: 5 }, // unknown → excluded
        { accountId: 2, date: '2026-05-22', balance: 200 }
      ],
      names,
      { enabled: true, threshold: 500, today: '2026-05-15' }
    )
    expect(r.count).toBe(1)
    expect(r.soonest?.accountId).toBe(2)
  })

  it('reports no soonest when nothing dips', async () => {
    const { buildLowCashAlert } = await import('./morning-brief')
    const r = buildLowCashAlert([], names, { enabled: true, threshold: 500, today: '2026-05-15' })
    expect(r).toEqual({ enabled: true, threshold: 500, count: 0, soonest: null })
  })
})

// ── computeLowCashAlert (settings-gating + cash filtering) ─────────────────────

function setSetting(key: string, value: string) {
  sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, value)
}
function seedCashAccount(name: string, opts: { isDebt?: boolean } = {}) {
  sqlite
    .prepare("INSERT INTO finance_accounts (name, type, is_debt) VALUES (?, 'checking', ?)")
    .run(name, opts.isDebt ? 1 : 0)
}

describe('computeLowCashAlert', () => {
  async function compute(now: Date) {
    const { computeLowCashAlert } = await import('./morning-brief')
    return computeLowCashAlert(drizzle(sqlite, { schema }), sqlite, now)
  }
  const NOW = new Date(2026, 4, 15, 8, 0, 0)

  it('is disabled by default and never calls the forecast', async () => {
    const r = await compute(NOW)
    expect(r.enabled).toBe(false)
    expect(buildForecastMock).not.toHaveBeenCalled()
  })

  it('defaults the threshold to 500 and clamps a negative override', async () => {
    setSetting('lowCashAlertEnabled', 'true')
    setSetting('lowCashThreshold', '-9999')
    await compute(NOW)
    const opts = buildForecastMock.mock.calls[0][3] as {
      lowCashThreshold: number
      windowDays: number
    }
    expect(opts.lowCashThreshold).toBe(0)
    expect(opts.windowDays).toBe(14)
  })

  it('summarizes the forecast dip for a cash account when enabled', async () => {
    setSetting('lowCashAlertEnabled', 'true')
    setSetting('lowCashThreshold', '500')
    seedCashAccount('Checking') // id 1, cash
    seedCashAccount('Card', { isDebt: true }) // id 2, debt → excluded
    buildForecastMock.mockReturnValueOnce({
      events: [],
      trajectory: [],
      lowDates: [
        { accountId: 1, date: '2026-05-21', balance: 120 },
        { accountId: 2, date: '2026-05-18', balance: 3 } // debt → must be ignored
      ]
    })
    const r = await compute(NOW)
    expect(r.enabled).toBe(true)
    expect(r.threshold).toBe(500)
    expect(r.count).toBe(1)
    expect(r.soonest).toMatchObject({ accountId: 1, accountName: 'Checking', balance: 120 })
  })
})

// ── low-cash threaded into the brief + notification ───────────────────────────

describe('low-cash in the assembled brief', () => {
  const ALERT = {
    enabled: true,
    threshold: 500,
    count: 1,
    soonest: {
      accountId: 1,
      accountName: 'Checking',
      date: '2026-05-19',
      balance: 120,
      daysRemaining: 4
    }
  }

  it('buildMorningBrief embeds the injected alert and flags it in the summary', async () => {
    const { buildMorningBrief } = await import('./morning-brief')
    const brief = buildMorningBrief(drizzle(sqlite, { schema }), NOW, ALERT)
    expect(brief.lowCash).toEqual(ALERT)
    expect(brief.summary).toContain('low cash ahead')
  })

  it('notifyMorningBrief fires on a low-cash-only day (no other items)', async () => {
    const { notifyMorningBrief } = await import('./morning-brief')
    const shown = notifyMorningBrief(drizzle(sqlite, { schema }), NOW, ALERT)
    expect(shown).toBe(true)
    expect(notificationCtorMock).toHaveBeenCalledOnce()
  })
})

// ── price-hike alert ──────────────────────────────────────────────────────────

// Minimal Subscription factory — only the fields buildPriceHikeAlert reads
// vary; the rest are plausible defaults so the object satisfies the type.
function mkSub(over: {
  merchant: string
  priceHike?: boolean
  priceHikeDelta?: number
  priceHikePct?: number
  recentMedian?: number
  historicalMedian?: number
  cadence?: string
}): Subscription {
  return {
    merchant: over.merchant,
    account: 'Card',
    category: 'subscriptions',
    subcategory: '',
    cadence: (over.cadence ?? 'monthly') as Subscription['cadence'],
    medianAmount: over.recentMedian ?? 10,
    minAmount: 5,
    maxAmount: 20,
    annualCost: 120,
    firstSeen: '2026-01-01',
    lastSeen: '2026-05-01',
    daysSinceLast: 5,
    nCharges: 6,
    status: 'active' as Subscription['status'],
    priceBump: false,
    priceHike: over.priceHike ?? false,
    priceHikeDelta: over.priceHikeDelta ?? 0,
    priceHikePct: over.priceHikePct ?? 0,
    recentMedian: over.recentMedian ?? 10,
    historicalMedian: over.historicalMedian ?? 10
  }
}

describe('buildPriceHikeAlert', () => {
  it('returns disabled empty when disabled (ignores subscriptions)', async () => {
    const { buildPriceHikeAlert } = await import('./morning-brief')
    const r = buildPriceHikeAlert([mkSub({ merchant: 'Netflix', priceHike: true })], {
      enabled: false
    })
    expect(r).toEqual({ enabled: false, count: 0, items: [] })
  })

  it('keeps only hikes, largest dollar delta first', async () => {
    const { buildPriceHikeAlert } = await import('./morning-brief')
    const r = buildPriceHikeAlert(
      [
        mkSub({ merchant: 'Calm', priceHike: false, priceHikeDelta: 99 }), // not a hike
        mkSub({ merchant: 'Spotify', priceHike: true, priceHikeDelta: 2, priceHikePct: 20 }),
        mkSub({ merchant: 'Disney+', priceHike: true, priceHikeDelta: 5, priceHikePct: 38 })
      ],
      { enabled: true }
    )
    expect(r.enabled).toBe(true)
    expect(r.count).toBe(2)
    expect(r.items.map((i) => i.merchant)).toEqual(['Disney+', 'Spotify'])
    expect(r.items[0]).toMatchObject({ delta: 5, pct: 38 })
  })

  it('caps the surfaced list at 5 but keeps the true count', async () => {
    const { buildPriceHikeAlert } = await import('./morning-brief')
    const subs = Array.from({ length: 8 }, (_, i) =>
      mkSub({ merchant: `m${i}`, priceHike: true, priceHikeDelta: i + 1 })
    )
    const r = buildPriceHikeAlert(subs, { enabled: true })
    expect(r.count).toBe(8)
    expect(r.items).toHaveLength(5)
    expect(r.items[0].merchant).toBe('m7') // delta 8, highest
  })

  it('reports no hikes when none are flagged', async () => {
    const { buildPriceHikeAlert } = await import('./morning-brief')
    const r = buildPriceHikeAlert([mkSub({ merchant: 'Netflix' })], { enabled: true })
    expect(r).toEqual({ enabled: true, count: 0, items: [] })
  })
})

describe('computePriceHikeAlert', () => {
  async function compute(now: Date) {
    const { computePriceHikeAlert } = await import('./morning-brief')
    return computePriceHikeAlert(drizzle(sqlite, { schema }), now)
  }
  const NOW2 = new Date(2026, 4, 15, 8, 0, 0)

  it('is disabled by default and never runs the audit', async () => {
    const r = await compute(NOW2)
    expect(r.enabled).toBe(false)
    expect(auditSubscriptionsMock).not.toHaveBeenCalled()
  })

  it('summarizes audited hikes when enabled', async () => {
    setSetting('priceHikeAlertEnabled', 'true')
    auditSubscriptionsMock.mockReturnValueOnce({
      totalActiveAnnual: 0,
      active: [
        mkSub({ merchant: 'Steady', priceHike: false }),
        mkSub({ merchant: 'Hulu', priceHike: true, priceHikeDelta: 4, priceHikePct: 25 })
      ],
      zombies: [],
      expired: [],
      duplicates: []
    })
    const r = await compute(NOW2)
    expect(r.enabled).toBe(true)
    expect(r.count).toBe(1)
    expect(r.items[0]).toMatchObject({ merchant: 'Hulu', delta: 4, pct: 25 })
  })
})

describe('price-hike in the assembled brief', () => {
  const HIKES = {
    enabled: true,
    count: 2,
    items: [
      {
        merchant: 'Disney+',
        cadence: 'monthly',
        recentMedian: 18,
        historicalMedian: 13,
        delta: 5,
        pct: 38
      }
    ]
  }

  it('buildMorningBrief embeds the injected hikes and flags the summary', async () => {
    const { buildMorningBrief } = await import('./morning-brief')
    const brief = buildMorningBrief(drizzle(sqlite, { schema }), NOW, undefined, HIKES)
    expect(brief.priceHikes).toEqual(HIKES)
    expect(brief.summary).toContain('2 price hikes')
  })

  it('notifyMorningBrief fires on a price-hike-only day', async () => {
    const { notifyMorningBrief } = await import('./morning-brief')
    const shown = notifyMorningBrief(drizzle(sqlite, { schema }), NOW, undefined, HIKES)
    expect(shown).toBe(true)
    expect(notificationCtorMock).toHaveBeenCalledOnce()
  })
})
