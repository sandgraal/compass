import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  type ForecastEvent,
  type ForecastOverride,
  type RecurringIncomeStream,
  applyOverrides,
  detectRecurringIncome,
  localDateString,
  parseLocalDate,
  projectCalendarEvents,
  projectCashflow,
  projectDebtEvents,
  projectIncomeEvents,
  projectSubscriptionEvents
} from './finance-forecast'
import type { Subscription } from './finance-subscriptions'

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    merchant: 'netflix',
    account: 'Chase',
    category: 'Subscriptions',
    subcategory: 'Streaming',
    cadence: 'monthly',
    medianAmount: 15.99,
    minAmount: 15.99,
    maxAmount: 15.99,
    annualCost: 191.88,
    firstSeen: '2025-01-15',
    lastSeen: '2026-04-15',
    daysSinceLast: 30,
    nCharges: 12,
    status: 'active',
    priceBump: false,
    ...overrides
  }
}

describe('localDateString / parseLocalDate', () => {
  it('round-trips a local-time date', () => {
    const d = new Date(2026, 4, 11, 14, 30) // 2026-05-11 local
    const s = localDateString(d)
    expect(s).toBe('2026-05-11')
    const parsed = parseLocalDate(s)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(4)
    expect(parsed.getDate()).toBe(11)
  })

  it('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5)
    expect(localDateString(d)).toBe('2026-01-05')
  })
})

describe('projectSubscriptionEvents', () => {
  const today = new Date(2026, 4, 1) // 2026-05-01

  it('emits one event per cadence cycle within the window', () => {
    const subs = [makeSub({ cadence: 'monthly', lastSeen: '2026-04-15' })]
    const acctMap = new Map([['Chase', 1]])
    const events = projectSubscriptionEvents(subs, acctMap, today, 90)
    // Monthly from 2026-04-15: next firings at 5/15, 6/14, 7/14 (within 90d)
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.amount === -15.99)).toBe(true)
    expect(events.every((e) => e.source === 'subscription')).toBe(true)
    expect(events[0].date).toBe('2026-05-15')
  })

  it('skips subscriptions whose account is not mapped', () => {
    const subs = [makeSub({ account: 'UnknownBank' })]
    const events = projectSubscriptionEvents(subs, new Map(), today, 90)
    expect(events).toHaveLength(0)
  })

  it('confidence reflects nCharges', () => {
    const acctMap = new Map([['Chase', 1]])
    const high = projectSubscriptionEvents([makeSub({ nCharges: 12 })], acctMap, today, 30)
    const med = projectSubscriptionEvents([makeSub({ nCharges: 4 })], acctMap, today, 30)
    const low = projectSubscriptionEvents([makeSub({ nCharges: 2 })], acctMap, today, 30)
    expect(high[0].confidence).toBe('high')
    expect(med[0].confidence).toBe('medium')
    expect(low[0].confidence).toBe('low')
  })
})

describe('projectIncomeEvents', () => {
  const today = new Date(2026, 4, 1)

  it('emits inflows with positive amounts', () => {
    const stream: RecurringIncomeStream = {
      accountId: 1,
      label: 'acme payroll',
      cadence: 'biweekly',
      medianAmount: 3000,
      lastSeen: '2026-04-20',
      nDeposits: 12
    }
    const events = projectIncomeEvents([stream], today, 60)
    // Biweekly from 2026-04-20 over 60 days: 5/4, 5/18, 6/1, 6/15, 6/29
    expect(events).toHaveLength(5)
    expect(events.every((e) => e.amount === 3000)).toBe(true)
    expect(events.every((e) => e.source === 'income')).toBe(true)
    expect(events[0].confidence).toBe('high') // 12 deposits
    expect(events[0].date).toBe('2026-05-04')
  })

  it('marks low-cycle income as medium/low confidence', () => {
    const stream: RecurringIncomeStream = {
      accountId: 1,
      label: 'side gig',
      cadence: 'monthly',
      medianAmount: 500,
      lastSeen: '2026-04-15',
      nDeposits: 4
    }
    const events = projectIncomeEvents([stream], today, 90)
    expect(events[0].confidence).toBe('medium')
  })
})

describe('projectDebtEvents', () => {
  const today = new Date(2026, 4, 5)
  const CASH = 99 // any non-debt account id

  it('emits one minimum payment per month within the window', () => {
    const debts = [
      {
        id: 1,
        name: 'Amex',
        minPayment: 35,
        paymentDayOfMonth: 15,
        paymentDueDate: null
      }
    ]
    const events = projectDebtEvents(debts, CASH, today, 90)
    // From 5/5, the 15th lands at 5/15, 6/15, 7/15 — three events in 90d
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.amount === -35)).toBe(true)
    expect(events.every((e) => e.source === 'debt')).toBe(true)
    expect(events[0].date).toBe('2026-05-15')
  })

  it('routes the outflow to the cash account, not the debt account', () => {
    const debts = [
      { id: 7, name: 'Amex', minPayment: 35, paymentDayOfMonth: 15, paymentDueDate: null }
    ]
    const events = projectDebtEvents(debts, CASH, today, 60)
    // accountId is the CASH account, not the debt account (id=7).
    expect(events.every((e) => e.accountId === CASH)).toBe(true)
    // The debt account name is preserved in the label so the UI can show it.
    expect(events[0].label).toContain('Amex')
  })

  it('returns [] when no cash account is supplied', () => {
    const debts = [
      { id: 1, name: 'Amex', minPayment: 35, paymentDayOfMonth: 15, paymentDueDate: null }
    ]
    expect(projectDebtEvents(debts, null, today, 90)).toHaveLength(0)
  })

  it('falls back to paymentDueDate day when paymentDayOfMonth is unset', () => {
    const debts = [
      {
        id: 1,
        name: 'Amex',
        minPayment: 35,
        paymentDayOfMonth: null,
        paymentDueDate: '2026-05-22'
      }
    ]
    const events = projectDebtEvents(debts, CASH, today, 35)
    expect(events[0].date).toBe('2026-05-22')
  })

  it('skips debts with no minPayment', () => {
    const debts = [
      { id: 1, name: 'Paid Off', minPayment: 0, paymentDayOfMonth: 15, paymentDueDate: null }
    ]
    expect(projectDebtEvents(debts, CASH, today, 90)).toHaveLength(0)
  })

  it('clamps day-of-month to 1-28 for safety on short months', () => {
    const debts = [
      { id: 1, name: 'Amex', minPayment: 50, paymentDayOfMonth: 31, paymentDueDate: null }
    ]
    const events = projectDebtEvents(debts, CASH, today, 35)
    expect(events[0].date).toBe('2026-05-28')
  })
})

describe('projectCalendarEvents', () => {
  const today = new Date(2026, 4, 1)

  it('matches finance keywords case-insensitively', () => {
    const cal = [
      { title: 'Pay Rent', startAt: new Date(2026, 4, 5).getTime() },
      { title: 'Lunch with Sam', startAt: new Date(2026, 4, 8).getTime() },
      { title: 'Property Tax due', startAt: new Date(2026, 5, 1).getTime() }
    ]
    const events = projectCalendarEvents(cal, 1, today, 90)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.label)).toEqual(['Pay Rent', 'Property Tax due'])
    expect(events.every((e) => e.confidence === 'low')).toBe(true)
  })

  it('returns [] when no default account is set', () => {
    const cal = [{ title: 'Rent', startAt: new Date(2026, 4, 5).getTime() }]
    expect(projectCalendarEvents(cal, null, today, 90)).toHaveLength(0)
  })

  it('clips events outside the window', () => {
    const cal = [
      { title: 'Rent', startAt: new Date(2025, 0, 1).getTime() }, // past
      { title: 'Tax', startAt: new Date(2027, 5, 1).getTime() } // > 90d future
    ]
    expect(projectCalendarEvents(cal, 1, today, 90)).toHaveLength(0)
  })
})

describe('applyOverrides', () => {
  const baseEvent: ForecastEvent = {
    date: '2026-05-15',
    accountId: 1,
    amount: -15.99,
    label: 'netflix',
    source: 'subscription',
    confidence: 'high'
  }

  it('skip removes the matching event', () => {
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: null,
        kind: 'skip',
        shiftToDate: null
      }
    ]
    const out = applyOverrides([baseEvent], overrides)
    expect(out).toHaveLength(0)
  })

  it('shift moves the event to a new date', () => {
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: null,
        kind: 'shift',
        shiftToDate: '2026-05-20'
      }
    ]
    const out = applyOverrides([baseEvent], overrides)
    expect(out).toHaveLength(1)
    expect(out[0].date).toBe('2026-05-20')
    expect(out[0].source).toBe('override')
  })

  it('override replaces the amount, keeps the label as the match key', () => {
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: -25,
        label: 'netflix', // matches the event's label
        kind: 'override',
        shiftToDate: null
      }
    ]
    const out = applyOverrides([baseEvent], overrides)
    expect(out[0].amount).toBe(-25)
    expect(out[0].label).toBe('netflix') // label preserved
    expect(out[0].source).toBe('override')
  })

  it('does not touch unrelated events', () => {
    const other: ForecastEvent = { ...baseEvent, accountId: 2, label: 'spotify' }
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: null,
        kind: 'skip',
        shiftToDate: null
      }
    ]
    const out = applyOverrides([baseEvent, other], overrides)
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('spotify')
  })
})

describe('projectCashflow', () => {
  const today = new Date(2026, 4, 1)

  it('walks events day-by-day applying them to starting balances', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-05',
        accountId: 1,
        amount: -100,
        label: 'rent',
        source: 'calendar',
        confidence: 'low'
      },
      {
        date: '2026-05-15',
        accountId: 1,
        amount: 3000,
        label: 'payroll',
        source: 'income',
        confidence: 'high'
      }
    ]
    const result = projectCashflow(events, { 1: 1000 }, today, 30)
    // Seed point + 2 events = 3 trajectory points for account 1
    expect(result.trajectory.length).toBeGreaterThanOrEqual(3)
    const final = result.trajectory[result.trajectory.length - 1]
    expect(final.balance).toBe(3900) // 1000 - 100 + 3000
  })

  it('flags low-cash dates when an account dips below threshold', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-10',
        accountId: 1,
        amount: -800,
        label: 'rent',
        source: 'calendar',
        confidence: 'low'
      }
    ]
    const result = projectCashflow(events, { 1: 1000 }, today, 30, 500)
    expect(result.lowDates).toHaveLength(1)
    expect(result.lowDates[0].accountId).toBe(1)
    expect(result.lowDates[0].balance).toBe(200)
  })

  it('does not flag the same account twice in lowDates', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-05',
        accountId: 1,
        amount: -800,
        label: 'a',
        source: 'debt',
        confidence: 'high'
      },
      {
        date: '2026-05-10',
        accountId: 1,
        amount: -50,
        label: 'b',
        source: 'subscription',
        confidence: 'high'
      }
    ]
    const result = projectCashflow(events, { 1: 1000 }, today, 30, 500)
    expect(result.lowDates).toHaveLength(1)
  })

  it('includes a seed point for every starting balance even with no events', () => {
    const result = projectCashflow([], { 1: 1000, 2: 500 }, today, 30)
    expect(result.trajectory).toHaveLength(2)
  })

  it('clips events outside the window', () => {
    const events: ForecastEvent[] = [
      {
        date: '2027-01-01',
        accountId: 1,
        amount: -100,
        label: 'far future',
        source: 'calendar',
        confidence: 'low'
      }
    ]
    const result = projectCashflow(events, { 1: 1000 }, today, 30)
    expect(result.trajectory).toHaveLength(1) // seed only
  })
})

describe('detectRecurringIncome', () => {
  function makeDb(): Database.Database {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE finance_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_debt INTEGER DEFAULT 0
      );
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        date TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO finance_accounts (id, name, is_debt) VALUES (1, 'Chase', 0);
    `)
    return sqlite
  }

  it('detects biweekly payroll', () => {
    const sqlite = makeDb()
    const ins = sqlite.prepare(
      'INSERT INTO finance_transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)'
    )
    ins.run(1, '2026-01-09', 3000, 'Acme Inc Direct Deposit')
    ins.run(1, '2026-01-23', 3000, 'Acme Inc Direct Deposit')
    ins.run(1, '2026-02-06', 3000, 'Acme Inc Direct Deposit')
    ins.run(1, '2026-02-20', 3000, 'Acme Inc Direct Deposit')
    ins.run(1, '2026-03-06', 3000, 'Acme Inc Direct Deposit')

    const streams = detectRecurringIncome(sqlite, { today: new Date(2026, 2, 10) })
    expect(streams).toHaveLength(1)
    expect(streams[0].cadence).toBe('biweekly')
    expect(streams[0].medianAmount).toBe(3000)
    expect(streams[0].nDeposits).toBe(5)
  })

  it('ignores one-off deposits', () => {
    const sqlite = makeDb()
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (account_id, date, amount, description) VALUES (1, ?, ?, ?)'
      )
      .run('2026-01-15', 500, 'Gift from Grandma')

    const streams = detectRecurringIncome(sqlite, { today: new Date(2026, 2, 1) })
    expect(streams).toHaveLength(0)
  })

  it('ignores transactions without an account', () => {
    const sqlite = makeDb()
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, description) VALUES (?, ?, ?)')
      .run('2026-01-15', 3000, 'Some Deposit')
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, description) VALUES (?, ?, ?)')
      .run('2026-02-15', 3000, 'Some Deposit')
    expect(detectRecurringIncome(sqlite, { today: new Date(2026, 2, 1) })).toHaveLength(0)
  })

  it('does NOT detect monthly credit-card payments on a debt account as income', () => {
    const sqlite = makeDb()
    // makeDb() seeds account id=1 as 'Chase' (cash). Replace it with a
    // debt account + add a separate cash account for the payroll comparison.
    sqlite.prepare('DELETE FROM finance_accounts').run()
    sqlite.prepare("INSERT INTO finance_accounts (id, name, is_debt) VALUES (1, 'Amex', 1)").run()
    sqlite.prepare("INSERT INTO finance_accounts (id, name, is_debt) VALUES (2, 'Chase', 0)").run()
    const ins = sqlite.prepare(
      'INSERT INTO finance_transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)'
    )
    // Three monthly $300 payments from the user TO the credit card —
    // appear as positive amounts on the debt account.
    ins.run(1, '2026-01-15', 300, 'Payment from Chase')
    ins.run(1, '2026-02-15', 300, 'Payment from Chase')
    ins.run(1, '2026-03-15', 300, 'Payment from Chase')
    // For comparison: a real biweekly payroll on the cash account.
    ins.run(2, '2026-01-09', 3000, 'Acme Inc Direct Deposit')
    ins.run(2, '2026-01-23', 3000, 'Acme Inc Direct Deposit')
    ins.run(2, '2026-02-06', 3000, 'Acme Inc Direct Deposit')

    const streams = detectRecurringIncome(sqlite, { today: new Date(2026, 2, 20) })
    // Only the payroll stream — debt-account positives are excluded.
    expect(streams).toHaveLength(1)
    expect(streams[0].accountId).toBe(2)
    expect(streams[0].cadence).toBe('biweekly')
  })
})

describe('applyOverrides — same-day same-account collision', () => {
  const today = new Date(2026, 4, 1)

  it('skips only the matching event when two events land on the same account+day', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-15',
        accountId: 1,
        amount: -16,
        label: 'netflix',
        source: 'subscription',
        confidence: 'high'
      },
      {
        date: '2026-05-15',
        accountId: 1,
        amount: -10,
        label: 'spotify',
        source: 'subscription',
        confidence: 'high'
      }
    ]
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: 'netflix',
        kind: 'skip',
        shiftToDate: null
      }
    ]
    const out = applyOverrides(events, overrides)
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('spotify')
  })

  it('shifts only the matching event', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-15',
        accountId: 1,
        amount: -1500,
        label: 'rent',
        source: 'calendar',
        confidence: 'low'
      },
      {
        date: '2026-05-15',
        accountId: 1,
        amount: 3000,
        label: 'payroll',
        source: 'income',
        confidence: 'high'
      }
    ]
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: 'rent',
        kind: 'shift',
        shiftToDate: '2026-05-20'
      }
    ]
    const out = applyOverrides(events, overrides)
    const rent = out.find((e) => e.label === 'rent')
    const payroll = out.find((e) => e.label === 'payroll')
    expect(rent?.date).toBe('2026-05-20')
    expect(payroll?.date).toBe('2026-05-15') // untouched
  })

  it('falls back to date-only matching when override has no label (legacy rows)', () => {
    const events: ForecastEvent[] = [
      {
        date: '2026-05-15',
        accountId: 1,
        amount: -16,
        label: 'netflix',
        source: 'subscription',
        confidence: 'high'
      }
    ]
    const overrides: ForecastOverride[] = [
      {
        accountId: 1,
        date: '2026-05-15',
        amount: null,
        label: null,
        kind: 'skip',
        shiftToDate: null
      }
    ]
    const out = applyOverrides(events, overrides)
    expect(out).toHaveLength(0)
  })

  // Suppress unused-var lint for `today` — kept for parity with other suites.
  void today
})
