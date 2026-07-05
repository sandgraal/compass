import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  type RecurringIncomeStream,
  detectRecurringIncome,
  projectIncomeEvents
} from './finance-forecast'
import {
  type PaystubRow,
  buildIncomeSummary,
  mergeIncomeStreams,
  paystubsToIncomeStreams,
  readArgylePaystubs
} from './finance-income'

function stub(p: Partial<PaystubRow> & { paidAt: string; netPay: number }): PaystubRow {
  return {
    employer: 'Globex',
    grossPay: 3000,
    withholding: 800,
    deductions: 100,
    currency: 'USD',
    periodStart: null,
    periodEnd: null,
    payCycle: null,
    ...p
  }
}

describe('paystubsToIncomeStreams', () => {
  it('derives one stream per employer, routed to the default cash account (net pay, real cadence)', () => {
    const streams = paystubsToIncomeStreams(
      [
        stub({ paidAt: '2026-06-05', netPay: 2100, payCycle: 'biweekly' }),
        stub({ paidAt: '2026-06-19', netPay: 2100 }),
        stub({ paidAt: '2026-07-03', netPay: 2100 })
      ],
      { defaultCashAccountId: 7 }
    )
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({
      accountId: 7,
      cadence: 'biweekly',
      medianAmount: 2100,
      lastSeen: '2026-07-03',
      nDeposits: 3
    })
    expect(streams[0].label).toContain('Globex')
  })

  it('infers cadence from paid-date gaps when no pay_cycle is given', () => {
    const streams = paystubsToIncomeStreams(
      [
        stub({ paidAt: '2026-06-01', netPay: 1000 }),
        stub({ paidAt: '2026-07-01', netPay: 1000 }) // ~30d apart → monthly
      ],
      { defaultCashAccountId: 1 }
    )
    expect(streams[0].cadence).toBe('monthly')
  })

  it('returns [] when there is no cash account to route to (forecast then keeps inferred)', () => {
    expect(
      paystubsToIncomeStreams([stub({ paidAt: '2026-06-01', netPay: 1000, payCycle: 'weekly' })], {
        defaultCashAccountId: null
      })
    ).toEqual([])
  })

  it('ignores paystubs with no net pay or no paid date', () => {
    const streams = paystubsToIncomeStreams(
      [
        stub({ paidAt: '2026-06-01', netPay: 0 }),
        { ...stub({ paidAt: '', netPay: 500 }), paidAt: null }
      ],
      { defaultCashAccountId: 1 }
    )
    expect(streams).toEqual([])
  })
})

describe('mergeIncomeStreams (paystubs win, dedupe the matching bank deposit)', () => {
  const paystub: RecurringIncomeStream = {
    accountId: 1,
    label: 'Globex · paystub',
    cadence: 'biweekly',
    medianAmount: 2100,
    lastSeen: '2026-07-03',
    nDeposits: 3
  }
  const matchingDeposit: RecurringIncomeStream = {
    accountId: 1,
    label: 'globex payroll',
    cadence: 'biweekly',
    medianAmount: 2095, // within 5% of 2100 → same paycheck, suppressed
    lastSeen: '2026-07-01',
    nDeposits: 6
  }
  const otherIncome: RecurringIncomeStream = {
    accountId: 1,
    label: 'consulting',
    cadence: 'monthly',
    medianAmount: 5000, // unrelated → kept
    lastSeen: '2026-07-01',
    nDeposits: 4
  }

  it('drops an inferred stream that matches a paystub net, keeps unrelated income', () => {
    const merged = mergeIncomeStreams([paystub], [matchingDeposit, otherIncome])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(paystub) // paystub first (authoritative)
    expect(merged.find((s) => s.label === 'globex payroll')).toBeUndefined()
    expect(merged.find((s) => s.label === 'consulting')).toBe(otherIncome)
  })

  it('is a no-op passthrough when there are no paystub streams', () => {
    const merged = mergeIncomeStreams([], [matchingDeposit, otherIncome])
    expect(merged).toEqual([matchingDeposit, otherIncome])
  })
})

describe('buildIncomeSummary (aggregates-only, real DB)', () => {
  function seed(): Database.Database {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE argyle_paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
        employer TEXT, gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
        currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT,
        paid_at TEXT, pay_cycle TEXT, ingested_at INTEGER
      );
      INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, withholding, currency, paid_at, pay_cycle)
      VALUES
        ('argyle:a', 'Globex', 3000, 2100.5, 800, 'USD', '2026-06-19', 'biweekly'),
        ('argyle:b', 'Globex', 3000, 2100.5, 800, 'USD', '2026-07-03', 'biweekly');
    `)
    return sqlite
  }

  it('annualizes net/gross, computes the effective withholding rate and next payday', () => {
    const summary = buildIncomeSummary(seed(), { today: '2026-07-10' })
    expect(summary.hasPaystubs).toBe(true)
    expect(summary.sources).toHaveLength(1)
    const src = summary.sources[0]
    expect(src).toMatchObject({ employer: 'Globex', cadence: 'biweekly', paystubs: 2 })
    expect(src.annualizedNet).toBe(Math.round(2100.5 * 26)) // 54613
    expect(src.annualizedGross).toBe(3000 * 26) // 78000
    expect(src.effectiveWithholdingRate).toBeCloseTo(1600 / 6000, 4) // Σtax / Σgross
    expect(src.nextExpectedPayday).toBe('2026-07-17') // 2026-07-03 + 14d, past today
    expect(summary.totalAnnualizedNet).toBe(54613)
    expect(summary.blendedWithholdingRate).toBeCloseTo(0.2667, 3)
  })

  it('is empty (never throws) when there are no paystubs / no table', () => {
    const empty = new Database(':memory:')
    expect(readArgylePaystubs(empty)).toEqual([]) // table-less install → forecast unchanged
    const summary = buildIncomeSummary(empty)
    expect(summary).toMatchObject({ hasPaystubs: false, sources: [], totalAnnualizedNet: 0 })
  })
})

describe('forecast composition — real paystubs preferred over inferred deposits (no double count)', () => {
  // Exercises exactly how buildForecast composes the two income sources:
  //   mergeIncomeStreams(paystubsToIncomeStreams(readArgylePaystubs()), detectRecurringIncome())
  function seed(): Database.Database {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE finance_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_debt INTEGER DEFAULT 0
      );
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, date TEXT NOT NULL,
        amount REAL NOT NULL, description TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE argyle_paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
        gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
        currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT,
        paid_at TEXT, pay_cycle TEXT, ingested_at INTEGER
      );
      INSERT INTO finance_accounts (id, name, is_debt) VALUES (1, 'Chase', 0);
      -- The SAME paycheck seen from the bank side (net deposit, cadence guessed from gaps).
      INSERT INTO finance_transactions (account_id, date, amount, description) VALUES
        (1, '2026-06-05', 2100, 'Globex Payroll'),
        (1, '2026-06-19', 2100, 'Globex Payroll'),
        (1, '2026-07-03', 2100, 'Globex Payroll');
      -- …and from the payroll side (ground truth: net + gross + withholding + cadence).
      INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, withholding, currency, paid_at, pay_cycle) VALUES
        ('argyle:a', 'Globex', 3000, 2100, 800, 'USD', '2026-06-19', 'biweekly'),
        ('argyle:b', 'Globex', 3000, 2100, 800, 'USD', '2026-07-03', 'biweekly');
    `)
    return sqlite
  }

  it('keeps one income stream (the paystub), suppressing the matching bank-deposit inference', () => {
    const sqlite = seed()
    const today = new Date(2026, 6, 5) // 2026-07-05

    const inferred = detectRecurringIncome(sqlite, { today })
    expect(inferred).toHaveLength(1) // the bank deposit stream is detected on its own
    const paystubStreams = paystubsToIncomeStreams(readArgylePaystubs(sqlite), {
      defaultCashAccountId: 1
    })
    const merged = mergeIncomeStreams(paystubStreams, inferred)

    // Exactly one stream survives — the paystub — so the paycheck is not counted twice.
    expect(merged).toHaveLength(1)
    expect(merged[0].label).toContain('Globex')
    expect(merged[0].label).toContain('paystub')

    // …and it projects forward as income events at the (real) biweekly cadence.
    const events = projectIncomeEvents(merged, today, 30)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.source === 'income' && e.amount === 2100)).toBe(true)
  })
})
