/**
 * Reclassification planner (Timeline 2.0, PR 2). Pure: generic rows in, plan
 * out. Payload shapes mirror the real mis-imported Amazon export — including
 * the Prime Video rows whose stored occurred_at came from `SecondsWatched`.
 */

import { describe, expect, it } from 'vitest'
import { type GenericRowLite, planReclassify } from './records-reclassify'

function row(id: number, provenance: string, payload: Record<string, unknown>): GenericRowLite {
  return { id, provenance, payload: JSON.stringify(payload) }
}

describe('planReclassify', () => {
  it('re-derives Prime Video watches with the CORRECT date from payload', () => {
    const plan = planReclassify([
      row(7, 'PrimeVideo.WatchEvent.1.csv', {
        TitleName: 'Welcome to Republic City',
        SecondsWatched: '36', // the old import stored this as year 2036
        MostRecentWatchDate: '2017-06-18T13:42:42Z',
        EntityType: 'TVEpisode'
      })
    ])
    expect(plan.locations).toHaveLength(0)
    expect(plan.records).toHaveLength(1)
    expect(plan.records[0].deleteId).toBe(7)
    expect(plan.records[0].provenance).toBe('PrimeVideo.WatchEvent.1.csv')
    expect(plan.records[0].input.source).toBe('prime-video')
    expect(plan.records[0].input.occurredAt).toBe(Date.parse('2017-06-18T13:42:42Z'))
  })

  it('routes geolocation rows to the locations bucket', () => {
    const plan = planReclassify([
      row(9, 'Geolocation-1-1.csv', {
        latitudeInDegrees: '9.936',
        longitudeInDegrees: '-84.087',
        coordinatesAccuracyInMeters: '17.5',
        eventDate: '2023-06-08T00:30:36.252Z'
      })
    ])
    expect(plan.records).toHaveLength(0)
    expect(plan.locations).toHaveLength(1)
    expect(plan.locations[0].input.type).toBe('location-point')
  })

  it('leaves unmatched families, junk payloads, and declined rows untouched', () => {
    const plan = planReclassify([
      row(1, 'DeviceState-1-1.csv', { some: 'telemetry' }), // no family
      row(2, 'PrimeVideo.WatchEvent.1.csv', { TitleName: '' }), // mapper declines
      { id: 3, provenance: 'Saved Music.csv', payload: 'not json' },
      { id: 4, provenance: null, payload: '{}' },
      { id: 5, provenance: 'Intent-1-1.csv', payload: null }
    ])
    expect(plan.records).toHaveLength(0)
    expect(plan.locations).toHaveLength(0)
  })

  it('covers every announced family', () => {
    const plan = planReclassify([
      row(1, 'PrimeVideo.WatchEvent.1.csv', {
        TitleName: 'Blink',
        MostRecentWatchDate: '2018-08-31T16:39:20Z'
      }),
      row(2, 'Kindle.reading-insights-sessions_with_adjustments.csv', {
        product_name: 'A Book',
        start_time: '2023-03-13T15:38:59.900Z',
        total_reading_milliseconds: '120000'
      }),
      row(3, 'Followed Artists and Accounts.csv', {
        'Product Name': 'A Track',
        'Entity Type': 'TRACK',
        'Last Updated Date': '2018-04-11T00:18:22.528Z'
      }),
      row(4, 'Saved Music.csv', {
        Title: 'A Song',
        'Artist Name': 'An Artist',
        'Creation Date': '2024-06-27T14:07:50.748Z'
      }),
      row(5, 'Intent-1-1.csv', {
        'Utterance text': 'alexa stop',
        'Utterance Creation Date': '2026-04-21T16:12:36.937Z'
      }),
      row(6, 'Geolocation-1-1.csv', {
        latitudeInDegrees: '9.9',
        longitudeInDegrees: '-84.0',
        eventDate: '2023-06-08T00:30:36.252Z'
      })
    ])
    expect(plan.records.map((m) => m.input.source)).toEqual([
      'prime-video',
      'kindle',
      'amazon-music',
      'amazon-music',
      'alexa'
    ])
    expect(plan.locations).toHaveLength(1)
  })
})
