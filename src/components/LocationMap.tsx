/**
 * Offline map of everywhere the user has been — hand-rolled SVG, zero network.
 *
 * Basemap: the bundled country boundaries (ships with the app, same asset the
 * residency engine uses). Pins: clustered GPS cells from `location:map-data`
 * (bounded in the main process; raw points never cross IPC). Pan by drag, zoom
 * by wheel (cursor-anchored), auto-fit to the data on load. All projection math
 * lives in the pure, tested `src/lib/geo-project.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { type ViewBox, fitBounds, panBy, polygonToPath, project, zoomAt } from '../lib/geo-project'

const ASPECT = 2 // width/height of the map area
const MIN_ZOOM_SPAN = 0.5 // degrees — deepest zoom-in

function fmtDate(ms: number | null): string {
  if (ms == null) return ''
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

interface Hover {
  cell: LocationMapCell
  cx: number // screen px within the container
  cy: number
}

export default function LocationMap({ data }: { data: LocationMapData }): JSX.Element {
  const [viewBox, setViewBox] = useState<ViewBox>(() => fitBounds(data.bounds, ASPECT))
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null)

  // Re-fit when the data changes (e.g. a new location import landed).
  useEffect(() => {
    setViewBox(fitBounds(data.bounds, ASPECT))
  }, [data.bounds])

  // Build the country paths ONCE — 175 shapes, static for the app's lifetime.
  const countryPaths = useMemo(
    () => data.basemap.map((c) => ({ iso2: c.iso2, d: c.geom.map(polygonToPath).join('') })),
    [data.basemap]
  )

  const maxCount = useMemo(() => Math.max(1, ...data.cells.map((c) => c.count)), [data.cells])

  /** Convert a pointer event into world coordinates via the current viewBox. */
  function eventToWorld(e: React.PointerEvent | React.WheelEvent): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const relX = (e.clientX - rect.left) / rect.width
    const relY = (e.clientY - rect.top) / rect.height
    return { x: viewBox.x + relX * viewBox.w, y: viewBox.y + relY * viewBox.h }
  }

  function onWheel(e: React.WheelEvent): void {
    const cursor = eventToWorld(e)
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
    setViewBox((vb) => {
      const next = zoomAt(vb, cursor, factor)
      return next.w < MIN_ZOOM_SPAN ? vb : next
    })
  }

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

  function onPinHover(cell: LocationMapCell): void {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const p = project(cell.lng, cell.lat)
    setHover({
      cell,
      cx: ((p.x - viewBox.x) / viewBox.w) * rect.width,
      cy: ((p.y - viewBox.y) / viewBox.h) * rect.height
    })
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
        onWheel={onWheel}
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
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-md"
          style={{
            left: Math.min(Math.max(hover.cx + 10, 4), 9999),
            top: Math.max(hover.cy - 10, 4)
          }}
        >
          <span className="font-semibold">{hover.cell.count}</span>{' '}
          {hover.cell.count === 1 ? 'point' : 'points'}
          {hover.cell.firstSeen != null && (
            <span className="text-muted-foreground">
              {' · '}
              {fmtDate(hover.cell.firstSeen)}
              {hover.cell.lastSeen != null &&
                hover.cell.lastSeen !== hover.cell.firstSeen &&
                ` – ${fmtDate(hover.cell.lastSeen)}`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
