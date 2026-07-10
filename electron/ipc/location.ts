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
 * per-point rows: points are clustered in the main process (electron/lib/
 * location-clusters.ts) into a bounded set of ~1 km cells before crossing IPC.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `location:map-data` → clustered cells + data bounds + the bundled offline
 * country basemap (electron/lib/country-boundaries.json — the same asset the
 * residency engine uses; zero network, zero CSP impact).
 */
import type { IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import boundariesRaw from '../lib/country-boundaries.json'
import { type MapCell, clusterLocationPoints } from '../lib/location-clusters'

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

/** Read + cluster the raw points. Separated for tests (no dialog/window deps). */
export function buildLocationMapData(): LocationMapData {
  let rows: Array<{ lat: number; lng: number; occurred_at: number | null }> = []
  try {
    rows = getRawSqlite()
      .prepare('SELECT lat, lng, occurred_at FROM location_points')
      .all() as typeof rows
  } catch {
    rows = [] // table absent on a pristine DB → empty map
  }
  const { cells, bounds, totalPoints, truncated } = clusterLocationPoints(
    rows.map((r) => ({ lat: r.lat, lng: r.lng, occurredAt: r.occurred_at }))
  )
  let firstSeen: number | null = null
  let lastSeen: number | null = null
  for (const c of cells) {
    if (c.firstSeen != null && (firstSeen == null || c.firstSeen < firstSeen)) {
      firstSeen = c.firstSeen
    }
    if (c.lastSeen != null && (lastSeen == null || c.lastSeen > lastSeen)) lastSeen = c.lastSeen
  }
  return {
    cells,
    bounds,
    totalPoints,
    truncated,
    firstSeen,
    lastSeen,
    basemap: boundariesRaw as CountryShape[]
  }
}

export function registerLocationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('location:map-data', (): LocationMapData => buildLocationMapData())
}
