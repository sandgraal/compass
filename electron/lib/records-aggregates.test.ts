/**
 * Timeline aggregates (Timeline 2.0, PR 3). Real in-memory SQLite with the
 * REAL 0033 index migration applied, over a seeded multi-year archive —
 * proves bucketing (UTC), day bounds, rollups, the all-years on-this-day
 * grouping/caps, and firehose exclusion.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  daySummary,
  onThisDayAllYears,
  recordsForDay,
  recordsHistogram,
  utcDayBounds
} from './records-aggregates'

const RECORDS_DDL = `CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
  title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
);`
const INDEXES_SQL = readFileSync(
  join(__dirname, '../db/migrations/0033_timeline_date_indexes.sql'),
  'utf8'
)

let sqlite: Database.Database
let seq = 0

function seed(source: string, type: string, title: string, iso: string | null): void {
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?, ?, ?, ?, ?)'
    )
    .run(source, type, iso ? Date.parse(iso) : null, title, `seed|${seq++}`)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(RECORDS_DDL)
  sqlite.exec(INDEXES_SQL)
  seq = 0
  // A little multi-year archive.
  seed('netflix', 'watch', 'The Matrix', '2020-07-08T20:00:00Z')
  seed('netflix', 'watch', 'Inception', '2020-07-08T22:00:00Z')
  seed('netflix', 'watch', 'Interstellar', '2021-07-08T21:00:00Z')
  seed('amazon', 'order', 'USB-C Cable', '2021-07-08T12:00:00Z')
  seed('amazon', 'order', 'Desk Lamp', '2021-08-01T12:00:00Z')
  seed('paypal', 'payment', 'Coffee Fund', '2024-02-29T10:00:00Z') // leap day
  seed('browser', 'visit', 'news site', '2021-07-08T13:00:00Z') // firehose
  seed('generic', 'event', 'telemetry ping', '2021-07-08T14:00:00Z') // firehose
  seed('netflix', 'watch', 'Undated Pilot', null)
  // UTC day-boundary probes.
  seed('netflix', 'watch', 'Last Millisecond', '2021-07-08T23:59:59.999Z')
  seed('netflix', 'watch', 'Next Midnight', '2021-07-09T00:00:00.000Z')
})
afterEach(() => sqlite.close())

describe('recordsHistogram', () => {
  it('buckets by year, excluding firehose + undated rows by default', () => {
    expect(recordsHistogram(sqlite, { bucket: 'year' })).toEqual([
      { bucket: '2020', count: 2 },
      { bucket: '2021', count: 5 }, // Interstellar, cable, lamp, Last Ms, Next Midnight
      { bucket: '2024', count: 1 }
    ])
  })

  it('buckets by month and honors source + firehose options', () => {
    expect(recordsHistogram(sqlite, { bucket: 'month', source: 'amazon' })).toEqual([
      { bucket: '2021-07', count: 1 },
      { bucket: '2021-08', count: 1 }
    ])
    const withFirehose = recordsHistogram(sqlite, { bucket: 'year', includeFirehose: true })
    expect(withFirehose.find((b) => b.bucket === '2021')?.count).toBe(7)
  })
})

describe('utcDayBounds', () => {
  it('returns a [midnight, midnight) UTC window and rejects malformed keys', () => {
    const b = utcDayBounds('2021-07-08')
    expect(b?.start).toBe(Date.parse('2021-07-08T00:00:00.000Z'))
    expect(b?.end).toBe(Date.parse('2021-07-09T00:00:00.000Z'))
    expect(utcDayBounds('2021-7-8')).toBeNull()
    expect(utcDayBounds('not-a-day')).toBeNull()
    expect(utcDayBounds('2021-99-99')).toBeNull()
  })
})

describe('recordsForDay', () => {
  it('returns exactly the UTC day, newest first, without firehose', () => {
    const rows = recordsForDay(sqlite, { day: '2021-07-08' })
    expect(rows.map((r) => r.title)).toEqual(['Last Millisecond', 'Interstellar', 'USB-C Cable'])
  })

  it('honors source filter and includeFirehose', () => {
    expect(
      recordsForDay(sqlite, { day: '2021-07-08', source: 'amazon' }).map((r) => r.title)
    ).toEqual(['USB-C Cable'])
    expect(recordsForDay(sqlite, { day: '2021-07-08', includeFirehose: true })).toHaveLength(5)
    expect(recordsForDay(sqlite, { day: 'garbage' })).toEqual([])
  })
})

describe('daySummary', () => {
  it('rolls up per source+type, biggest first, INCLUDING firehose, with ≤3 samples', () => {
    seed('netflix', 'watch', 'Extra 1', '2021-07-08T01:00:00Z')
    seed('netflix', 'watch', 'Extra 2', '2021-07-08T02:00:00Z')
    seed('netflix', 'watch', 'Extra 3', '2021-07-08T03:00:00Z')
    const groups = daySummary(sqlite, { day: '2021-07-08' })
    expect(groups[0]).toMatchObject({ source: 'netflix', type: 'watch', count: 5 })
    expect(groups[0].sampleTitles).toEqual(['Last Millisecond', 'Interstellar', 'Extra 3'])
    const sources = groups.map((g) => g.source)
    expect(sources).toContain('browser')
    expect(sources).toContain('generic')
  })
})

describe('onThisDayAllYears', () => {
  it('groups matching month-day across every year, newest first, firehose excluded', () => {
    const years = onThisDayAllYears(sqlite, { month: 7, day: 8 })
    expect(years.map((y) => y.year)).toEqual([2021, 2020])
    expect(years[0].count).toBe(3) // Interstellar, cable, Last Millisecond
    expect(years[1].records.map((r) => r.title)).toEqual(['Inception', 'The Matrix'])
    for (const y of years) {
      expect(y.records.some((r) => r.source === 'browser' || r.source === 'generic')).toBe(false)
    }
  })

  it('caps records per year while reporting the true count', () => {
    const years = onThisDayAllYears(sqlite, { month: 7, day: 8, perYearCap: 1 })
    const y2021 = years.find((y) => y.year === 2021)
    expect(y2021?.count).toBe(3)
    expect(y2021?.records).toHaveLength(1)
    expect(y2021?.records[0].title).toBe('Last Millisecond') // newest kept
  })

  it('excludes the requested year via excludeYear and rejects invalid month/day', () => {
    const years = onThisDayAllYears(sqlite, { month: 7, day: 8, excludeYear: 2021 })
    expect(years.map((y) => y.year)).toEqual([2020])
    expect(onThisDayAllYears(sqlite, { month: 13, day: 1 })).toEqual([])
    expect(onThisDayAllYears(sqlite, { month: 0, day: 1 })).toEqual([])
    expect(onThisDayAllYears(sqlite, { month: 2, day: 32 })).toEqual([])
  })

  it('handles leap-day lookups', () => {
    const years = onThisDayAllYears(sqlite, { month: 2, day: 29 })
    expect(years).toHaveLength(1)
    expect(years[0].records[0].title).toBe('Coffee Fund')
  })
})
