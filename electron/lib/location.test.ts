/**
 * Tests for the location-history recognizers (Phase 10.8). Covers the OwnTracks
 * (.rec + .json) and GPX text recognizers, the Google Location History streaming
 * recognizer (E7 → degrees, both timestamp shapes, 30-min downsample), that each
 * claims its own file, and that a location file never falls through to the generic
 * catch-all.
 *
 * NOTE: fixtures mirror the documented/typical export shapes. If a real export
 * differs, update the fixture + recognizer together (same convention as the other
 * recognizer tests).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GOOGLE_LOCATION_STREAM,
  LOCATION_RECOGNIZER_IDS,
  type LocationPayload,
  OWNTRACKS_RECOGNIZER
} from './location'
import { type RecognizerFile, recognize, recognizeStream } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const payloadOf = (r: { payload?: unknown }): LocationPayload => r.payload as LocationPayload

// ─── OwnTracks ────────────────────────────────────────────────────────────────

const OWNTRACKS_REC = [
  '2025-03-10T12:00:00Z\t*\t{"_type":"location","lat":9.9281,"lon":-84.0907,"tst":1741608000,"acc":10}',
  '2025-03-11T12:00:00Z\t*\t{"_type":"location","lat":9.93,"lon":-84.08,"tst":1741694400}',
  '# a comment line with no json'
].join('\n')

const OWNTRACKS_JSON = JSON.stringify([
  { _type: 'location', lat: 40.7128, lon: -74.006, tst: 1741608000, acc: 5 },
  { _type: 'lwt', tst: 1741608000 } // non-location message → skipped
])

describe('OwnTracks recognizer', () => {
  it('parses a .rec log — tst seconds → epoch ms, skips non-json lines', () => {
    const f = file('owntracks.rec', OWNTRACKS_REC)
    expect(recognize(f)?.id).toBe('owntracks')
    const out = OWNTRACKS_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out[0].source).toBe('location')
    expect(out[0].type).toBe('location-point')
    expect(out[0].occurredAt).toBe(1741608000 * 1000)
    expect(payloadOf(out[0])).toMatchObject({
      lat: 9.9281,
      lng: -84.0907,
      acc: 10,
      src: 'owntracks'
    })
  })

  it('parses a .json array export and ignores non-location messages', () => {
    const f = file('owntracks-export.json', OWNTRACKS_JSON)
    expect(recognize(f)?.id).toBe('owntracks')
    const out = OWNTRACKS_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(payloadOf(out[0])).toMatchObject({ lat: 40.7128, lng: -74.006, src: 'owntracks' })
  })

  it('gives distinct natural keys to same-timestamp points at different coords (no dedup collision)', () => {
    const rec = [
      '2025-03-10T12:00:00Z\t*\t{"_type":"location","lat":9.9,"lon":-84.0,"tst":1741608000}',
      '2025-03-10T12:00:00Z\t*\t{"_type":"location","lat":40.7,"lon":-74.0,"tst":1741608000}'
    ].join('\n')
    const out = OWNTRACKS_RECOGNIZER.parse(file('same-ts.rec', rec))
    expect(out).toHaveLength(2)
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey) // coords in the key prevent a UNIQUE-hash drop
  })
})

// ─── GPX ──────────────────────────────────────────────────────────────────────

const GPX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<gpx version="1.1" creator="test"><trk><trkseg>',
  '<trkpt lat="9.9281" lon="-84.0907"><ele>1200</ele><time>2025-03-10T12:00:00Z</time></trkpt>',
  '<trkpt lon="-3.7038" lat="40.4168"><time>2025-04-01T08:30:00Z</time></trkpt>',
  '<trkpt lat="1.0" lon="2.0"></trkpt>', // no <time> → skipped
  '</trkseg></trk></gpx>'
].join('\n')

describe('GPX recognizer', () => {
  it('parses <trkpt> points (either attribute order), skips timeless points', () => {
    const f = file('track.gpx', GPX)
    expect(recognize(f)?.id).toBe('gpx')
    const out = recognize(f) === null ? [] : (recognize(f)?.parse(f) ?? [])
    expect(out).toHaveLength(2)
    expect(out[0].occurredAt).toBe(Date.parse('2025-03-10T12:00:00Z'))
    expect(payloadOf(out[0])).toMatchObject({ lat: 9.9281, lng: -84.0907, src: 'gpx' })
    // lon-before-lat attribute order still resolves correctly
    expect(payloadOf(out[1])).toMatchObject({ lat: 40.4168, lng: -3.7038 })
  })
})

// ─── Google Location History (streaming) ──────────────────────────────────────

const GOOGLE_RECORDS = JSON.stringify(
  {
    locations: [
      {
        latitudeE7: 99281000,
        longitudeE7: -840907000,
        accuracy: 20,
        timestamp: '2025-03-10T12:00:00Z'
      },
      // +10 min → within the 30-min downsample window → dropped
      { latitudeE7: 99281000, longitudeE7: -840907000, timestampMs: '1741608600000' },
      // +40 min → kept
      { latitudeE7: 404168000, longitudeE7: -37038000, timestampMs: '1741610400000' }
    ]
  },
  null,
  2
)

describe('Google Location History streaming recognizer', () => {
  it('detects the E7 signature on the head sample', () => {
    const head = GOOGLE_RECORDS.slice(0, 4096)
    expect(recognizeStream({ name: 'Records.json', ext: 'json', head })?.id).toBe('google-location')
  })

  it('streams points, converts E7 → degrees, honors both timestamp shapes + downsamples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loc-'))
    const path = join(dir, 'Records.json')
    writeFileSync(path, GOOGLE_RECORDS)
    const out = await GOOGLE_LOCATION_STREAM.parseStream(path)
    expect(out).toHaveLength(2) // middle point dropped by the 30-min sampler
    expect(payloadOf(out[0])).toMatchObject({ lat: 9.9281, lng: -84.0907, src: 'google' })
    expect(out[0].occurredAt).toBe(Date.parse('2025-03-10T12:00:00Z'))
    expect(out[1].occurredAt).toBe(1741610400000) // timestampMs parsed as epoch ms
    expect(payloadOf(out[1])).toMatchObject({ lat: 40.4168, lng: -3.7038 })
  })
})

// ─── Registry contract ────────────────────────────────────────────────────────

describe('location recognizer registry', () => {
  it('exposes the four ids that records.ts diverts to location_points', () => {
    expect([...LOCATION_RECOGNIZER_IDS].sort()).toEqual([
      'amazon-location',
      'google-location',
      'gpx',
      'owntracks'
    ])
  })

  it('a plain dated JSON is NOT claimed as a location file', () => {
    const f = file('history.json', JSON.stringify([{ date: '2025-01-01', title: 'hi' }]))
    expect(recognize(f)?.id).not.toBe('owntracks')
  })
})
