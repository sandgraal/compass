/**
 * On-this-day grouping (Phase 10.7 "Connect" cont). Pure logic — bucketing by
 * year, the "N years ago" labels, and the prior-years-only / undated filtering.
 */

import { describe, expect, it } from 'vitest'
import { groupOnThisDay, yearsAgoLabel } from './on-this-day'

const NOW = new Date('2026-06-27T12:00:00Z')
const UTC = (y: number, m: number, d: number): number => Date.UTC(y, m, d)

function rec(id: number, occurredAt: number | null, title = `r${id}`): TimelineRecord {
  return {
    id,
    source: 'netflix',
    type: 'watch',
    occurredAt,
    title,
    body: null,
    payload: null,
    provenance: null,
    ingestedAt: null
  }
}

describe('yearsAgoLabel', () => {
  it('singular vs plural', () => {
    expect(yearsAgoLabel(1)).toBe('1 year ago')
    expect(yearsAgoLabel(5)).toBe('5 years ago')
  })
})

describe('groupOnThisDay', () => {
  it('buckets by year, most-recent-past first, with years-ago', () => {
    const records = [
      rec(1, UTC(2022, 5, 27), 'a'),
      rec(2, UTC(2018, 5, 27), 'b'),
      rec(3, UTC(2022, 5, 27), 'c') // same year as #1
    ]
    const groups = groupOnThisDay(records, NOW)
    expect(groups.map((g) => g.year)).toEqual([2022, 2018]) // descending
    expect(groups[0]).toMatchObject({ year: 2022, yearsAgo: 4 })
    expect(groups[0].records.map((r) => r.title)).toEqual(['a', 'c']) // input order preserved
    expect(groups[1]).toMatchObject({ year: 2018, yearsAgo: 8 })
  })

  it('skips undated records and anything from the current year', () => {
    const records = [
      rec(1, UTC(2026, 5, 27), 'thisyear'), // current year → excluded
      rec(2, null, 'undated'), // undated → excluded
      rec(3, UTC(2020, 5, 27), 'keep')
    ]
    const groups = groupOnThisDay(records, NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ year: 2020, yearsAgo: 6 })
    expect(groups[0].records.map((r) => r.title)).toEqual(['keep'])
  })

  it('returns [] when there are no prior-year memories', () => {
    expect(groupOnThisDay([rec(1, null)], NOW)).toEqual([])
  })
})
