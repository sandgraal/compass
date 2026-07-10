/**
 * Location map cell finalization — PURE (no Electron, no Drizzle).
 *
 * A Google Location History import can hold hundreds of thousands of raw GPS
 * points, so the HEAVY grouping — snap each point to a lat/lng grid (2 decimals
 * ≈ 1.1 km cells), count visits, average the position, span first/last-seen —
 * is done in SQL by the `location:map-data` handler. Raw points never
 * materialize in JS; only the already-grouped cells reach this module, which
 * ranks them by visit count, caps the set, and computes the geographic bounds
 * over the kept cells so the renderer map has a BOUNDED payload to draw.
 */

export interface MapCell {
  lat: number
  lng: number
  count: number
  firstSeen: number | null
  lastSeen: number | null
}

export interface FinalizeResult {
  cells: MapCell[]
  /** [west, south, east, north] over the KEPT cells, or null when empty. */
  bounds: [number, number, number, number] | null
  /** True when low-count cells were dropped by the cap. */
  truncated: boolean
}

/** Ceiling on cells crossing IPC — also the SQL `LIMIT` (+1, to detect overflow). */
export const MAX_MAP_CELLS = 2000

export function finalizeMapCells(cells: MapCell[], opts?: { maxCells?: number }): FinalizeResult {
  const maxCells = Math.max(1, opts?.maxCells ?? MAX_MAP_CELLS)
  const ranked = [...cells].sort((a, b) => b.count - a.count)
  const truncated = ranked.length > maxCells
  const kept = ranked.slice(0, maxCells)

  let bounds: FinalizeResult['bounds'] = null
  for (const c of kept) {
    if (!bounds) bounds = [c.lng, c.lat, c.lng, c.lat]
    else {
      if (c.lng < bounds[0]) bounds[0] = c.lng
      if (c.lat < bounds[1]) bounds[1] = c.lat
      if (c.lng > bounds[2]) bounds[2] = c.lng
      if (c.lat > bounds[3]) bounds[3] = c.lat
    }
  }

  return { cells: kept, bounds, truncated }
}
