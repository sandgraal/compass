/**
 * Tests for `reconcileTransactionCurrency` — the ingest-time pass that relabels
 * each account-linked transaction with its account's native currency.
 *
 * In-memory SQLite (minimal tables + raw inserts so we don't have to mirror the
 * full schema defaults drizzle would inline). The reconcile under test uses the
 * drizzle query builder, so it runs against the real `schema`.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { reconcileTransactionCurrency } from './finance-currency'

type Db = ReturnType<typeof drizzle<typeof schema>>

let sqlite: Database.Database
let db: Db

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT NOT NULL,
      account_id INTEGER
    );
  `)
  db = drizzle(sqlite, { schema })
})

function addAccount(name: string, currency: string): number {
  return Number(
    sqlite
      .prepare('INSERT INTO finance_accounts (name, currency) VALUES (?, ?)')
      .run(name, currency).lastInsertRowid
  )
}

function addTxn(hash: string, accountId: number | null, currency = 'USD'): void {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, currency, description, account_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(hash, '2026-01-01', -10, currency, hash, accountId)
}

function currencyOf(hash: string): string {
  return (
    sqlite.prepare('SELECT currency FROM finance_transactions WHERE hash = ?').get(hash) as {
      currency: string
    }
  ).currency
}

describe('reconcileTransactionCurrency', () => {
  it("relabels an account's default-USD transactions to its native currency", () => {
    const crc = addAccount('Colón Checking', 'CRC')
    addTxn('a', crc) // inserted at the default 'USD'
    addTxn('b', crc)

    const changed = reconcileTransactionCurrency(db)

    expect(changed).toBe(2)
    expect(currencyOf('a')).toBe('CRC')
    expect(currencyOf('b')).toBe('CRC')
  })

  it('leaves unlinked rows (account_id NULL) untouched — nothing to inherit from', () => {
    addTxn('orphan', null, 'USD')
    const changed = reconcileTransactionCurrency(db)
    expect(changed).toBe(0)
    expect(currencyOf('orphan')).toBe('USD')
  })

  it('gives each account-linked row its OWN account currency', () => {
    const crc = addAccount('CR Checking', 'CRC')
    const eur = addAccount('EU Savings', 'EUR')
    const usd = addAccount('US Card', 'USD')
    addTxn('cr', crc)
    addTxn('eu', eur)
    addTxn('us', usd) // already matches → not counted

    const changed = reconcileTransactionCurrency(db)

    expect(changed).toBe(2) // only the CRC + EUR rows actually moved
    expect(currencyOf('cr')).toBe('CRC')
    expect(currencyOf('eu')).toBe('EUR')
    expect(currencyOf('us')).toBe('USD')
  })

  it('is idempotent — a second pass changes nothing', () => {
    const crc = addAccount('Colón', 'CRC')
    addTxn('a', crc)
    expect(reconcileTransactionCurrency(db)).toBe(1)
    expect(reconcileTransactionCurrency(db)).toBe(0)
    expect(currencyOf('a')).toBe('CRC')
  })

  it('does not disturb a row that already matches its account', () => {
    const eur = addAccount('EU', 'EUR')
    addTxn('already', eur, 'EUR')
    expect(reconcileTransactionCurrency(db)).toBe(0)
    expect(currencyOf('already')).toBe('EUR')
  })
})
