import { describe, expect, it } from 'vitest'
import {
  WORLD,
  clampViewBox,
  fitBounds,
  panBy,
  polygonToPath,
  project,
  unproject,
  zoomAt
} from './geo-project'

describe('project / unproject', () => {
  it('round-trips coordinates through the Mercator transform', () => {
    const p = project(-84.08, 9.93)
    expect(p.x).toBe(-84.08)
    // Mercator stretches |y| slightly beyond |lat| away from the equator.
    expect(p.y).toBeLessThan(-9.93)
    expect(p.y).toBeGreaterThan(-10.1)
    const back = unproject(p.x, p.y)
    expect(back.lng).toBeCloseTo(-84.08, 8)
    expect(back.lat).toBeCloseTo(9.93, 8)
  })

  it('is identity-ish at the equator and clamped at the poles', () => {
    expect(project(0, 0)).toEqual({ x: 0, y: -0 })
    // The square cutoff: ±85.05113° projects to ±180 world units.
    expect(project(0, 85.05113).y).toBeCloseTo(-180, 2)
    expect(project(0, -85.05113).y).toBeCloseTo(180, 2)
    // Poles clamp to the cutoff instead of diverging to infinity.
    expect(project(0, 90).y).toBeCloseTo(-180, 2)
    expect(Number.isFinite(project(0, -90).y)).toBe(true)
  })

  it('preserves latitude ordering (north above south)', () => {
    expect(project(0, 60).y).toBeLessThan(project(0, 10).y)
    expect(project(0, 10).y).toBeLessThan(project(0, -10).y)
  })
})

describe('fitBounds', () => {
  it('returns the whole world for null bounds', () => {
    expect(fitBounds(null, 2)).toEqual(WORLD)
  })

  it('centers on the projected data with padding and matches the aspect ratio', () => {
    const vb = fitBounds([-85, 9, -83, 11], 2) // 2°×2° box in Costa Rica
    const cx = vb.x + vb.w / 2
    const cy = vb.y + vb.h / 2
    expect(cx).toBeCloseTo(-84, 5)
    // Vertical center = midpoint of the PROJECTED lat range, not -(9+11)/2.
    const expectedCy = (project(0, 11).y + project(0, 9).y) / 2
    expect(cy).toBeCloseTo(expectedCy, 5)
    expect(vb.w / vb.h).toBeCloseTo(2, 5)
    expect(vb.w).toBeGreaterThan(2) // padded beyond the raw span
  })

  it('centers high-latitude data correctly (the equirectangular failure mode)', () => {
    const vb = fitBounds([9, 55, 11, 65], 1) // southern Scandinavia
    const cy = vb.y + vb.h / 2
    const expectedCy = (project(0, 65).y + project(0, 55).y) / 2
    expect(cy).toBeCloseTo(expectedCy, 5)
    // The projected span is wider than the raw 10° of latitude.
    expect(project(0, 55).y - project(0, 65).y).toBeGreaterThan(10)
  })

  it('enforces a minimum span so a single cluster does not zoom microscopic', () => {
    const vb = fitBounds([-84.081, 9.931, -84.08, 9.932], 1, { minSpan: 2 })
    expect(vb.w).toBeGreaterThanOrEqual(2)
    expect(vb.h).toBeGreaterThanOrEqual(2)
  })

  it('clamps to the world for spanning data', () => {
    const vb = fitBounds([-179, -80, 179, 80], 2)
    expect(vb.w).toBeLessThanOrEqual(WORLD.w)
    expect(vb.h).toBeLessThanOrEqual(WORLD.h)
    expect(vb.x).toBeGreaterThanOrEqual(WORLD.x)
    expect(vb.y).toBeGreaterThanOrEqual(WORLD.y)
  })
})

describe('zoomAt', () => {
  it('keeps the cursor point fixed while zooming in', () => {
    const vb = { x: -100, y: -20, w: 40, h: 20 }
    const cursor = { x: -84, y: -10 }
    const zoomed = zoomAt(vb, cursor, 0.5)
    // The cursor's relative position in the box must be unchanged.
    const relBefore = { x: (cursor.x - vb.x) / vb.w, y: (cursor.y - vb.y) / vb.h }
    const relAfter = {
      x: (cursor.x - zoomed.x) / zoomed.w,
      y: (cursor.y - zoomed.y) / zoomed.h
    }
    expect(relAfter.x).toBeCloseTo(relBefore.x, 5)
    expect(relAfter.y).toBeCloseTo(relBefore.y, 5)
    expect(zoomed.w).toBeCloseTo(20, 5)
  })

  it('cannot zoom out beyond the world', () => {
    const vb = { x: -180, y: -90, w: 300, h: 150 }
    const out = zoomAt(vb, { x: 0, y: 0 }, 4)
    expect(out.w).toBeLessThanOrEqual(WORLD.w)
    expect(out.h).toBeLessThanOrEqual(WORLD.h)
  })
})

describe('panBy / clampViewBox', () => {
  it('pans and clamps at the world edge', () => {
    const vb = { x: 100, y: 130, w: 60, h: 30 }
    const panned = panBy(vb, 100, 100)
    expect(panned.x).toBe(WORLD.x + WORLD.w - vb.w) // 120
    expect(panned.y).toBe(WORLD.y + WORLD.h - vb.h) // 150
    expect(clampViewBox({ x: -500, y: -500, w: 60, h: 30 })).toEqual({
      x: -180,
      y: -180,
      w: 60,
      h: 30
    })
  })
})

describe('polygonToPath', () => {
  it('builds a closed path per ring through the projection', () => {
    const d = polygonToPath([
      [
        [0, 0],
        [10, 0],
        [10, 10]
      ]
    ])
    const y10 = project(0, 10).y
    expect(d).toBe(`M0,0L10,0L10,${y10}Z`)
    // Multi-ring polygons emit one closed subpath each.
    expect(polygonToPath([[[0, 0]], [[1, 0]]])).toBe('M0,0ZM1,0Z')
  })
})
