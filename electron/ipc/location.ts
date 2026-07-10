/**
 * Location map IPC — serves the Places page's offline map.
 *
 * ── PRIVACY BOUNDARY (read before touching) ─────────────────────────────────
 * This is a deliberate, UI-ONLY widening of the location boundary. Raw
 * `location_points` remain excluded from `records`, FTS, the assistant tools,
 * and MCP — the AI boundary for location stays the country-level
 * `travel_segments` aggregates (see electron/integrations/location-residency.ts
 * and the schema comment on `location_points`). This handler serves the LOCAL
 * renderer map only and must NEVER be registered as an assistant tool
 * (electron/ipc/assistant*.ts) or an MCP tool (mcp/). It also never returns raw
 * per-point rows: points are grouped into ~1 km grid cells IN SQLite (so a
 * hundreds-of-thousands-row history never materializes in JS or blocks the main
 * process), then ranked/capped by electron/lib/location-clusters.ts before
 * crossing IPC.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `location:map-data` → clustered cells + data bounds + the bundled offline
 * country basemap (electron/lib/country-boundaries.json — the same asset the
 * residency engine uses; zero network, zero CSP impact).
 */
import type { IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import boundariesRaw from '../lib/country-boundaries.json'
import { MAX_MAP_CELLS, type MapCell, finalizeMapCells } from '../lib/location-clusters'

interface CountryShape {
  iso2: string
  bbox: number[]
  geom: number[][][][]
}

export interface LocationMapData {
  cells: MapCell[]
  bounds: [number, number, number, number] | null
  totalPoints: number
  truncated: boolean
  firstSeen: number | null
  lastSeen: number | null
  basemap: CountryShape[]
}

// In-range guard shared by the grouping + totals queries — off-earth coordinates
// (corrupt exports, sentinel 0/0-ish junk beyond the poles) never reach the map.
const VALID_COORDS = 'lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180'

/** Cluster (in SQL) + shape the payload. Separated for tests (no dialog/window deps). */
export function buildLocationMapData(): LocationMapData {
  const basemap = boundariesRaw as CountryShape[]
  let grouped: MapCell[] = []
  let totals = { n: 0, mn: null as number | null, mx: null as number | null }
  try {
    const sqlite = getRawSqlite()
    // Snap to a ~1.1 km grid and aggregate IN SQLite — only the ranked cells cross
    // into JS. LIMIT is MAX_MAP_CELLS + 1 so finalizeMapCells can detect overflow
    // without counting every group.
    grouped = sqlite
      .prepare(
        `SELECT AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS count,
                MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen
           FROM location_points
          WHERE ${VALID_COORDS}
          GROUP BY ROUND(lat, 2), ROUND(lng, 2)
          ORDER BY count DESC
          LIMIT ?`
      )
      .all(MAX_MAP_CELLS + 1) as MapCell[]
    totals = sqlite
      .prepare(
        `SELECT COUNT(*) AS n, MIN(occurred_at) AS mn, MAX(occurred_at) AS mx
           FROM location_points WHERE ${VALID_COORDS}`
      )
      .get() as typeof totals
  } catch {
    return {
      cells: [],
      bounds: null,
      totalPoints: 0,
      truncated: false,
      firstSeen: null,
      lastSeen: null,
      basemap
    } // table absent on a pristine DB → empty map
  }
  const { cells, bounds, truncated } = finalizeMapCells(grouped, { maxCells: MAX_MAP_CELLS })
  return {
    cells,
    bounds,
    totalPoints: totals.n ?? 0,
    truncated,
    firstSeen: totals.mn,
    lastSeen: totals.mx,
    basemap
  }
}

export function registerLocationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('location:map-data', (): LocationMapData => buildLocationMapData())
}
