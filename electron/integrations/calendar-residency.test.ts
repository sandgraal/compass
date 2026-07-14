/**
 * Calendar → travel segments (the `source='calendar'` feed): the conservative
 * heuristic (multi-day + curated destination match, exclusive all-day ends,
 * home-country drop, no homograph traps), and the replace-only-own-rows
 * reconcile contract shared with the location projector.
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveCalendarSegments, detectTripCountry, eventsToSegments } from './calendar-residency'

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'google',
      external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      start_at INTEGER, end_at INTEGER, all_day INTEGER NOT NULL DEFAULT 0,
      location TEXT, description TEXT, html_link TEXT, synced_at INTEGER
    );
  `)
  return sqlite
}

let sqlite: Database.Database
let seq = 0
beforeEach(() => {
  sqlite = makeDb()
  seq = 0
})

function addEvent(e: {
  title: string
  location?: string | null
  startAt: number | null
  endAt: number | null
  allDay?: boolean
}): void {
  sqlite
    .prepare(
      `INSERT INTO calendar_events (external_id, title, location, start_at, end_at, all_day)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(`ev-${seq++}`, e.title, e.location ?? null, e.startAt, e.endAt, e.allDay ? 1 : 0)
}

const at = (iso: string): number => new Date(`${iso}T00:00:00`).getTime()

describe('detectTripCountry', () => {
  it('matches countries and unambiguous cities, word-bounded', () => {
    expect(detectTripCountry('Trip to Spain')).toBe('ES')
    expect(detectTripCountry('Madrid offsite')).toBe('ES')
    expect(detectTripCountry('Flying to Mexico City')).toBe('MX')
    expect(detectTripCountry('Despain family reunion')).toBeNull() // no substring hit
    expect(detectTripCountry('Panama hat shopping list')).toBe('PA') // word match is accepted
  })

  it('deliberately has no homograph countries or ambiguous cities', () => {
    for (const trap of ['Thanksgiving turkey prep', 'Georgia peaches', 'San Jose standup']) {
      expect(detectTripCountry(trap)).toBeNull()
    }
    expect(detectTripCountry('San José offsite')).toBe('CR') // accented form is safe
  })
})

describe('eventsToSegments', () => {
  it('emits multi-day matches, preferring location over title', () => {
    const segs = eventsToSegments(
      [
        {
          title: 'Team offsite',
          location: 'Barcelona, Spain',
          startAt: at('2026-09-07'),
          endAt: at('2026-09-11'), // exclusive all-day end
          allDay: true
        }
      ],
      { homeCountry: 'CR' }
    )
    expect(segs).toEqual([
      { country: 'ES', startDate: '2026-09-07', endDate: '2026-09-10', title: 'Team offsite' }
    ])
  })

  it('skips single-day events, unmatched destinations, and the home country', () => {
    const base = { startAt: at('2026-09-07'), endAt: at('2026-09-08'), allDay: true }
    const segs = eventsToSegments(
      [
        { title: 'Day trip to Madrid', location: null, ...base }, // 1 day (exclusive end)
        {
          title: 'Dentist',
          location: 'Downtown',
          startAt: at('2026-09-07'),
          endAt: at('2026-09-09'),
          allDay: true
        },
        {
          title: 'Beach week in Costa Rica',
          location: null,
          startAt: at('2026-09-07'),
          endAt: at('2026-09-12'),
          allDay: true
        }
      ],
      { homeCountry: 'CR' }
    )
    expect(segs).toEqual([])
  })

  it('handles timed events spanning days (inclusive end day)', () => {
    const segs = eventsToSegments(
      [
        {
          title: 'Conference — Tokyo',
          location: null,
          startAt: new Date('2026-10-05T09:00:00').getTime(),
          endAt: new Date('2026-10-08T17:00:00').getTime(),
          allDay: false
        }
      ],
      { homeCountry: 'CR' }
    )
    expect(segs).toEqual([
      { country: 'JP', startDate: '2026-10-05', endDate: '2026-10-08', title: 'Conference — Tokyo' }
    ])
  })
})

describe('deriveCalendarSegments', () => {
  it('writes source=calendar rows, preserves other sources, and is idempotent', () => {
    // Manual + location rows that must survive.
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date, source) VALUES ('US', '2026-05-01', '2026-05-15', 'manual')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date, source) VALUES ('ES', '2026-01-01', '2026-01-05', 'location')"
      )
      .run()
    addEvent({
      title: 'Offsite in Madrid',
      startAt: at('2026-09-07'),
      endAt: at('2026-09-11'),
      allDay: true
    })
    addEvent({ title: 'Standup', startAt: at('2026-09-07'), endAt: at('2026-09-07'), allDay: true })

    const first = deriveCalendarSegments(sqlite)
    expect(first).toEqual({ derived: 1, removed: 0 })
    const second = deriveCalendarSegments(sqlite)
    expect(second).toEqual({ derived: 1, removed: 1 })

    const rows = sqlite
      .prepare('SELECT country, source, notes FROM travel_segments ORDER BY start_date')
      .all() as Array<{ country: string; source: string; notes: string | null }>
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.source === 'calendar')).toHaveLength(1)
    expect(rows.find((r) => r.source === 'calendar')?.notes).toContain('Offsite in Madrid')
    expect(rows.filter((r) => r.source === 'manual')).toHaveLength(1)
    expect(rows.filter((r) => r.source === 'location')).toHaveLength(1)
  })

  it('drops home-country events (home from residency config)', () => {
    sqlite
      .prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('residencyHomeCountry', 'CR', 1)"
      )
      .run()
    addEvent({
      title: 'Beach week in Costa Rica',
      startAt: at('2026-09-07'),
      endAt: at('2026-09-12'),
      allDay: true
    })
    addEvent({
      title: 'Week in Portugal',
      startAt: at('2026-10-01'),
      endAt: at('2026-10-08'),
      allDay: true
    })
    const res = deriveCalendarSegments(sqlite)
    expect(res.derived).toBe(1)
    const row = sqlite.prepare('SELECT country FROM travel_segments').get() as { country: string }
    expect(row.country).toBe('PT')
  })
})
