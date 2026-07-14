/**
 * Places geo-correlation (PlaceMeta.geo) — derive a tracked place's APPROXIMATE
 * coordinate from where the GPS history says the user was during their visits
 * (calendar events at the place, rideshare dropoffs). No network, no geocoder:
 * pure temporal correlation against the local `location_points` store.
 *
 * PRIVACY: this is the only module outside electron/ipc/location.ts that reads
 * `location_points`, and it exports only a single COARSE aggregate per place —
 * lat/lng rounded to 2 decimals (~1.1 km), the exact granularity the offline
 * map's cells already expose (electron/lib/location-clusters.ts). Raw points
 * never leave the main process; nothing here reaches the records spine, FTS,
 * or assistant/MCP tools.
 *
 * Method: for each dated visit, take the GPS points inside a ±2 h window; a
 * window with enough points contributes its median position. The place's
 * coordinate is the median of window medians, accepted only when several
 * windows agree within a tight dispersion gate — one co-occurrence is
 * coincidence, five tight ones are a location. Virtual-meeting "places"
 * (Zoom/Meet/Teams…) are skipped by name: the correlation would confidently
 * find the user's home, which is the right answer to the wrong question.
 */

import type Database from 'better-sqlite3'
import { median } from './normalize'

/** ±2 h — wide enough for arrive-early/leave-late, narrow enough to stay on-site. */
const WINDOW_MS = 2 * 60 * 60 * 1000
/** A window needs this many points to contribute a median. */
const MIN_POINTS_PER_WINDOW = 3
/** Accept only when at least this many windows agree. */
const MIN_MATCHED_WINDOWS = 2
/** Window medians must sit within ~this radius of their center to count as agreement. */
const MAX_DISPERSION_KM = 1.5
/** Bound the per-place work: correlate against at most this many recent visits. */
const MAX_WINDOWS = 40
/** Ignore fixes worse than this (meters) when the export carries accuracy. */
const MAX_ACCURACY_M = 200

const KM_PER_DEG_LAT = 110.57
const KM_PER_DEG_LNG_EQUATOR = 111.32

export interface GeoWindowPoint {
  lat: number
  lng: number
}

export interface PlaceGeoResult {
  /** Rounded to 2 decimals (~1.1 km) — the map-cell granularity. */
  lat: number
  lng: number
  /** Fraction of considered visit windows that matched (0–1, 2 decimals). */
  confidence: number
}

/** Calendar locations that name a meeting tool, not a physical place. */
const VIRTUAL_PLACE_RE =
  /^(zoom|google meet|meet|teams|microsoft teams|skype|webex|hangouts?|facetime|discord|slack)\b|^https?:\/\//i

export function isVirtualPlaceName(name: string): boolean {
  return VIRTUAL_PLACE_RE.test(name.trim())
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Equirectangular distance in km — plenty at the ~1 km scales gated here. */
function distanceKm(a: GeoWindowPoint, b: GeoWindowPoint): number {
  const midLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const dx = (b.lng - a.lng) * KM_PER_DEG_LNG_EQUATOR * Math.cos(midLatRad)
  const dy = (b.lat - a.lat) * KM_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Pure core: given the GPS points found in each visit window, derive the
 * place's coordinate — or null when the evidence is thin or scattered.
 * `windows.length` is the number of CONSIDERED windows (the confidence
 * denominator), including ones that turned up no points.
 */
export function derivePlaceGeo(windows: GeoWindowPoint[][]): PlaceGeoResult | null {
  if (windows.length === 0) return null
  const windowMedians: GeoWindowPoint[] = []
  for (const points of windows) {
    if (points.length < MIN_POINTS_PER_WINDOW) continue
    windowMedians.push({
      lat: median(points.map((p) => p.lat)),
      lng: median(points.map((p) => p.lng))
    })
  }
  if (windowMedians.length < MIN_MATCHED_WINDOWS) return null

  const center: GeoWindowPoint = {
    lat: median(windowMedians.map((m) => m.lat)),
    lng: median(windowMedians.map((m) => m.lng))
  }
  // Agreement gate: the MEDIAN deviation must be tight (a single errand
  // mid-window can't veto), but if half the windows scatter, this isn't a
  // fixed location — reject rather than pin a guess on the map.
  const deviations = windowMedians.map((m) => distanceKm(m, center))
  if (median(deviations) > MAX_DISPERSION_KM) return null

  return {
    lat: round2(center.lat),
    lng: round2(center.lng),
    confidence: Math.round((windowMedians.length / windows.length) * 100) / 100
  }
}

/**
 * DB-facing wrapper: build ±2 h windows around the most recent dated visit
 * times and run the correlation. Each window is one indexed range scan
 * (idx_location_points_occurred_at, migration 0042). Returns null when the
 * place name is virtual, there are no dated visits, or the evidence fails
 * the gates above.
 */
export function computePlaceGeo(
  sqlite: Database.Database,
  placeName: string,
  visitTimes: Array<number | null>
): PlaceGeoResult | null {
  if (isVirtualPlaceName(placeName)) return null
  const dated = visitTimes
    .filter((t): t is number => t != null)
    .sort((a, b) => b - a)
    .slice(0, MAX_WINDOWS)
  if (dated.length === 0) return null

  const select = sqlite.prepare(
    `SELECT lat, lng FROM location_points
      WHERE occurred_at BETWEEN ? AND ?
        AND (accuracy IS NULL OR accuracy <= ${MAX_ACCURACY_M})
      LIMIT 500`
  )
  const windows = dated.map((t) => select.all(t - WINDOW_MS, t + WINDOW_MS) as GeoWindowPoint[])
  return derivePlaceGeo(windows)
}
