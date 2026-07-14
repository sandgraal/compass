/**
 * Geo projection math for the offline Places map — PURE, unit-tested.
 *
 * Web-Mercator: world x = longitude (degrees), world y = -mercator(latitude)
 * scaled to the same degree-ish units (so north renders up in SVG's y-down
 * space and x/y spans stay comparable). Latitudes are clamped to ±85.05° —
 * the standard square-Mercator cutoff — making the projected world a
 * 360×360 box. The map component drives an SVG viewBox in these world units;
 * all pan/zoom/fit math lives here and is projection-agnostic except for
 * `project`/`unproject`/`fitBounds`/`polygonToPath`.
 */

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

/** Square-Mercator latitude cutoff: mercY(±85.05113°) = ±180 world units. */
const MAX_LAT = 85.05113

const RAD = Math.PI / 180

/**
 * Mercator y for a latitude, in degree-scale units (±180 at the cutoff).
 * The asinh(tan φ) identity is used over ln(tan(π/4+φ/2)) because it is
 * exactly 0 at the equator — no float residue polluting SVG paths.
 */
function mercY(lat: number): number {
  const clamped = Math.min(Math.max(lat, -MAX_LAT), MAX_LAT)
  return Math.asinh(Math.tan(clamped * RAD)) / RAD
}

/** Inverse of `mercY`. */
function invMercY(y: number): number {
  return Math.atan(Math.sinh(y * RAD)) / RAD
}

/** The whole world in projected units. */
export const WORLD: ViewBox = { x: -180, y: -180, w: 360, h: 360 }

/** Project a [lng, lat] pair into world/SVG coordinates. */
export function project(lng: number, lat: number): { x: number; y: number } {
  return { x: lng, y: -mercY(lat) }
}

/** Inverse of `project` (up to the ±85.05° latitude clamp). */
export function unproject(x: number, y: number): { lng: number; lat: number } {
  return { lng: x, lat: invMercY(-y) }
}

/** Clamp a viewBox inside the world, capping the span at the full world. */
export function clampViewBox(vb: ViewBox): ViewBox {
  const w = Math.min(vb.w, WORLD.w)
  const h = Math.min(vb.h, WORLD.h)
  const x = Math.min(Math.max(vb.x, WORLD.x), WORLD.x + WORLD.w - w)
  const y = Math.min(Math.max(vb.y, WORLD.y), WORLD.y + WORLD.h - h)
  return { x, y, w, h }
}

/**
 * Fit a data bounds `[west, south, east, north]` (lat/lng degrees) into a
 * viewBox of the given aspect ratio (width/height), padded and with a minimum
 * span so a single cluster doesn't zoom to a microscopic box. North/south are
 * run through the Mercator transform BEFORE centering — the vertical middle
 * of a latitude range is not its arithmetic midpoint. Null bounds → the
 * whole world.
 */
export function fitBounds(
  bounds: [number, number, number, number] | null,
  aspect: number,
  opts?: { paddingFrac?: number; minSpan?: number }
): ViewBox {
  if (!bounds) return { ...WORLD }
  const paddingFrac = opts?.paddingFrac ?? 0.15
  const minSpan = opts?.minSpan ?? 2 // world units — a comfortable city-ish view
  const [west, south, east, north] = bounds
  const yTop = project(0, north).y // north = smaller y (y points down)
  const yBottom = project(0, south).y

  let w = Math.max(east - west, minSpan)
  let h = Math.max(yBottom - yTop, minSpan)
  w *= 1 + paddingFrac * 2
  h *= 1 + paddingFrac * 2

  // Grow the short side to match the target aspect so the data isn't distorted.
  if (w / h < aspect) w = h * aspect
  else h = w / aspect

  const cx = (west + east) / 2
  const cy = (yTop + yBottom) / 2
  return clampViewBox({ x: cx - w / 2, y: cy - h / 2, w, h })
}

/**
 * Zoom around a fixed world-space point (the cursor) by `factor` (>1 zooms out,
 * <1 zooms in). The cursor point keeps its world position under the cursor.
 */
export function zoomAt(vb: ViewBox, cursor: { x: number; y: number }, factor: number): ViewBox {
  const w = vb.w * factor
  const h = vb.h * factor
  // Keep the cursor's relative position in the box constant.
  const relX = (cursor.x - vb.x) / vb.w
  const relY = (cursor.y - vb.y) / vb.h
  return clampViewBox({ x: cursor.x - relX * w, y: cursor.y - relY * h, w, h })
}

/** Pan by a world-space delta, clamped to the world. */
export function panBy(vb: ViewBox, dx: number, dy: number): ViewBox {
  return clampViewBox({ x: vb.x + dx, y: vb.y + dy, w: vb.w, h: vb.h })
}

/** Build an SVG path string for one polygon (exterior ring + holes) of country geometry. */
export function polygonToPath(poly: number[][][]): string {
  let d = ''
  for (const ring of poly) {
    if (ring.length === 0) continue
    const first = project(ring[0][0], ring[0][1])
    d += `M${first.x},${first.y}`
    for (let i = 1; i < ring.length; i++) {
      const p = project(ring[i][0], ring[i][1])
      d += `L${p.x},${p.y}`
    }
    d += 'Z'
  }
  return d
}
