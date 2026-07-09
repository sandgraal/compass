/**
 * Rollup grouping (Timeline 2.0, PR 4): same-day bursts of one (source, kind)
 * collapse into digests; small groups stay as individual rows; day boundaries
 * follow the LOCAL rendered day label (matching the list's headers).
 */

import { describe, expect, it } from 'vitest'
import { ROLLUP_THRESHOLD, groupRecordsForDisplay } from './timeline-rollups'

let nextId = 1
function rec(source: string, type: string, title: string, iso: string | null): TimelineRecord {
  return {
    id: nextId++,
    source,
    type,
    occurredAt: iso ? Date.parse(iso) : null,
    title,
    body: null,
    payload: null,
    provenance: null,
    ingestedAt: null
  }
}

describe('groupRecordsForDisplay', () => {
  it('collapses a same-day burst into one digest and keeps small groups as rows', () => {
    const burst = Array.from({ length: ROLLUP_THRESHOLD }, (_, i) =>
      rec('amazon-music', 'listen', `Track ${i}`, `2024-05-12T1${i}:00:00`)
    ).reverse() // newest-first, like the API returns
    const single = rec('netflix', 'watch', 'Oppenheimer', '2024-05-12T20:00:00')
    const groups = groupRecordsForDisplay([single, ...burst])

    expect(groups).toHaveLength(1)
    expect(groups[0].singles.map((r) => r.title)).toEqual(['Oppenheimer'])
    expect(groups[0].rollups).toHaveLength(1)
    expect(groups[0].rollups[0]).toMatchObject({ source: 'amazon-music', type: 'listen' })
    expect(groups[0].rollups[0].rows).toHaveLength(ROLLUP_THRESHOLD)
  })

  it('keeps groups below the threshold expanded', () => {
    const few = Array.from({ length: ROLLUP_THRESHOLD - 1 }, (_, i) =>
      rec('spotify', 'listen', `Song ${i}`, `2024-05-12T1${i}:00:00`)
    ).reverse()
    const groups = groupRecordsForDisplay(few)
    expect(groups[0].rollups).toHaveLength(0)
    expect(groups[0].singles).toHaveLength(ROLLUP_THRESHOLD - 1)
  })

  it('never rolls up across days and orders digests biggest-first', () => {
    const day1 = Array.from({ length: 8 }, (_, i) =>
      rec('browser', 'visit', `site ${i}`, `2024-05-12T0${i}:00:00`)
    )
    const day1Bigger = Array.from({ length: 10 }, (_, i) =>
      rec('amazon-music', 'listen', `track ${i}`, `2024-05-12T1${i % 10}:30:00`)
    )
    const day2 = Array.from({ length: 8 }, (_, i) =>
      rec('browser', 'visit', `other ${i}`, `2024-05-11T0${i}:00:00`)
    )
    const groups = groupRecordsForDisplay([...day1Bigger, ...day1, ...day2])
    expect(groups).toHaveLength(2)
    expect(groups[0].rollups.map((r) => r.rows.length)).toEqual([10, 8])
    expect(groups[1].rollups).toHaveLength(1)
  })

  it('buckets undated records under their own group', () => {
    const groups = groupRecordsForDisplay([
      rec('netflix', 'watch', 'Dated', '2024-05-12T20:00:00'),
      rec('netflix', 'watch', 'Undated', null)
    ])
    expect(groups.map((g) => g.day)).toContain('Undated')
  })
})
