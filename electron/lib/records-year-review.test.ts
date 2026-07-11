/**
 * Year in Review aggregator (Timeline 2.0, PR 7). Real in-memory SQLite over
 * every table the review reads — records, entities, travel, finance,
 * snapshots, habits — plus the narrative/markdown renderers and
 * missing-table resilience.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildYearReview,
  yearReviewMarkdown,
  yearReviewNarrationPrompt,
  yearReviewNarrative
} from './records-year-review'

let sqlite: Database.Database
let seq = 0

function rec(source: string, type: string, title: string, iso: string): void {
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?, ?, ?, ?, ?)'
    )
    .run(source, type, Date.parse(iso), title, `seed|${seq++}`)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, first_seen INTEGER
    );
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY, country TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL, description TEXT NOT NULL
    );
    CREATE TABLE finance_accounts (id INTEGER PRIMARY KEY, is_debt INTEGER DEFAULT 0);
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, captured_at INTEGER NOT NULL, balance REAL NOT NULL
    );
    CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY, habit_id INTEGER, date TEXT NOT NULL, completed INTEGER DEFAULT 0
    );
  `)
  seq = 0
})
afterEach(() => sqlite.close())

describe('buildYearReview', () => {
  it('assembles the full review from every table', () => {
    // Records: 3 watches of the same show (top title), 1 order, 1 firehose row.
    rec('netflix', 'watch', 'Severance S1E1', '2024-01-10T20:00:00Z')
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-11T20:00:00Z')
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-12T20:00:00Z')
    rec('amazon', 'order', 'Espresso Grinder', '2024-06-01T12:00:00Z')
    rec('generic', 'event', 'telemetry', '2024-06-01T12:00:00Z') // firehose — excluded
    rec('netflix', 'watch', 'Elsewhere', '2023-06-01T12:00:00Z') // other year

    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, name, count, first_seen) VALUES ('person', 'Alex', 9, ?)"
      )
      .run(Date.parse('2024-03-05T10:00:00Z'))
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date) VALUES ('CR', '2023-12-20', '2024-01-10')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date) VALUES ('ES', '2024-05-01', '2024-05-20')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, description) VALUES ('2024-04-01', -3200, 'Flight to Madrid')"
      )
      .run()
    sqlite.prepare('INSERT INTO finance_accounts (id, is_debt) VALUES (1, 0)').run()
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (1, ?, 10000)'
      )
      .run(Date.parse('2023-12-30T00:00:00Z'))
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (1, ?, 14000)'
      )
      .run(Date.parse('2024-12-30T00:00:00Z'))
    sqlite.prepare("INSERT INTO habits (id, name) VALUES (1, 'Workout')").run()
    for (const d of ['2024-01-02', '2024-01-03', '2024-01-04']) {
      sqlite
        .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, ?, 1)')
        .run(d)
    }

    const r = buildYearReview(sqlite, 2024)
    expect(r.totalRecords).toBe(4) // firehose + other-year excluded
    expect(r.monthCounts[0]).toBe(1) // Jan
    expect(r.monthCounts[1]).toBe(2) // Feb
    expect(r.topSources[0]).toEqual({ source: 'netflix', count: 3 })
    expect(r.topTitles[0]).toMatchObject({ title: 'Severance S1E1', count: 3 })
    expect(r.firsts).toEqual([{ kind: 'person', name: 'Alex' }])
    expect(r.newPeople).toBe(1)
    expect(r.countries).toEqual(['CR', 'ES']) // overlap counts the straddling trip
    expect(r.spend).toMatchObject({ total: 3200 })
    expect(r.netWorth).toEqual({ start: 10000, end: 14000 })
    expect(r.habits).toEqual([{ name: 'Workout', completions: 3 }])
  })

  it('never throws when tables are missing', () => {
    const bare = new Database(':memory:')
    const r = buildYearReview(bare, 2024)
    expect(r.totalRecords).toBe(0)
    expect(yearReviewNarrative(r)).toContain('No dated records')
    bare.close()
  })
})

describe('narrative + markdown', () => {
  it('renders a factual narrative and a complete markdown export', () => {
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-11T20:00:00Z')
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-12T20:00:00Z')
    const r = buildYearReview(sqlite, 2024)
    const narrative = yearReviewNarrative(r)
    expect(narrative).toContain('2024')
    expect(narrative).toContain('February')
    expect(narrative).toContain('Severance S1E1')
    const md = yearReviewMarkdown(r)
    expect(md).toContain('# 2024 in Review')
    expect(md).toContain('## On repeat')
    expect(md).toContain('- Severance S1E1 — 2× (netflix)')
  })

  it('honors a narrative override in the markdown export (LLM prose)', () => {
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-11T20:00:00Z')
    const r = buildYearReview(sqlite, 2024)
    const md = yearReviewMarkdown(r, 'A year of quiet Tuesdays and one great show.')
    expect(md).toContain('A year of quiet Tuesdays and one great show.')
    expect(md).not.toContain(yearReviewNarrative(r)) // template replaced, not appended
    // Empty/whitespace override falls back to the template.
    expect(yearReviewMarkdown(r, '   ')).toContain(yearReviewNarrative(r))
  })
})

describe('yearReviewNarrationPrompt', () => {
  it('builds a fact-only prompt and forbids invention', () => {
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-11T20:00:00Z')
    rec('netflix', 'watch', 'Severance S1E1', '2024-02-12T20:00:00Z')
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date) VALUES ('ES', '2024-05-01', '2024-05-20')"
      )
      .run()
    const prompt = yearReviewNarrationPrompt(buildYearReview(sqlite, 2024))
    expect(prompt).not.toBeNull()
    expect(prompt?.system).toMatch(/only the facts|never invent/i)
    expect(prompt?.user).toContain('Year: 2024')
    expect(prompt?.user).toContain('Severance S1E1')
    expect(prompt?.user).toContain('ES')
  })

  it('returns null for an empty year (nothing to narrate)', () => {
    expect(yearReviewNarrationPrompt(buildYearReview(sqlite, 2024))).toBeNull()
  })
})
