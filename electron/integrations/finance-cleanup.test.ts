/**
 * Real-DB tests for the merge/dedup cleanup tools. In-memory SQLite with
 * foreign_keys ON (so the merge's delete-after-reassign ordering is exercised).
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countDuplicateTransactions, dedupeTransactions, mergeAccounts } from './finance-cleanup'

let sqlite: Database.Database

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      institution TEXT,
      mask TEXT,
      simplefin_account_id TEXT,
      simplefin_connection_id INTEGER
    , is_foreign INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      account_id INTEGER REFERENCES finance_accounts(id),
      source_file TEXT
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      captured_at INTEGER NOT NULL, balance REAL NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE forecast_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      date TEXT NOT NULL, kind TEXT NOT NULL
    );
  `)
})
afterEach(() => sqlite.close())

type Opts = { institution?: string; mask?: string; sa?: string; sc?: number }
const acct = (name: string, o: Opts = {}): number =>
  Number(
    sqlite
      .prepare(
        'INSERT INTO finance_accounts (name, institution, mask, simplefin_account_id, simplefin_connection_id) VALUES (?,?,?,?,?)'
      )
      .run(name, o.institution ?? null, o.mask ?? null, o.sa ?? null, o.sc ?? null).lastInsertRowid
  )
const txn = (
  hash: string,
  date: string,
  amount: number,
  desc: string,
  accountId: number | null = null,
  source: string | null = null
): void => {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash,date,amount,description,account_id,source_file) VALUES (?,?,?,?,?,?)'
    )
    .run(hash, date, amount, desc, accountId, source)
}
const count = (sql: string, ...p: unknown[]): number =>
  (sqlite.prepare(sql).get(...p) as { n: number }).n

describe('mergeAccounts', () => {
  it('reassigns transactions, moves the provider linkage, deletes the source', () => {
    const keep = acct('My Amex', { institution: 'American Express' }) // no linkage
    const dup = acct('Platinum Card', {
      institution: 'American Express',
      sa: 'ACT-1',
      sc: 1,
      mask: '2001'
    })
    txn('h1', '2026-01-01', -10, 'a', dup)
    txn('h2', '2026-01-02', -20, 'b', dup)
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id,captured_at,balance,source) VALUES (?,1,1,?)'
      )
      .run(dup, 'plaid')

    const res = mergeAccounts(sqlite, dup, keep)
    expect(res.reassigned).toBe(2)
    expect(count('SELECT count(*) n FROM finance_accounts')).toBe(1) // source gone
    expect(count('SELECT count(*) n FROM finance_transactions WHERE account_id = ?', keep)).toBe(2)
    expect(count('SELECT count(*) n FROM finance_balance_snapshots')).toBe(0) // source snapshot gone

    const k = sqlite
      .prepare(
        'SELECT simplefin_account_id sa, simplefin_connection_id sc, mask FROM finance_accounts WHERE id = ?'
      )
      .get(keep) as { sa: string; sc: number; mask: string }
    expect(k.sa).toBe('ACT-1') // linkage moved to keeper so sync survives
    expect(k.sc).toBe(1)
    expect(k.mask).toBe('2001')
  })

  it('rejects merging an account into itself', () => {
    const a = acct('A')
    expect(() => mergeAccounts(sqlite, a, a)).toThrow(/differ/)
  })

  it('rejects when an account is missing', () => {
    const a = acct('A')
    expect(() => mergeAccounts(sqlite, a, 999)).toThrow(/not found/)
  })
})

describe('dedupeTransactions', () => {
  it('removes same date+amount+normalized-desc, keeps SimpleFIN, preserves transfer legs', () => {
    // cross-source dup (same normalized desc): CSV + SimpleFIN
    txn('h1', '2026-03-17', -5500, 'AMEX EPAYMENT ACH PMT ***2', null, 'chase.csv')
    txn('h2', '2026-03-17', -5500, 'AMEX EPAYMENT    ACH PMT', null, 'simplefin:Amex:tx')
    // transfer leg: same date+amount, DIFFERENT desc → not a dup
    txn('h3', '2026-03-17', -5500, 'American Express Credit Card', null, 'usaa.csv')
    // internal CSV re-import: identical after normalization → dup
    txn('h4', '2026-02-01', -12, 'Coffee', null, 'a.csv')
    txn('h5', '2026-02-01', -12, 'coffee', null, 'b.csv')

    expect(countDuplicateTransactions(sqlite)).toBe(2)
    expect(dedupeTransactions(sqlite).removed).toBe(2)
    expect(count('SELECT count(*) n FROM finance_transactions')).toBe(3)
    // the SimpleFIN row was the keeper of the cross-source pair
    expect(
      count("SELECT count(*) n FROM finance_transactions WHERE source_file LIKE 'simplefin:%'")
    ).toBe(1)
    // the transfer leg survived
    expect(
      count(
        "SELECT count(*) n FROM finance_transactions WHERE description = 'American Express Credit Card'"
      )
    ).toBe(1)
  })

  it('is a no-op when there are no duplicates', () => {
    txn('h1', '2026-01-01', -1, 'a')
    txn('h2', '2026-01-02', -2, 'b')
    expect(countDuplicateTransactions(sqlite)).toBe(0)
    expect(dedupeTransactions(sqlite).removed).toBe(0)
  })
})
