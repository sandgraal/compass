/**
 * Location clustering for the Places map — PURE (no Electron, no Drizzle).
 *
 * A Google Location History import can hold hundreds of thousands of raw GPS
 * points; the renderer map needs a BOUNDED payload. Points are snapped to a
 * lat/lng grid (2 decimals ≈ 1.1 km cells), each cell accumulating a visit
 * count, a first/last-seen span, and the MEAN position of its points (so the
 * pin sits on the data's center of mass, not a grid corner). Cells are ranked
 * by count and capped.
 */

export interface LocationPointInput {
  lat: number
  lng: number
  occurredAt: number | null
}

export interface MapCell {
  lat: number
  lng: number
  count: number
  firstSeen: number | null
  lastSeen: number | null
}

export interface ClusterResult {
  cells: MapCell[]
  /** [west, south, east, north] over the KEPT cells, or null when empty. */
  bounds: [number, number, number, number] | null
  totalPoints: number
  /** True when low-count cells were dropped by the cap. */
  truncated: boolean
}

const DEFAULT_CELL_DECIMALS = 2
const DEFAULT_MAX_CELLS = 2000

export function clusterLocationPoints(
  points: LocationPointInput[],
  opts?: { cellDecimals?: number; maxCells?: number }
): ClusterResult {
  const decimals = opts?.cellDecimals ?? DEFAULT_CELL_DECIMALS
  const maxCells = Math.max(1, opts?.maxCells ?? DEFAULT_MAX_CELLS)
  const factor = 10 ** decimals

  interface Acc {
    sumLat: number
    sumLng: number
    count: number
    firstSeen: number | null
    lastSeen: number | null
  }
  const grid = new Map<string, Acc>()
  let total = 0

  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) continue
    total++
    const key = `${Math.round(p.lat * factor)},${Math.round(p.lng * factor)}`
    const acc = grid.get(key) ?? {
      sumLat: 0,
      sumLng: 0,
      count: 0,
      firstSeen: null,
      lastSeen: null
    }
    acc.sumLat += p.lat
    acc.sumLng += p.lng
    acc.count++
    if (p.occurredAt != null) {
      if (acc.firstSeen == null || p.occurredAt < acc.firstSeen) acc.firstSeen = p.occurredAt
      if (acc.lastSeen == null || p.occurredAt > acc.lastSeen) acc.lastSeen = p.occurredAt
    }
    grid.set(key, acc)
  }

  const all: MapCell[] = [...grid.values()].map((a) => ({
    lat: a.sumLat / a.count,
    lng: a.sumLng / a.count,
    count: a.count,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen
  }))
  all.sort((a, b) => b.count - a.count)
  const truncated = all.length > maxCells
  const cells = all.slice(0, maxCells)

  let bounds: ClusterResult['bounds'] = null
  for (const c of cells) {
    if (!bounds) bounds = [c.lng, c.lat, c.lng, c.lat]
    else {
      if (c.lng < bounds[0]) bounds[0] = c.lng
      if (c.lat < bounds[1]) bounds[1] = c.lat
      if (c.lng > bounds[2]) bounds[2] = c.lng
      if (c.lat > bounds[3]) bounds[3] = c.lat
    }
  }

  return { cells, bounds, totalPoints: total, truncated }
}
