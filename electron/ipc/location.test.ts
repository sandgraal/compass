/**
 * location:map-data IPC — real in-memory SQLite. Asserts the payload is the
 * BOUNDED cluster shape (never raw per-point rows), tolerates an absent table,
 * and ships the offline basemap.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getRawSqlite: () => sqlite
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
})
afterEach(() => sqlite.close())

function createTable(): void {
  sqlite.exec(`CREATE TABLE location_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER, lat REAL NOT NULL, lng REAL NOT NULL,
    accuracy REAL, src TEXT NOT NULL, dedup_hash TEXT NOT NULL UNIQUE, ingested_at INTEGER
  );`)
}

function addPoint(lat: number, lng: number, occurredAt: number): void {
  sqlite
    .prepare(
      'INSERT INTO location_points (occurred_at, lat, lng, src, dedup_hash) VALUES (?,?,?,?,?)'
    )
    .run(occurredAt, lat, lng, 'gpx', `${lat}|${lng}|${occurredAt}`)
}

describe('location:map-data', () => {
  it('clusters points into cells with bounds, span, and the offline basemap', async () => {
    createTable()
    addPoint(9.931, -84.081, 100)
    addPoint(9.932, -84.082, 900)
    addPoint(40.71, -74.0, 500)
    const { buildLocationMapData } = await import('./location')

    const data = buildLocationMapData()
    expect(data.totalPoints).toBe(3)
    expect(data.cells.length).toBe(2)
    expect(data.bounds).not.toBeNull()
    expect(data.firstSeen).toBe(100)
    expect(data.lastSeen).toBe(900)
    expect(data.basemap.length).toBeGreaterThan(100) // the bundled country set
    expect(data.basemap[0]).toHaveProperty('iso2')
    expect(data.basemap[0]).toHaveProperty('geom')
    // The payload is cells only — no per-point leakage.
    for (const c of data.cells) {
      expect(Object.keys(c).sort()).toEqual(['count', 'firstSeen', 'lastSeen', 'lat', 'lng'])
    }
  })

  it('returns an empty map (never throws) when the table is absent', async () => {
    const { buildLocationMapData } = await import('./location')
    const data = buildLocationMapData()
    expect(data.cells).toHaveLength(0)
    expect(data.bounds).toBeNull()
    expect(data.totalPoints).toBe(0)
  })
})
