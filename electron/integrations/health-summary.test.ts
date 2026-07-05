// TZ pinned so localYmd(occurred_at) is deterministic regardless of the runner's zone.
process.env.TZ = 'UTC'

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { STEP_GOAL, buildHealthSummary } from './health-summary'

const TODAY = Date.UTC(2025, 5, 15, 12) // 2025-06-15 noon UTC
const dayMs = (dom: number) => Date.UTC(2025, 5, dom, 12) // June `dom` noon UTC → '2025-06-<dom>'

function makeDb(withOura = true): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
  `)
  if (withOura) {
    sqlite.exec(`
      CREATE TABLE oura_daily_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
        sleep_score INTEGER, readiness_score INTEGER, activity_score INTEGER,
        steps INTEGER, total_sleep_minutes INTEGER, synced_at INTEGER
      );
    `)
  }
  return sqlite
}

let h = 0
function rec(
  sqlite: Database.Database,
  source: string,
  type: string,
  at: number,
  title: string,
  payload: unknown
): void {
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(source, type, at, title, JSON.stringify(payload), `h${h++}`)
}
function oura(
  sqlite: Database.Database,
  date: string,
  sleep: number,
  readiness: number,
  activity: number,
  steps: number,
  sleepMin: number
): void {
  sqlite
    .prepare(
      'INSERT INTO oura_daily_metrics (date, sleep_score, readiness_score, activity_score, steps, total_sleep_minutes) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(date, sleep, readiness, activity, steps, sleepMin)
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('buildHealthSummary', () => {
  it('returns empty-but-safe aggregates on an empty DB', () => {
    const s = buildHealthSummary(sqlite, TODAY)
    expect(s.today).toBe('2025-06-15')
    expect(s.steps.last7Avg).toBeNull()
    expect(s.oura.hasData).toBe(false)
    expect(s.activeDays30).toBe(0)
    expect(s.sources.every((x) => !x.hasData)).toBe(true)
  })

  it('does not throw when the oura table is absent', () => {
    const noOura = makeDb(false)
    rec(noOura, 'apple-health', 'steps', dayMs(15), '9,000 steps', { value: 9000 })
    const s = buildHealthSummary(noOura, TODAY)
    expect(s.oura.hasData).toBe(false)
    expect(s.steps.last30Avg).toBe(9000)
  })

  it('unifies Oura + records into trends, rollups, and coverage', () => {
    oura(sqlite, '2025-06-14', 80, 75, 70, 10000, 420)
    oura(sqlite, '2025-06-15', 90, 85, 88, 12000, 400)
    rec(sqlite, 'apple-health', 'steps', dayMs(13), '8,000 steps', { value: 8000 })
    rec(sqlite, 'fitbit', 'sleep', dayMs(14), '7h 30m asleep', { minutesAsleep: 450 })
    rec(sqlite, 'garmin', 'workout', dayMs(15), 'Running · 5 km', { type: 'running' })
    rec(sqlite, 'apple-health', 'resting-hr', dayMs(15), '55 bpm', { value: 55 })
    rec(sqlite, 'apple-health', 'weight', dayMs(14), '70 kg', { value: 70 })

    const s = buildHealthSummary(sqlite, TODAY)

    // steps: 13→8000, 14→10000 (oura), 15→12000 (oura)
    expect(s.steps.last7Avg).toBe(10000)
    expect(s.steps.best).toEqual({ date: '2025-06-15', steps: 12000 })
    // sleep: 14→max(oura 420, fitbit 450)=450, 15→400
    expect(s.sleep.last7AvgMin).toBe(425)
    // oura scores
    expect(s.oura.latest).toMatchObject({ date: '2025-06-15', sleepScore: 90, readinessScore: 85 })
    expect(s.oura.sleepScore7Avg).toBe(85) // (80+90)/2
    // resting HR + weight latest
    expect(s.restingHr.latest).toEqual({ date: '2025-06-15', bpm: 55 })
    expect(s.weight.latest).toEqual({ date: '2025-06-14', value: 70 })
    // workouts
    expect(s.workouts.last30Count).toBe(1)
    expect(s.workouts.recent[0]).toMatchObject({ source: 'garmin', title: 'Running · 5 km' })
    // active days: 13 (8000≥goal), 14 (10000), 15 (12000 + workout) = 3
    expect(STEP_GOAL).toBe(8000)
    expect(s.activeDays30).toBe(3)
    // coverage
    const bySrc = Object.fromEntries(s.sources.map((x) => [x.source, x]))
    expect(bySrc.oura.count).toBe(2)
    expect(bySrc['apple-health'].count).toBe(3) // steps + resting-hr + weight
    expect(bySrc.fitbit.hasData).toBe(true)
    expect(bySrc.garmin.count).toBe(1)
  })

  it('takes the MAX across sources for the same day (no double-count)', () => {
    oura(sqlite, '2025-06-15', 90, 85, 88, 12000, 400)
    rec(sqlite, 'apple-health', 'steps', dayMs(15), '5,000 steps', { value: 5000 }) // same day, lower
    const s = buildHealthSummary(sqlite, TODAY)
    const day15 = s.steps.series.find((p) => p.date === '2025-06-15')
    expect(day15?.steps).toBe(12000) // MAX(12000, 5000), not 17000
  })

  it('excludes data older than the windows from the averages', () => {
    rec(sqlite, 'apple-health', 'steps', dayMs(15), '10,000 steps', { value: 10000 })
    rec(sqlite, 'apple-health', 'steps', Date.UTC(2025, 3, 1, 12), 'old', { value: 2000 }) // April → outside 30d
    const s = buildHealthSummary(sqlite, TODAY)
    expect(s.steps.last30Avg).toBe(10000) // the April day is excluded
    expect(s.steps.best).toEqual({ date: '2025-06-15', steps: 10000 }) // best still scans all, but April<June
  })
})
