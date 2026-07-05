import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { type ArgylePaystubRow, normalizeArgylePaystubs, upsertPaystubs } from './argyle'

const PAYSTUBS = {
  results: [
    {
      id: 'ps1',
      employer: 'Globex',
      gross_pay: '3,000.00', // string with a thousands separator
      net_pay: '2100.50',
      currency: 'USD',
      taxes: [
        { name: 'Federal', amount: '600.00' },
        { name: 'State', amount: '200.00' }
      ],
      deductions: [{ name: '401k', amount: '100.00' }],
      paystub_period: { start_date: '2026-06-01', end_date: '2026-06-14' },
      paid_at: '2026-06-19T00:00:00Z', // ISO datetime → sliced to the day
      pay_cycle: 'biweekly'
    },
    {
      id: 'ps2',
      employer: 'Globex',
      gross_pay: 3000, // numeric
      net_pay: 2100.5,
      currency: 'USD',
      taxes: [{ amount: 800 }],
      paystub_period: { start_date: '2026-06-15', end_date: '2026-06-28' },
      paid_at: '2026-07-03'
    }
  ]
}

describe('normalizeArgylePaystubs', () => {
  it('parses string + numeric money, sums taxes into withholding, slices dates', () => {
    const out = normalizeArgylePaystubs(PAYSTUBS)
    expect(out).toHaveLength(2)
    const ps1 = out.find((r) => r.externalId === 'argyle:ps1')
    expect(ps1).toMatchObject({
      employer: 'Globex',
      grossPay: 3000, // '3,000.00' → 3000
      netPay: 2100.5,
      withholding: 800, // 600 + 200
      deductions: 100,
      currency: 'USD',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-14',
      paidAt: '2026-06-19', // sliced from the ISO datetime
      payCycle: 'biweekly'
    })
    const ps2 = out.find((r) => r.externalId === 'argyle:ps2')
    expect(ps2).toMatchObject({
      grossPay: 3000,
      netPay: 2100.5,
      withholding: 800,
      paidAt: '2026-07-03'
    })
  })

  it('skips malformed input safely', () => {
    expect(normalizeArgylePaystubs({})).toEqual([])
    expect(normalizeArgylePaystubs({ results: 'nope' })).toEqual([])
    expect(normalizeArgylePaystubs({ results: [{ employer: 'X' }] })).toEqual([]) // no id
  })

  it('defaults currency to USD and tolerates missing taxes/deductions', () => {
    const out = normalizeArgylePaystubs({ results: [{ id: 'x', net_pay: '500' }] })
    expect(out[0]).toMatchObject({
      currency: 'USD',
      withholding: null,
      deductions: null,
      grossPay: null
    })
  })
})

describe('upsertPaystubs (real DB)', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: InstanceType<typeof Database>

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE argyle_paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL UNIQUE,
        employer TEXT, gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        period_start TEXT, period_end TEXT, paid_at TEXT, pay_cycle TEXT, ingested_at INTEGER
      );
    `)
    db = drizzle<typeof schema>(sqlite, { schema })
  })

  it('upserts paystubs, then refreshes in place on re-sync (idempotent)', () => {
    const rows = normalizeArgylePaystubs(PAYSTUBS)
    expect(upsertPaystubs(db, rows)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM argyle_paystubs').get()).toEqual({ n: 2 })

    // Re-sync with a changed net pay for ps1 → same row count, value updated in place.
    const changed: ArgylePaystubRow[] = rows.map((r) =>
      r.externalId === 'argyle:ps1' ? { ...r, netPay: 2222.22 } : r
    )
    expect(upsertPaystubs(db, changed)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM argyle_paystubs').get()).toEqual({ n: 2 })
    const ps1 = sqlite
      .prepare("SELECT net_pay AS netPay FROM argyle_paystubs WHERE external_id = 'argyle:ps1'")
      .get()
    expect(ps1).toEqual({ netPay: 2222.22 })
  })
})
