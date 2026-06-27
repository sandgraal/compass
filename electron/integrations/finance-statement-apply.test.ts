/**
 * Unit tests for `applyStatementMetadata` — the auto-update wiring that
 * pushes extracted statement metadata onto an existing financeAccounts row.
 *
 * Uses an in-memory SQLite to avoid touching the user's compass.db.
 */

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { applyStatementMetadata } from './finance'

function makeDb(): ReturnType<typeof drizzle<typeof schema>> {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      plaid_item_id INTEGER,
      plaid_account_id TEXT,
      mask TEXT,
      simplefin_connection_id INTEGER,
      simplefin_account_id TEXT,
      updated_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

function insertAccount(
  db: ReturnType<typeof drizzle<typeof schema>>,
  values: Partial<typeof schema.financeAccounts.$inferInsert> = {}
): number {
  const inserted = db
    .insert(schema.financeAccounts)
    .values({
      name: 'Test Card',
      type: 'credit',
      institution: 'Test Bank',
      isDebt: true,
      balance: 0,
      apr: 0,
      minPayment: 0,
      creditLimit: null,
      ...values
    } as typeof schema.financeAccounts.$inferInsert)
    .returning({ id: schema.financeAccounts.id })
    .get()
  return inserted!.id
}

function getAccount(
  db: ReturnType<typeof drizzle<typeof schema>>,
  id: number
): typeof schema.financeAccounts.$inferSelect | undefined {
  return db.select().from(schema.financeAccounts).where(eq(schema.financeAccounts.id, id)).get()
}

describe('applyStatementMetadata', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(() => {
    db = makeDb()
  })

  it('writes balance / apr / minPayment / creditLimit when existing values are 0/null', () => {
    const id = insertAccount(db)
    applyStatementMetadata(db, id, {
      balance: 1284.55,
      apr: 0.1899,
      minimumPayment: 42,
      creditLimit: 5000,
      paymentDueDate: '2026-06-10'
    })
    const row = getAccount(db, id)
    expect(row?.balance).toBe(1284.55)
    expect(row?.apr).toBeCloseTo(0.1899, 4)
    expect(row?.minPayment).toBe(42)
    expect(row?.creditLimit).toBe(5000)
    expect(row?.paymentDueDate).toBe('2026-06-10')
  })

  it('preserves manual edits (non-zero balance is not overwritten)', () => {
    const id = insertAccount(db, { balance: 999, apr: 0.25, minPayment: 50, creditLimit: 7500 })
    applyStatementMetadata(db, id, {
      balance: 1284.55,
      apr: 0.1899,
      minimumPayment: 42,
      creditLimit: 5000
    })
    const row = getAccount(db, id)
    // All four manual-edit fields preserved.
    expect(row?.balance).toBe(999)
    expect(row?.apr).toBeCloseTo(0.25, 4)
    expect(row?.minPayment).toBe(50)
    expect(row?.creditLimit).toBe(7500)
  })

  it('always refreshes paymentDueDate (it advances each cycle)', () => {
    const id = insertAccount(db, { paymentDueDate: '2026-05-10' })
    applyStatementMetadata(db, id, { paymentDueDate: '2026-06-10' })
    const row = getAccount(db, id)
    expect(row?.paymentDueDate).toBe('2026-06-10')
  })

  it('always refreshes lastStatementSyncedAt', () => {
    const id = insertAccount(db)
    applyStatementMetadata(db, id, { balance: 100 })
    const row = getAccount(db, id)
    expect(row?.lastStatementSyncedAt).toBeInstanceOf(Date)
  })

  it('is idempotent: running twice with the same metadata produces the same row state', () => {
    const id = insertAccount(db)
    applyStatementMetadata(db, id, {
      balance: 500,
      apr: 0.2,
      minimumPayment: 25,
      creditLimit: 3000,
      paymentDueDate: '2026-06-01'
    })
    const first = getAccount(db, id)
    applyStatementMetadata(db, id, {
      balance: 500,
      apr: 0.2,
      minimumPayment: 25,
      creditLimit: 3000,
      paymentDueDate: '2026-06-01'
    })
    const second = getAccount(db, id)
    expect(second?.balance).toBe(first?.balance)
    expect(second?.apr).toBe(first?.apr)
    expect(second?.minPayment).toBe(first?.minPayment)
    expect(second?.creditLimit).toBe(first?.creditLimit)
    expect(second?.paymentDueDate).toBe(first?.paymentDueDate)
  })

  it('skips fields that the metadata omits', () => {
    const id = insertAccount(db)
    applyStatementMetadata(db, id, { balance: 200 })
    const row = getAccount(db, id)
    expect(row?.balance).toBe(200)
    // APR, minPayment, creditLimit, paymentDueDate untouched (still default).
    expect(row?.apr).toBe(0)
    expect(row?.minPayment).toBe(0)
    expect(row?.creditLimit).toBeNull()
    expect(row?.paymentDueDate).toBeNull()
  })

  it('no-ops cleanly when the account row does not exist', () => {
    expect(() => applyStatementMetadata(db, 999, { balance: 100 })).not.toThrow()
  })
})
