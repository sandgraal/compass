/**
 * Anniversary moments (Timeline 2.0, PR 6). Real in-memory SQLite over the
 * owned tables the generator reads: contact birthdays, derived-entity firsts,
 * big-purchase anniversaries, today-only renewals — all defensive against
 * missing tables.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { momentsForDay } from './timeline-moments'

let sqlite: Database.Database

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, birthday TEXT);
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, first_seen INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL, description TEXT NOT NULL,
      normalized_merchant TEXT
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0,
      cadence TEXT NOT NULL DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      next_renewal TEXT
    );
  `)
})
afterEach(() => sqlite.close())

const OPTS = { month: 7, day: 8, currentYear: 2026, isToday: true }

describe('momentsForDay', () => {
  it('surfaces birthdays with a plausible age', () => {
    sqlite
      .prepare("INSERT INTO contacts (display_name, birthday) VALUES ('Sarah', '1990-07-08')")
      .run()
    sqlite
      .prepare("INSERT INTO contacts (display_name, birthday) VALUES ('Elsewhere', '1990-01-01')")
      .run()
    const moments = momentsForDay(sqlite, OPTS)
    expect(moments).toHaveLength(1)
    expect(moments[0]).toMatchObject({
      kind: 'birthday',
      title: "Sarah's birthday",
      detail: 'Turns 36 today'
    })
  })

  it('surfaces entity firsts (people and merchants) with year counts', () => {
    const first = Date.parse('2019-07-08T15:00:00Z')
    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, name, count, first_seen) VALUES ('person', 'Alex', 12, ?)"
      )
      .run(first)
    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, name, count, first_seen) VALUES ('merchant', 'Blue Bottle', 30, ?)"
      )
      .run(first)
    // Low-count extraction noise stays out.
    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, name, count, first_seen) VALUES ('person', 'Noise', 1, ?)"
      )
      .run(first)
    const titles = momentsForDay(sqlite, OPTS).map((m) => m.title)
    expect(titles).toContain('7 years since you first crossed paths with Alex')
    expect(titles).toContain('Your first Blue Bottle was 7 years ago today')
    expect(titles.join()).not.toContain('Noise')
  })

  it('surfaces big-purchase anniversaries but not small ones', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, description) VALUES ('2023-07-08', -8500, 'Kitchen renovation')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, description) VALUES ('2023-07-08', -42, 'Groceries')"
      )
      .run()
    const moments = momentsForDay(sqlite, OPTS)
    expect(moments).toHaveLength(1)
    expect(moments[0]).toMatchObject({
      kind: 'purchase-anniversary',
      title: '3 years since Kitchen renovation',
      detail: '$8,500'
    })
  })

  it('shows renewals only when the requested day IS today', () => {
    sqlite
      .prepare(
        "INSERT INTO subscriptions (name, cost, cadence, status, next_renewal) VALUES ('Netflix', 15.49, 'monthly', 'active', '2026-07-08')"
      )
      .run()
    expect(momentsForDay(sqlite, OPTS).map((m) => m.kind)).toContain('renewal')
    expect(momentsForDay(sqlite, { ...OPTS, isToday: false })).toHaveLength(0)
  })

  it('never throws when the tables are missing', () => {
    const bare = new Database(':memory:')
    expect(momentsForDay(bare, OPTS)).toEqual([])
    bare.close()
  })
})
