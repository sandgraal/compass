/**
 * Place profile aggregation — pure-function coverage: match keys (derived vs
 * manual, and the normalizeName-vs-normalizeMerchant divergence), extractor
 * reuse per source shape, visit stats (YTD trend, cadence regularity gate),
 * monthly buckets, multi-key indexing.
 */
import { describe, expect, it } from 'vitest'
import {
  type PlaceCandidateRow,
  type PlaceVisit,
  VISIT_SOURCES,
  computeVisitMonthly,
  computeVisitStats,
  extractPlaceRefs,
  indexVisitsByKey,
  placeMatchKey
} from './place-profile'

const NOW = new Date(2026, 6, 13, 12, 0, 0) // 2026-07-13 local

const ms = (iso: string): number => new Date(iso).getTime()

let nextId = 1
const row = (
  source: string,
  type: string,
  over: Partial<PlaceCandidateRow> = {}
): PlaceCandidateRow => ({
  id: nextId++,
  source,
  type,
  title: '',
  body: null,
  occurredAt: null,
  ...over
})

const visit = (occurredAt: number | null, over: Partial<PlaceVisit> = {}): PlaceVisit => ({
  recordId: nextId++,
  source: 'gcal',
  type: 'event',
  title: 'Event',
  occurredAt,
  ...over
})

describe('placeMatchKey', () => {
  it('takes the key verbatim from a derived external id', () => {
    expect(placeMatchKey('derived:place:blue bottle coffee', 'Blue Bottle Coffee')).toBe(
      'blue bottle coffee'
    )
    expect(placeMatchKey('derived:merchant:acme llc', 'whatever')).toBe('acme llc')
  })

  it('falls back to normalizeName for manual rows — keeping suffixes normalizeMerchant strips', () => {
    // normalizeMerchant would strip the "LLC"; place keys must not (they match
    // free-text calendar/ride location strings, not bank descriptions).
    expect(placeMatchKey('manual:some-uuid', 'Acme  Coworking LLC')).toBe('acme coworking llc')
  })
})

describe('VISIT_SOURCES', () => {
  it('covers exactly the four place-extractor record shapes', () => {
    expect(new Set(VISIT_SOURCES.map((v) => `${v.source}/${v.type}`))).toEqual(
      new Set(['gcal/event', 'uber/ride', 'lyft/ride', 'travel/trip'])
    )
  })
})

describe('extractPlaceRefs', () => {
  it('reads a calendar event location from the body', () => {
    expect(extractPlaceRefs(row('gcal', 'event', { body: '  Blue Bottle  Coffee ' }))).toEqual([
      'blue bottle coffee'
    ])
  })

  it('reads rideshare dropoff addresses from the body', () => {
    expect(extractPlaceRefs(row('uber', 'ride', { body: '123 Main St, Cartago' }))).toEqual([
      '123 main st, cartago'
    ])
    expect(extractPlaceRefs(row('lyft', 'ride', { body: '123 Main St' }))).toEqual(['123 main st'])
  })

  it('strips the "Trip to" prefix from travel records', () => {
    expect(extractPlaceRefs(row('travel', 'trip', { title: 'Trip to Costa Rica' }))).toEqual([
      'costa rica'
    ])
  })

  it('ignores non-place shapes and empty locations', () => {
    expect(extractPlaceRefs(row('gcal', 'event', { body: '   ' }))).toEqual([])
    expect(extractPlaceRefs(row('gcal', 'task', { body: 'Somewhere' }))).toEqual([])
    expect(extractPlaceRefs(row('finance', 'txn', { title: 'STARBUCKS' }))).toEqual([])
  })
})

describe('indexVisitsByKey', () => {
  it('groups matching rows per key, ascending by time, and skips untracked keys', () => {
    const rows = [
      row('gcal', 'event', { body: 'Gym', title: 'Workout', occurredAt: ms('2026-02-01') }),
      row('uber', 'ride', { body: 'Gym', title: 'Ride', occurredAt: ms('2026-01-15') }),
      row('gcal', 'event', { body: 'Dentist', title: 'Cleaning', occurredAt: ms('2026-03-01') }),
      row('gcal', 'event', { body: '', title: 'No location', occurredAt: ms('2026-03-02') })
    ]
    const map = indexVisitsByKey(rows, new Set(['gym']))
    expect([...map.keys()]).toEqual(['gym'])
    const gym = map.get('gym')
    expect(gym?.map((v) => v.title)).toEqual(['Ride', 'Workout'])
    expect(gym?.map((v) => v.source)).toEqual(['uber', 'gcal'])
  })

  it('returns an empty map when nothing matches', () => {
    expect(
      indexVisitsByKey([row('gcal', 'event', { body: 'Gym' })], new Set(['office'])).size
    ).toBe(0)
  })
})

describe('computeVisitStats', () => {
  it('counts visits and tracks first/last', () => {
    const stats = computeVisitStats(
      [visit(ms('2026-01-05')), visit(ms('2026-03-10')), visit(null)],
      NOW
    )
    expect(stats.visitCount).toBe(3)
    expect(stats.firstVisit).toBe(ms('2026-01-05'))
    expect(stats.lastVisit).toBe(ms('2026-03-10'))
  })

  it('compares YTD against the same span last year, not the full year', () => {
    const stats = computeVisitStats(
      [
        // Last year: 2 visits before July 13, 2 after (the after ones must not count).
        visit(new Date(2025, 1, 10).getTime()),
        visit(new Date(2025, 5, 1).getTime()),
        visit(new Date(2025, 9, 1).getTime()),
        visit(new Date(2025, 11, 20).getTime()),
        // This year: 3 visits to date.
        visit(new Date(2026, 0, 15).getTime()),
        visit(new Date(2026, 2, 15).getTime()),
        visit(new Date(2026, 6, 1).getTime())
      ],
      NOW
    )
    expect(stats.thisYearVisits).toBe(3)
    expect(stats.lastYearSameSpanVisits).toBe(2)
    expect(stats.trendPct).toBe(50)
  })

  it('returns a null trend when last year had no visits in span', () => {
    const stats = computeVisitStats([visit(new Date(2026, 1, 1).getTime())], NOW)
    expect(stats.trendPct).toBeNull()
  })

  it('detects a regular cadence and rejects irregular scatter', () => {
    const weekly = Array.from({ length: 8 }, (_, i) =>
      visit(new Date(2026, 0, 5 + i * 7).getTime())
    )
    expect(computeVisitStats(weekly, NOW).cadence).toBe('weekly')

    const scattered = [3, 11, 30, 34, 80, 84].map((d) => visit(new Date(2026, 0, d).getTime()))
    expect(computeVisitStats(scattered, NOW).cadence).toBeNull()
  })

  it('ranks sources by visit count', () => {
    const stats = computeVisitStats(
      [
        visit(ms('2026-01-01'), { source: 'gcal' }),
        visit(ms('2026-01-02'), { source: 'uber' }),
        visit(ms('2026-01-03'), { source: 'gcal' })
      ],
      NOW
    )
    expect(stats.bySource).toEqual([
      { source: 'gcal', count: 2 },
      { source: 'uber', count: 1 }
    ])
  })
})

describe('computeVisitMonthly', () => {
  it('buckets by local month ascending, absent months omitted', () => {
    const buckets = computeVisitMonthly([
      visit(new Date(2026, 2, 5).getTime()),
      visit(new Date(2026, 0, 10).getTime()),
      visit(new Date(2026, 0, 20).getTime()),
      visit(null)
    ])
    expect(buckets).toEqual([
      { month: '2026-01', visits: 2 },
      { month: '2026-03', visits: 1 }
    ])
  })
})
