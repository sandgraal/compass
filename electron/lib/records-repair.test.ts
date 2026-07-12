/**
 * One-shot absurd-year date repair (recordsDateRepairV1) + the 0033 timeline
 * indexes. Real in-memory SQLite: the repair nulls corrupt occurred_at values
 * exactly once (gate written after success), and the migration's expression
 * indexes are actually USED by the query shapes the timeline runs — an
 * expression index that doesn't textually match its query silently degrades
 * to a full-table scan, so EXPLAIN QUERY PLAN is asserted here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GCAL_DEDUPE_KEY,
  RECORDS_DATE_REPAIR_KEY,
  runGcalDedupeIfNeeded,
  runRecordsDateRepairIfNeeded
} from './records-repair'

// Mirrors electron/db/client.ts ensureNewTables (records + app_settings).
const RECORDS_DDL = `CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
  title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
);`
const APP_SETTINGS_DDL = `CREATE TABLE app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER
);`

const INDEXES_SQL = readFileSync(
  join(__dirname, '../db/migrations/0033_timeline_date_indexes.sql'),
  'utf8'
)

const NOW = Date.parse('2026-07-08T12:00:00Z')

let sqlite: Database.Database

function insert(title: string, occurredAt: number | null): void {
  sqlite
    .prepare(
      "INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES ('generic', 'event', ?, ?, ?)"
    )
    .run(occurredAt, title, title)
}

function occurredAtOf(title: string): number | null {
  const row = sqlite
    .prepare('SELECT occurred_at AS ms FROM records WHERE title = ?')
    .get(title) as {
    ms: number | null
  }
  return row.ms
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(RECORDS_DDL)
  sqlite.exec(APP_SETTINGS_DDL)
})
afterEach(() => sqlite.close())

describe('runRecordsDateRepairIfNeeded', () => {
  it('nulls absurd-year timestamps and keeps plausible + undated rows', () => {
    insert('year 104', Date.UTC(104, 0, 1)) // negative epoch ms
    insert('year 10801', Date.UTC(10801, 4, 12))
    insert('just past the window', NOW + 6 * 365 * 24 * 3600 * 1000)
    insert('real event', Date.parse('2024-05-12T00:00:00Z'))
    insert('near future renewal', Date.parse('2027-01-01T00:00:00Z'))
    insert('undated', null)

    const res = runRecordsDateRepairIfNeeded(sqlite, NOW)
    expect(res).toEqual({ ran: true, repaired: 3 })

    expect(occurredAtOf('year 104')).toBeNull()
    expect(occurredAtOf('year 10801')).toBeNull()
    expect(occurredAtOf('just past the window')).toBeNull()
    expect(occurredAtOf('real event')).toBe(Date.parse('2024-05-12T00:00:00Z'))
    expect(occurredAtOf('near future renewal')).toBe(Date.parse('2027-01-01T00:00:00Z'))
    expect(occurredAtOf('undated')).toBeNull()
  })

  it('runs exactly once — the gate blocks the second call', () => {
    insert('year 10801', Date.UTC(10801, 4, 12))
    expect(runRecordsDateRepairIfNeeded(sqlite, NOW).ran).toBe(true)

    insert('another bad row after the gate', Date.UTC(10801, 4, 13))
    const second = runRecordsDateRepairIfNeeded(sqlite, NOW)
    expect(second).toEqual({ ran: false, repaired: 0 })
    // The gate means later corruption is the guardrail's job, not the repair's.
    expect(occurredAtOf('another bad row after the gate')).not.toBeNull()

    const gate = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(RECORDS_DATE_REPAIR_KEY) as { value: string } | undefined
    expect(gate?.value).toBe(new Date(NOW).toISOString())
  })

  it('writes the gate even when nothing needed repair', () => {
    insert('real event', Date.parse('2024-05-12T00:00:00Z'))
    expect(runRecordsDateRepairIfNeeded(sqlite, NOW)).toEqual({ ran: true, repaired: 0 })
    expect(runRecordsDateRepairIfNeeded(sqlite, NOW).ran).toBe(false)
  })
})

describe('runGcalDedupeIfNeeded', () => {
  function insertGcal(
    title: string,
    occurredAt: number | null,
    hash: string,
    provenance = 'Work.ics',
    body: string | null = null,
    payload: string | null = null
  ): void {
    sqlite
      .prepare(
        "INSERT INTO records (source, type, occurred_at, title, body, payload, dedup_hash, provenance) VALUES ('gcal', 'event', ?, ?, ?, ?, ?, ?)"
      )
      .run(occurredAt, title, body, payload, hash, provenance)
  }

  it('keeps the oldest of each duplicate group and leaves distinct events alone', () => {
    const when = Date.parse('2026-05-01T09:00:00Z')
    // Duplicate pair from UID-drift across re-imports (different hashes,
    // identical user-visible fields).
    insertGcal('Harvest Kale - Lacinato', when, 'h1')
    insertGcal('Harvest Kale - Lacinato', when, 'h2')
    // Same title+time but a DIFFERENT calendar file — not a duplicate.
    insertGcal('Harvest Kale - Lacinato', when, 'h3', 'Personal.ics')
    // Distinct events + a non-gcal row: untouched.
    insertGcal('Standup', when, 'h4')
    insert('generic row', when)

    const res = runGcalDedupeIfNeeded(sqlite, NOW)
    expect(res).toEqual({ ran: true, removed: 1 })
    const kept = sqlite
      .prepare("SELECT dedup_hash AS h FROM records WHERE source='gcal' ORDER BY id")
      .all() as Array<{ h: string }>
    expect(kept.map((k) => k.h)).toEqual(['h1', 'h3', 'h4']) // oldest of the pair survives
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM records WHERE source='generic'").get()
    ).toEqual({ n: 1 })
  })

  it('never collapses real events that share title+time+file but differ in visible fields', () => {
    const when = Date.parse('2026-06-01T15:00:00Z')
    // Same SUMMARY + DTSTART in the same .ics, different LOCATION (body):
    // two real overlapping bookings, not an export drift.
    insertGcal('Team sync', when, 'a1', 'Work.ics', 'Room 4')
    insertGcal('Team sync', when, 'a2', 'Work.ics', 'Room 9')
    // Live-synced rows (payload present): same title+time, different payloads.
    insertGcal('1:1', when, 'b1', 'live:gcal', null, '{"eventId":"x"}')
    insertGcal('1:1', when, 'b2', 'live:gcal', null, '{"eventId":"y"}')
    // …and a true UID-drift pair, identical in every visible field.
    insertGcal('Standup', when, 'c1', 'Work.ics', 'Zoom', '{"uid":"old"}')
    insertGcal('Standup', when, 'c2', 'Work.ics', 'Zoom', '{"uid":"old"}')

    const res = runGcalDedupeIfNeeded(sqlite, NOW)
    expect(res).toEqual({ ran: true, removed: 1 })
    const kept = sqlite
      .prepare("SELECT dedup_hash AS h FROM records WHERE source='gcal' ORDER BY id")
      .all() as Array<{ h: string }>
    expect(kept.map((k) => k.h)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1'])
  })

  it('runs once and then gates', () => {
    const when = Date.parse('2026-05-01T09:00:00Z')
    insertGcal('A', when, 'a1')
    expect(runGcalDedupeIfNeeded(sqlite, NOW)).toEqual({ ran: true, removed: 0 })
    // A duplicate arriving after the gate is consumed stays (one-shot repair).
    insertGcal('A', when, 'a2')
    expect(runGcalDedupeIfNeeded(sqlite, NOW)).toEqual({ ran: false, removed: 0 })
    const gate = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(GCAL_DEDUPE_KEY) as { value: string } | undefined
    expect(gate?.value).toBe(new Date(NOW).toISOString())
  })
})

describe('0033 timeline indexes', () => {
  function plan(query: string): string {
    const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>
    return rows.map((r) => r.detail).join(' | ')
  }

  beforeEach(() => {
    sqlite.exec(INDEXES_SQL) // the real migration file — `--> statement-breakpoint` is a SQL comment
    insert('seed', Date.parse('2024-05-12T00:00:00Z'))
  })

  it('serves month-day ("on this day") lookups from idx_records_mmdd', () => {
    expect(
      plan(
        `SELECT * FROM records WHERE strftime('%m-%d', "records"."occurred_at" / 1000, 'unixepoch') = '07-08'`
      )
    ).toContain('idx_records_mmdd')
  })

  it('serves per-year lookups from idx_records_year', () => {
    expect(
      plan(
        `SELECT count(*) FROM records WHERE CAST(strftime('%Y', "records"."occurred_at" / 1000, 'unixepoch') AS INTEGER) = 2024`
      )
    ).toContain('idx_records_year')
  })

  it('serves source-filtered newest-first browse from idx_records_source_occurred', () => {
    expect(
      plan(`SELECT * FROM records WHERE source = 'netflix' ORDER BY occurred_at DESC LIMIT 50`)
    ).toContain('idx_records_source_occurred')
  })
})
