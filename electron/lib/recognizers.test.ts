/**
 * Tests for the Drop Zone recognizers (Phase 10.1). Pure — no DB, no Electron.
 */

import { describe, expect, it } from 'vitest'
import { RECOGNIZERS, hashRecord, parseWhen, recognize, recognizeStream } from './recognizers'

const netflixCsv = 'Title,Date\nThe Matrix,1/2/26\nInception,12/25/25\n'
const spotifyBasic = JSON.stringify([
  {
    endTime: '2026-01-03 14:33',
    artistName: 'Daft Punk',
    trackName: 'One More Time',
    msPlayed: 320000
  }
])
const spotifyExtended = JSON.stringify([
  {
    ts: '2026-01-03T14:33:00Z',
    master_metadata_track_name: 'Around the World',
    master_metadata_album_artist_name: 'Daft Punk',
    ms_played: 427000
  }
])
const genericCsv = 'when,event\n2026-02-01,Did a thing\n2026-02-02,Did another\n'
const genericJson = JSON.stringify([{ timestamp: '2026-03-01', name: 'JSON event' }])

function file(name: string, text: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return { name, ext, text }
}

describe('parseWhen', () => {
  it('parses ISO, datetime, and M/D/YY', () => {
    expect(parseWhen('2026-01-02')).toBe(new Date('2026-01-02').getTime())
    expect(parseWhen('2026-01-03T14:33:00Z')).toBe(Date.parse('2026-01-03T14:33:00Z'))
    expect(parseWhen('1/2/26')).toBe(new Date(2026, 0, 2).getTime())
  })
  it('returns null for junk / empty', () => {
    expect(parseWhen('')).toBeNull()
    expect(parseWhen(null)).toBeNull()
    expect(parseWhen('not a date')).toBeNull()
  })
})

describe('hashRecord', () => {
  it('is deterministic and discriminating', () => {
    const a = hashRecord('netflix', 'watch', 100, 'The Matrix|1/2/26')
    expect(a).toBe(hashRecord('netflix', 'watch', 100, 'The Matrix|1/2/26'))
    expect(a).not.toBe(hashRecord('netflix', 'watch', 100, 'Inception|1/2/26'))
    expect(a).toHaveLength(16)
  })
})

describe('netflix recognizer', () => {
  it('detects + parses viewing history', () => {
    const f = file('NetflixViewingHistory.csv', netflixCsv)
    expect(recognize(f)?.id).toBe('netflix')
    const out = RECOGNIZERS.find((r) => r.id === 'netflix')?.parse(f) ?? []
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ source: 'netflix', type: 'watch', title: 'The Matrix' })
    expect(out[0].occurredAt).toBe(new Date(2026, 0, 2).getTime())
  })
})

describe('spotify recognizer', () => {
  it('parses the basic export shape', () => {
    const f = file('StreamingHistory0.json', spotifyBasic)
    expect(recognize(f)?.id).toBe('spotify')
    const out = RECOGNIZERS.find((r) => r.id === 'spotify')?.parse(f) ?? []
    expect(out[0]).toMatchObject({
      source: 'spotify',
      type: 'listen',
      title: 'One More Time — Daft Punk',
      body: '5 min'
    })
  })
  it('parses the extended export shape', () => {
    const f = file('Streaming_History_Audio_2026.json', spotifyExtended)
    expect(recognize(f)?.id).toBe('spotify')
    const out = RECOGNIZERS.find((r) => r.id === 'spotify')?.parse(f) ?? []
    expect(out[0].title).toBe('Around the World — Daft Punk')
  })
})

describe('generic recognizer', () => {
  it('claims a dated CSV and maps a title column', () => {
    const f = file('export.csv', genericCsv)
    expect(recognize(f)?.id).toBe('generic')
    const out = RECOGNIZERS.find((r) => r.id === 'generic')?.parse(f) ?? []
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ source: 'generic', type: 'event', title: 'Did a thing' })
  })
  it('claims a dated JSON array', () => {
    const f = file('export.json', genericJson)
    expect(recognize(f)?.id).toBe('generic')
    expect(RECOGNIZERS.find((r) => r.id === 'generic')?.parse(f)[0].title).toBe('JSON event')
  })
  it('does not claim an undated file', () => {
    expect(recognize(file('x.csv', 'a,b\n1,2\n'))).toBeNull()
  })
})

describe('recognize dispatch', () => {
  it('returns null for an unrecognized payload', () => {
    expect(recognize(file('weird.json', '{"not":"an array"}'))).toBeNull()
    expect(recognize(file('notes.txt', 'hello world'))).toBeNull()
  })
})

describe('apple health (streaming) recognizer', () => {
  it('detects export.xml by name or a <HealthData> head', () => {
    expect(
      recognizeStream({ name: 'export.xml', ext: 'xml', head: '<?xml version="1.0"?>' })?.id
    ).toBe('apple-health')
    expect(
      recognizeStream({ name: 'foo.xml', ext: 'xml', head: '<HealthData locale="en_US">' })?.id
    ).toBe('apple-health')
    expect(recognizeStream({ name: 'other.xml', ext: 'xml', head: '<rss></rss>' })).toBeNull()
  })
})

describe('email (mbox streaming) recognizer', () => {
  it('detects .mbox by name or a From-separator head', () => {
    expect(recognizeStream({ name: 'All mail.mbox', ext: 'mbox', head: 'anything' })?.id).toBe(
      'email'
    )
    expect(
      recognizeStream({
        name: 'archive.txt',
        ext: 'txt',
        head: 'From 12345@xxx Mon Jan 02 08:00:00 +0000 2026\nDate: ...'
      })?.id
    ).toBe('email')
    expect(recognizeStream({ name: 'notes.txt', ext: 'txt', head: 'hello world' })).toBeNull()
  })
})

describe('youtube recognizer', () => {
  it('detects + parses watch-history.json', () => {
    const f = file(
      'watch-history.json',
      JSON.stringify([
        {
          header: 'YouTube',
          title: 'Watched Cool Video',
          titleUrl: 'https://youtu.be/abc',
          subtitles: [{ name: 'Cool Channel' }],
          time: '2026-01-04T10:00:00Z'
        }
      ])
    )
    expect(recognize(f)?.id).toBe('youtube')
    const out = RECOGNIZERS.find((r) => r.id === 'youtube')?.parse(f) ?? []
    expect(out[0]).toMatchObject({
      source: 'youtube',
      type: 'watch',
      title: 'Cool Video',
      body: 'Cool Channel'
    })
  })
})
