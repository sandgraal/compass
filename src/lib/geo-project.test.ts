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
  it('round-trips coordinates (y is negated latitude)', () => {
    const p = project(-84.08, 9.93)
    expect(p).toEqual({ x: -84.08, y: -9.93 })
    expect(unproject(p.x, p.y)).toEqual({ lng: -84.08, lat: 9.93 })
  })
})

describe('fitBounds', () => {
  it('returns the whole world for null bounds', () => {
    expect(fitBounds(null, 2)).toEqual(WORLD)
  })

  it('centers on the data with padding and matches the aspect ratio', () => {
    const vb = fitBounds([-85, 9, -83, 11], 2) // 2°×2° box in Costa Rica
    const cx = vb.x + vb.w / 2
    const cy = vb.y + vb.h / 2
    expect(cx).toBeCloseTo(-84, 5)
    expect(cy).toBeCloseTo(-10, 5) // -lat of center
    expect(vb.w / vb.h).toBeCloseTo(2, 5)
    expect(vb.w).toBeGreaterThan(2) // padded beyond the raw span
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
    const vb = { x: 100, y: 40, w: 60, h: 30 }
    const panned = panBy(vb, 100, 100)
    expect(panned.x).toBe(WORLD.x + WORLD.w - vb.w) // 120
    expect(panned.y).toBe(WORLD.y + WORLD.h - vb.h) // 60
    expect(clampViewBox({ x: -500, y: -500, w: 60, h: 30 })).toEqual({
      x: -180,
      y: -90,
      w: 60,
      h: 30
    })
  })
})

describe('polygonToPath', () => {
  it('builds a closed path per ring with negated latitude', () => {
    const d = polygonToPath([
      [
        [0, 0],
        [10, 0],
        [10, 10]
      ],
      [
        [2, 2],
        [4, 2],
        [4, 4]
      ]
    ])
    expect(d).toBe('M0,0L10,0L10,-10ZM2,-2L4,-2L4,-4Z')
  })
})
