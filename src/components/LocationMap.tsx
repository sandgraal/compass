/**
 * Offline map of everywhere the user has been — hand-rolled SVG, zero network.
 *
 * Basemap: the bundled country boundaries (ships with the app, same asset the
 * residency engine uses). Pins: clustered GPS cells from `location:map-data`
 * (bounded in the main process; raw points never cross IPC). Optional named
 * markers (tracked places with a derived coordinate) render on top. Pan by
 * drag, zoom by wheel (cursor-anchored), auto-fit to the data on load; a
 * `focus` prop zooms to one coordinate. All projection math lives in the pure,
 * tested `src/lib/geo-project.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type ViewBox,
  clampViewBox,
  fitBounds,
  panBy,
  polygonToPath,
  project,
  zoomAt
} from '../lib/geo-project'

const ASPECT = 2 // width/height of the map area
const MIN_ZOOM_SPAN = 0.5 // degrees — deepest zoom-in
const FOCUS_SPAN = 4 // degrees wide when zooming to a focused marker

export interface LocationMapMarker {
  name: string
  lat: number
  lng: number
}

function fmtDate(ms: number | null): string {
  if (ms == null) return ''
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

interface Hover {
  label: string
  sub?: string
  cx: number // screen px within the container
  cy: number
}

export default function LocationMap({
  data,
  markers,
  focus
}: {
  data: LocationMapData
  /** Tracked places with a derived coordinate — rendered as named pins on top. */
  markers?: LocationMapMarker[]
  /** Zoom the view to this coordinate when set (e.g. "Show on map"). */
  focus?: { lat: number; lng: number } | null
}): JSX.Element {
  const [viewBox, setViewBox] = useState<ViewBox>(() => fitBounds(data.bounds, ASPECT))
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null)

  // Re-fit when the data changes (e.g. a new location import landed).
  useEffect(() => {
    setViewBox(fitBounds(data.bounds, ASPECT))
  }, [data.bounds])

  // Focus wins over the auto-fit (declared after it so a mount with both set
  // lands on the focused place).
  useEffect(() => {
    if (!focus) return
    const p = project(focus.lng, focus.lat)
    setViewBox(
      clampViewBox({
        x: p.x - FOCUS_SPAN / 2,
        y: p.y - FOCUS_SPAN / ASPECT / 2,
        w: FOCUS_SPAN,
        h: FOCUS_SPAN / ASPECT
      })
    )
  }, [focus])

  // Wheel-zoom needs a NON-passive native listener: React 18 registers `onWheel`
  // as passive on the root, so preventDefault() there is ignored and the page
  // scrolls while zooming. Bind directly so we can preventDefault and cursor-anchor
  // the zoom. Cursor world-coords are computed inside the updater against the live
  // viewBox, so the empty-dep effect never reads a stale one.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    function onWheel(e: WheelEvent): void {
      const el = svgRef.current
      if (!el) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const relX = (e.clientX - rect.left) / rect.width
      const relY = (e.clientY - rect.top) / rect.height
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
      setViewBox((vb) => {
        const cursor = { x: vb.x + relX * vb.w, y: vb.y + relY * vb.h }
        const next = zoomAt(vb, cursor, factor)
        return next.w < MIN_ZOOM_SPAN ? vb : next
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  // Build the country paths ONCE — 175 shapes, static for the app's lifetime.
  const countryPaths = useMemo(
    () => data.basemap.map((c) => ({ iso2: c.iso2, d: c.geom.map(polygonToPath).join('') })),
    [data.basemap]
  )

  const maxCount = useMemo(() => Math.max(1, ...data.cells.map((c) => c.count)), [data.cells])

  function onPointerDown(e: React.PointerEvent): void {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, vb: viewBox }
  }

  function onPointerMove(e: React.PointerEvent): void {
    const drag = dragRef.current
    const svg = svgRef.current
    if (!drag || !svg) return
    const rect = svg.getBoundingClientRect()
    const dx = ((drag.x - e.clientX) / rect.width) * drag.vb.w
    const dy = ((drag.y - e.clientY) / rect.height) * drag.vb.h
    setViewBox(panBy(drag.vb, dx, dy))
  }

  function onPointerUp(): void {
    dragRef.current = null
  }

  /** Pin radius in world units: √count scaled, kept legible across zoom levels. */
  function pinR(count: number): number {
    const base = 0.25 + 0.75 * Math.sqrt(count / maxCount)
    return base * (viewBox.w / 100)
  }

  function hoverAt(lng: number, lat: number, label: string, sub?: string): void {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const p = project(lng, lat)
    setHover({
      label,
      sub,
      cx: ((p.x - viewBox.x) / viewBox.w) * rect.width,
      cy: ((p.y - viewBox.y) / viewBox.h) * rect.height
    })
  }

  function onPinHover(cell: LocationMapCell): void {
    const dates =
      cell.firstSeen != null
        ? `${fmtDate(cell.firstSeen)}${
            cell.lastSeen != null && cell.lastSeen !== cell.firstSeen
              ? ` – ${fmtDate(cell.lastSeen)}`
              : ''
          }`
        : undefined
    hoverAt(cell.lng, cell.lat, `${cell.count} ${cell.count === 1 ? 'point' : 'points'}`, dates)
  }

  return (
    <div className="relative rounded-lg border border-border bg-card/40 overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full touch-none cursor-grab active:cursor-grabbing select-none"
        style={{ aspectRatio: `${ASPECT}` }}
        role="img"
        aria-label={`Map of ${data.cells.length} places you've been`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          onPointerUp()
          setHover(null)
        }}
      >
        <g className="fill-secondary stroke-border" strokeWidth={viewBox.w / 2000}>
          {countryPaths.map((c) => (
            <path key={c.iso2} d={c.d} />
          ))}
        </g>
        <g>
          {data.cells.map((cell) => {
            const p = project(cell.lng, cell.lat)
            return (
              <circle
                key={`${cell.lat},${cell.lng}`}
                cx={p.x}
                cy={p.y}
                r={pinR(cell.count)}
                className="fill-primary/60 stroke-primary"
                strokeWidth={viewBox.w / 4000}
                onPointerEnter={() => onPinHover(cell)}
                onPointerLeave={() => setHover(null)}
              />
            )
          })}
        </g>
        {markers && markers.length > 0 && (
          <g>
            {markers.map((m) => {
              const p = project(m.lng, m.lat)
              const r = 0.8 * (viewBox.w / 100)
              return (
                // Ring + dot so tracked places read as pins, not density blobs.
                <g
                  key={`${m.name}@${m.lat},${m.lng}`}
                  onPointerEnter={() => hoverAt(m.lng, m.lat, m.name, '≈ location')}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    className="fill-card stroke-primary"
                    strokeWidth={viewBox.w / 800}
                  />
                  <circle cx={p.x} cy={p.y} r={r / 2.5} className="fill-primary" />
                </g>
              )
            })}
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-md"
          style={{
            left: Math.min(Math.max(hover.cx + 10, 4), 9999),
            top: Math.max(hover.cy - 10, 4)
          }}
        >
          <span className="font-semibold capitalize">{hover.label}</span>
          {hover.sub && <span className="text-muted-foreground"> · {hover.sub}</span>}
        </div>
      )}
    </div>
  )
}
