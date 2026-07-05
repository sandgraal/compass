/**
 * Offline country derivation (Phase 10.8 — "Location → Residency autopilot").
 *
 * Residency is COUNTRY-DAY granularity, so we never need street-level geocoding —
 * only which country a point falls in. `countryForPoint` does an offline ray-cast
 * point-in-polygon against a bundled Natural Earth 1:110m boundary set (~185 KB,
 * committed at `./data/country-boundaries.json`) — zero network, zero geo deps.
 * `pointsToSegments` collapses a day's-worth of points into per-country date runs
 * that slot straight into the existing `travel_segments` / residency engine.
 *
 * Accuracy note: 110m is intentionally coarse. A point within a few km of a land
 * border can misattribute, but the user crosses a border on a tiny fraction of days
 * and residency counts whole days, so at worst one day lands in the neighbour — an
 * acceptable trade for a fully-local, dependency-free lookup. Microstates absent at
 * 110m (Vatican, Monaco, San Marino) resolve to their surrounder, which is the right
 * answer for day-counting anyway.
 */

import boundariesRaw from './country-boundaries.json'

type Ring = number[][] // [[lng, lat], …]
type Poly = Ring[] // [exteriorRing, ...holeRings]
type CountryShape = { iso2: string; bbox: number[]; geom: Poly[] }

const BOUNDARIES = boundariesRaw as CountryShape[]

const DAY_MS = 86_400_000

/** Ray-casting point-in-ring (even-odd rule). `x`=lng, `y`=lat. */
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Inside a polygon = inside its exterior ring AND not inside any hole. */
function pointInPolygon(x: number, y: number, poly: Poly): boolean {
  if (poly.length === 0 || !pointInRing(x, y, poly[0])) return false
  for (let h = 1; h < poly.length; h++) if (pointInRing(x, y, poly[h])) return false
  return true
}

/**
 * The ISO-3166 alpha-2 country a coordinate falls in, or null (ocean / unmatched).
 * A bbox pre-filter skips all but the handful of candidate countries, so each lookup
 * is effectively O(1) despite the linear scan.
 */
export function countryForPoint(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  for (const c of BOUNDARIES) {
    const [minLng, minLat, maxLng, maxLat] = c.bbox
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue
    for (const poly of c.geom) if (pointInPolygon(lng, lat, poly)) return c.iso2
  }
  return null
}

export type LocPoint = { at: number; lat: number; lng: number } // at = epoch ms

export type DerivedSegment = {
  country: string // ISO-2 upper
  startDate: string // 'YYYY-MM-DD' inclusive
  endDate: string // 'YYYY-MM-DD' inclusive
  days: number // inclusive span
  pointCount: number // raw points backing the run (for provenance notes)
}

export type PointsToSegmentsOpts = {
  homeCountry: string // ISO-2; home runs are DROPPED (residency treats home as the year-remainder)
  localDayOf: (ms: number) => string // format epoch → 'YYYY-MM-DD' in LOCAL time (injected for determinism)
  maxGapDays?: number // bridge ≤ this many dateless interior days within a same-country run (default 14)
  minDaysPerSegment?: number // drop runs shorter than this (default 1)
  countryOf?: (lat: number, lng: number) => string | null // injectable; defaults to countryForPoint
}

function utcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}
function dayDiff(a: string, b: string): number {
  return Math.round((utcDay(b) - utcDay(a)) / DAY_MS)
}
function daysInclusive(a: string, b: string): number {
  return dayDiff(a, b) + 1
}

/**
 * Collapse GPS points into per-country date runs:
 *  1. bucket by LOCAL day → each day's country is the majority (ties → the last point
 *     of the day, i.e. where you ended up);
 *  2. walk resolved days chronologically, bridging ≤ `maxGapDays` dateless interior
 *     days within a same-country run (a short data gap inside a stay is still that stay);
 *  3. a country change or a gap > `maxGapDays` breaks the run;
 *  4. drop home-country runs (home = the residency remainder) and sub-`minDaysPerSegment` runs.
 */
export function pointsToSegments(points: LocPoint[], opts: PointsToSegmentsOpts): DerivedSegment[] {
  const home = (opts.homeCountry || '').toUpperCase()
  const maxGap = opts.maxGapDays ?? 14
  const minDays = opts.minDaysPerSegment ?? 1
  const countryOf = opts.countryOf ?? countryForPoint

  // 1. per-day majority country
  type DayAgg = { counts: Map<string, number>; lastCountry: string; lastAt: number; total: number }
  const perDay = new Map<string, DayAgg>()
  for (const p of points) {
    const c = countryOf(p.lat, p.lng)
    if (!c) continue
    const day = opts.localDayOf(p.at)
    let e = perDay.get(day)
    if (!e) {
      e = { counts: new Map(), lastCountry: c, lastAt: p.at, total: 0 }
      perDay.set(day, e)
    }
    e.counts.set(c, (e.counts.get(c) ?? 0) + 1)
    e.total++
    if (p.at >= e.lastAt) {
      e.lastAt = p.at
      e.lastCountry = c
    }
  }
  if (perDay.size === 0) return []

  const dayCountry = new Map<string, { country: string; points: number }>()
  for (const [day, e] of perDay) {
    let best = ''
    let bestN = -1
    let tie = false
    for (const [c, n] of e.counts) {
      if (n > bestN) {
        best = c
        bestN = n
        tie = false
      } else if (n === bestN) {
        tie = true
      }
    }
    dayCountry.set(day, { country: tie ? e.lastCountry : best, points: e.total })
  }

  // 2/3. chronological collapse with gap bridging
  const days = [...dayCountry.keys()].sort() // 'YYYY-MM-DD' sorts chronologically
  type Run = { country: string; start: string; end: string; points: number }
  const runs: Run[] = []
  let cur: Run | null = null
  for (const day of days) {
    const dc = dayCountry.get(day)
    if (!dc) continue
    if (cur && cur.country === dc.country && dayDiff(cur.end, day) - 1 <= maxGap) {
      cur.end = day
      cur.points += dc.points
    } else {
      if (cur) runs.push(cur)
      cur = { country: dc.country, start: day, end: day, points: dc.points }
    }
  }
  if (cur) runs.push(cur)

  // 4. drop home + too-short runs
  return runs
    .filter((r) => r.country.toUpperCase() !== home)
    .filter((r) => daysInclusive(r.start, r.end) >= minDays)
    .map((r) => ({
      country: r.country.toUpperCase(),
      startDate: r.start,
      endDate: r.end,
      days: daysInclusive(r.start, r.end),
      pointCount: r.points
    }))
}
