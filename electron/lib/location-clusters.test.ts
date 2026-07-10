import { describe, expect, it } from 'vitest'
import { clusterLocationPoints } from './location-clusters'

const pt = (lat: number, lng: number, occurredAt: number | null = null) => ({
  lat,
  lng,
  occurredAt
})

describe('clusterLocationPoints', () => {
  it('groups nearby points into one cell at the mean position with a time span', () => {
    const { cells, totalPoints } = clusterLocationPoints([
      pt(9.931, -84.081, 100),
      pt(9.932, -84.082, 900),
      pt(9.933, -84.079, 500)
    ])
    expect(totalPoints).toBe(3)
    expect(cells).toHaveLength(1)
    expect(cells[0].count).toBe(3)
    expect(cells[0].lat).toBeCloseTo(9.932, 3) // mean, not grid corner
    expect(cells[0].lng).toBeCloseTo(-84.0806, 3)
    expect(cells[0].firstSeen).toBe(100)
    expect(cells[0].lastSeen).toBe(900)
  })

  it('separates points in different cells and sorts by count', () => {
    const { cells } = clusterLocationPoints([
      pt(9.93, -84.08),
      pt(9.93, -84.08),
      pt(40.71, -74.0) // NYC — one visit
    ])
    expect(cells).toHaveLength(2)
    expect(cells[0].count).toBe(2) // busiest first
    expect(cells[1].count).toBe(1)
  })

  it('caps the cell count, keeps the busiest, and flags truncation', () => {
    const points: Array<{ lat: number; lng: number; occurredAt: number | null }> = []
    // 5 distinct cells with 1 point each + 1 cell with 3 points.
    for (let i = 0; i < 5; i++) points.push(pt(10 + i, 10 + i))
    points.push(pt(0, 0), pt(0, 0), pt(0, 0))
    const { cells, truncated, totalPoints } = clusterLocationPoints(points, { maxCells: 2 })
    expect(totalPoints).toBe(8)
    expect(cells).toHaveLength(2)
    expect(cells[0].count).toBe(3) // the busy cell survived the cap
    expect(truncated).toBe(true)
  })

  it('computes bounds over the KEPT cells only', () => {
    const { bounds } = clusterLocationPoints([pt(9.93, -84.08), pt(40.71, -74.0)])
    expect(bounds).not.toBeNull()
    const [w, s, e, n] = bounds as [number, number, number, number]
    expect(w).toBeCloseTo(-84.08, 2)
    expect(s).toBeCloseTo(9.93, 2)
    expect(e).toBeCloseTo(-74.0, 2)
    expect(n).toBeCloseTo(40.71, 2)
  })

  it('returns null bounds and zero totals on empty input', () => {
    const r = clusterLocationPoints([])
    expect(r.cells).toHaveLength(0)
    expect(r.bounds).toBeNull()
    expect(r.totalPoints).toBe(0)
    expect(r.truncated).toBe(false)
  })

  it('drops non-finite and out-of-range coordinates without crashing', () => {
    const r = clusterLocationPoints([
      pt(Number.NaN, 10),
      pt(95, 10), // lat out of range
      pt(10, 181), // lng out of range
      pt(10, 179.95) // near the antimeridian — fine
    ])
    expect(r.totalPoints).toBe(1)
    expect(r.cells).toHaveLength(1)
    expect(r.cells[0].lng).toBeCloseTo(179.95, 2)
  })
})
