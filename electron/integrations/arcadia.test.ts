import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { normalizeArcadiaStatements, upsertUtilityBills } from './arcadia'

const STATEMENTS = {
  results: [
    {
      id: 'stmt-1',
      utilityProvider: { name: 'PG&E' },
      serviceAddress: {
        line1: '123 Rental Way',
        city: 'San José',
        state: 'SJ',
        postalCode: '10101'
      },
      statementDate: '2026-06-20T00:00:00Z', // ISO → sliced to the day
      servicePeriod: { startDate: '2026-05-20', endDate: '2026-06-19' },
      totalAmountDue: '142.50',
      currency: 'USD',
      totalUsage: { value: 520, unit: 'kWh' }
    },
    {
      id: 'stmt-2',
      provider: 'City Water', // flat provider + address string variants
      address: '123 Rental Way, San José',
      statement_date: '2026-06-25',
      amount: 60,
      currency: 'USD'
    }
  ]
}

describe('normalizeArcadiaStatements', () => {
  it('parses provider/address/amount/usage across Arcadia shape variants', () => {
    const out = normalizeArcadiaStatements(STATEMENTS)
    expect(out).toHaveLength(2)
    expect(out.find((b) => b.externalId === 'arcadia:stmt-1')).toMatchObject({
      provider: 'PG&E',
      serviceAddress: '123 Rental Way, San José, SJ, 10101',
      statementDate: '2026-06-20',
      periodStart: '2026-05-20',
      periodEnd: '2026-06-19',
      amount: 142.5,
      currency: 'USD',
      usageKwh: 520
    })
    expect(out.find((b) => b.externalId === 'arcadia:stmt-2')).toMatchObject({
      provider: 'City Water',
      serviceAddress: '123 Rental Way, San José',
      amount: 60,
      usageKwh: null
    })
  })

  it('skips malformed input safely', () => {
    expect(normalizeArcadiaStatements({})).toEqual([])
    expect(normalizeArcadiaStatements({ results: 'nope' })).toEqual([])
    expect(normalizeArcadiaStatements({ results: [{ provider: 'X' }] })).toEqual([]) // no id
  })
})

describe('upsertUtilityBills (real DB)', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: InstanceType<typeof Database>

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE utility_bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
        provider TEXT, service_address TEXT, statement_date TEXT, period_start TEXT,
        period_end TEXT, amount REAL, currency TEXT NOT NULL DEFAULT 'USD',
        usage_kwh REAL, ingested_at INTEGER
      );
    `)
    db = drizzle<typeof schema>(sqlite, { schema })
  })

  it('upserts bills, then refreshes in place on re-sync (idempotent)', () => {
    const rows = normalizeArcadiaStatements(STATEMENTS)
    expect(upsertUtilityBills(db, rows)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM utility_bills').get()).toEqual({ n: 2 })

    const changed = rows.map((r) => (r.externalId === 'arcadia:stmt-1' ? { ...r, amount: 200 } : r))
    expect(upsertUtilityBills(db, changed)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM utility_bills').get()).toEqual({ n: 2 })
    expect(
      sqlite.prepare("SELECT amount FROM utility_bills WHERE external_id = 'arcadia:stmt-1'").get()
    ).toEqual({ amount: 200 })
  })
})
