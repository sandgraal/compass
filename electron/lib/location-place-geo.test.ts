/**
 * Places geo-correlation — pure-core coverage (window medians, agreement
 * gates, rounding, confidence, virtual-name filter) plus the DB-facing
 * wrapper over a real in-memory location_points table.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type GeoWindowPoint,
  computePlaceGeo,
  derivePlaceGeo,
  isVirtualPlaceName
} from './location-place-geo'

// Cartago, CR — the kind of coordinates this feature exists for.
const AT = { lat: 9.8644, lng: -83.9194 }

/** A window of n points jittered tightly (~100 m) around a center. */
const windowAt = (center: GeoWindowPoint, n = 5): GeoWindowPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    lat: center.lat + (i % 3) * 0.0005,
    lng: center.lng - (i % 2) * 0.0005
  }))

describe('isVirtualPlaceName', () => {
  it('flags meeting tools and URLs, not real places', () => {
    for (const v of ['Zoom', 'zoom.us/j/123', 'Google Meet', 'Teams', 'https://meet.example']) {
      expect(isVirtualPlaceName(v)).toBe(true)
    }
    for (const real of ['CrossFit Cartago', 'Café Trigo', 'Meetinghouse Lane 4']) {
      expect(isVirtualPlaceName(real)).toBe(false)
    }
  })
})

describe('derivePlaceGeo', () => {
  it('agreeing windows produce a rounded coordinate with full confidence', () => {
    const geo = derivePlaceGeo([windowAt(AT), windowAt(AT), windowAt(AT)])
    expect(geo).toEqual({ lat: 9.86, lng: -83.92, confidence: 1 })
  })

  it('windows without enough points lower confidence but do not veto', () => {
    const geo = derivePlaceGeo([windowAt(AT), windowAt(AT), [], [{ ...AT }]])
    expect(geo?.lat).toBe(9.86)
    expect(geo?.confidence).toBe(0.5)
  })

  it('rejects a single matched window — one co-occurrence is coincidence', () => {
    expect(derivePlaceGeo([windowAt(AT), []])).toBeNull()
  })

  it('rejects scattered window medians (no fixed location)', () => {
    // Four windows in four different towns tens of km apart.
    const towns = [
      AT,
      { lat: 9.99, lng: -84.12 },
      { lat: 10.3, lng: -84.43 },
      { lat: 9.6, lng: -83.6 }
    ]
    expect(derivePlaceGeo(towns.map((t) => windowAt(t)))).toBeNull()
  })

  it('a single outlier window cannot veto a stable majority', () => {
    const geo = derivePlaceGeo([
      windowAt(AT),
      windowAt(AT),
      windowAt(AT),
      windowAt({ lat: 26.71, lng: -80.05 }) // one visit logged while traveling
    ])
    expect(geo?.lat).toBe(9.86)
    expect(geo?.confidence).toBe(1)
  })

  it('returns null for no windows', () => {
    expect(derivePlaceGeo([])).toBeNull()
  })
})

describe('computePlaceGeo', () => {
  let sqlite: Database.Database
  const HOUR = 3_600_000
  const T0 = new Date('2026-03-02T18:00:00Z').getTime()

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE location_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
        lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
        src TEXT NOT NULL, dedup_hash TEXT NOT NULL UNIQUE, ingested_at INTEGER
      );
      CREATE INDEX idx_location_points_occurred_at ON location_points (occurred_at);
    `)
  })
  afterEach(() => sqlite.close())

  let seq = 0
  function seedPoint(occurredAt: number, lat: number, lng: number, accuracy: number | null = 10) {
    sqlite
      .prepare(
        `INSERT INTO location_points (occurred_at, lat, lng, accuracy, src, dedup_hash)
         VALUES (?, ?, ?, ?, 'gpx', ?)`
      )
      .run(occurredAt, lat, lng, accuracy, `p${seq++}`)
  }

  function seedVisitCluster(visitAt: number): void {
    for (let i = 0; i < 4; i++) {
      seedPoint(visitAt + i * 10 * 60_000, AT.lat + i * 0.0002, AT.lng - i * 0.0002)
    }
  }

  it('correlates visits with in-window points into a coarse coordinate', () => {
    const visits = [T0, T0 + 7 * 24 * HOUR, T0 + 14 * 24 * HOUR]
    for (const v of visits) seedVisitCluster(v)
    expect(computePlaceGeo(sqlite, 'CrossFit Cartago', visits)).toEqual({
      lat: 9.86,
      lng: -83.92,
      confidence: 1
    })
  })

  it('ignores points outside the ±2h window and bad-accuracy fixes', () => {
    const visits = [T0, T0 + 7 * 24 * HOUR]
    for (const v of visits) {
      seedVisitCluster(v)
      seedPoint(v + 5 * HOUR, 26.71, -80.05) // out of window
      seedPoint(v + HOUR, 26.71, -80.05, 5000) // in window, terrible accuracy
    }
    expect(computePlaceGeo(sqlite, 'CrossFit Cartago', visits)?.lat).toBe(9.86)
  })

  it('returns null for virtual place names and undated visits', () => {
    seedVisitCluster(T0)
    seedVisitCluster(T0 + 24 * HOUR)
    expect(computePlaceGeo(sqlite, 'Zoom', [T0, T0 + 24 * HOUR])).toBeNull()
    expect(computePlaceGeo(sqlite, 'CrossFit Cartago', [null, null])).toBeNull()
  })

  it('returns null when the GPS store is empty', () => {
    expect(computePlaceGeo(sqlite, 'CrossFit Cartago', [T0, T0 + HOUR])).toBeNull()
  })
})
