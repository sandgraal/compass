import { describe, expect, it } from 'vitest'
import { type MapCell, finalizeMapCells } from './location-clusters'

const cell = (
  lat: number,
  lng: number,
  count: number,
  firstSeen: number | null = null,
  lastSeen: number | null = null
): MapCell => ({ lat, lng, count, firstSeen, lastSeen })

describe('finalizeMapCells', () => {
  it('ranks cells by visit count and computes bounds over the kept cells', () => {
    const { cells, bounds, truncated } = finalizeMapCells([
      cell(40.71, -74.0, 1, 500, 500),
      cell(9.93, -84.08, 2, 100, 900)
    ])
    expect(cells.map((c) => c.count)).toEqual([2, 1]) // busiest first
    expect(truncated).toBe(false)
    expect(bounds).not.toBeNull()
    const [w, s, e, n] = bounds as [number, number, number, number]
    expect(w).toBeCloseTo(-84.08, 2)
    expect(s).toBeCloseTo(9.93, 2)
    expect(e).toBeCloseTo(-74.0, 2)
    expect(n).toBeCloseTo(40.71, 2)
  })

  it('caps at maxCells, keeps the busiest, and flags truncation', () => {
    const many: MapCell[] = []
    for (let i = 0; i < 5; i++) many.push(cell(10 + i, 10 + i, 1))
    many.push(cell(0, 0, 3))
    const { cells, truncated } = finalizeMapCells(many, { maxCells: 2 })
    expect(cells).toHaveLength(2)
    expect(cells[0].count).toBe(3) // the busy cell survived the cap
    expect(truncated).toBe(true)
  })

  it('does not flag truncation when the count exactly fills the cap', () => {
    const exact = [cell(1, 1, 2), cell(2, 2, 1)]
    expect(finalizeMapCells(exact, { maxCells: 2 }).truncated).toBe(false)
  })

  it('returns null bounds on empty input', () => {
    const r = finalizeMapCells([])
    expect(r.cells).toHaveLength(0)
    expect(r.bounds).toBeNull()
    expect(r.truncated).toBe(false)
  })
})
