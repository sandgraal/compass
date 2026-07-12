/**
 * Netflix-refile planner + the recognizers for the families the over-greedy
 * netflix detect() used to steal. Row shapes are copied from the REAL stored
 * payloads (live-DB audit, 2026-07-11).
 */

import { describe, expect, it } from 'vitest'
import { mapPrimeVideoSession } from './amazon-export'
import {
  CSV_BOOKMARKS_RECOGNIZER,
  GOOGLE_SAVED_LIST_RECOGNIZER,
  NOTES_DETAILS_RECOGNIZER,
  mapBookmarkFact,
  mapNoteDetail,
  mapSavedPlaceFact,
  planNetflixRefile
} from './netflix-refile'

const PV_SESSION_ROW = {
  'Playback Start Datetime (UTC)': '2024-12-19T18:18:47Z',
  'Playback End Datetime (UTC)': '2024-12-19T18:18:50Z',
  Title: '"Red One"',
  'Seconds Viewed': '0.00000',
  'Device Manufacturer Name': '"Amazon"',
  'Country Code': '"CR"'
}

const SAVED_PLACE_ROW = {
  Title: 'Villa Bosque',
  Note: '',
  URL: 'https://www.google.com/maps/place/Villa+Bosque/data=!4m2!3m1!1s0x8fa0d7006a586a9f',
  Tags: '',
  Comment: ''
}

const BOOKMARK_ROW = {
  Title: 'Spicy Pork and Mustard Green Soup Recipe | Bon Appetit',
  URL: 'https://www.bonappetit.com/recipe/spicy-pork-mustard-green-soup',
  modifiedOn: 'Friday January 8,2021 2:06 PM GMT',
  favorite: 'no',
  deleted: 'no'
}

const NOTE_ROW = {
  Title: 'Objective: Introduce a new line or 4 hot sauces.',
  ' Created On': '11-02-2025 11:21:42',
  ' Modified On': '11-02-2025 12:05:09',
  ' Pinned': 'No',
  ' Deleted': 'No',
  ' Drawing/Handwriting': 'No'
}

const REAL_NETFLIX_ROW = { Title: 'The Pleasure of Your Company', Date: '8/31/08' }

describe('mapPrimeVideoSession', () => {
  it('unquotes the title, dates from playback start, and bodies sub-minute playback as Browsed', () => {
    const r = mapPrimeVideoSession(PV_SESSION_ROW)
    expect(r?.source).toBe('prime-video')
    expect(r?.type).toBe('watch')
    expect(r?.title).toBe('Red One')
    expect(r?.occurredAt).toBe(Date.parse('2024-12-19T18:18:47Z'))
    expect(r?.body).toBe('Browsed')
  })

  it('bodies real sessions with minutes and declines non-session rows', () => {
    const r = mapPrimeVideoSession({ ...PV_SESSION_ROW, 'Seconds Viewed': '5286.00000' })
    expect(r?.body).toBe('Watched · 88 min')
    expect(mapPrimeVideoSession(REAL_NETFLIX_ROW)).toBeNull() // no playback column
  })
})

describe('mapSavedPlaceFact', () => {
  it('labels by list filename and keys on the place URL', () => {
    const f = mapSavedPlaceFact(SAVED_PLACE_ROW, 'Want to go.csv', 3)
    expect(f).toEqual({
      source: 'google',
      category: 'google-saved',
      label: 'Want to go',
      value: 'Villa Bosque',
      position: 3,
      naturalKey: `Want to go|${SAVED_PLACE_ROW.URL}`
    })
  })

  it('appends the note when present and declines rows without the list shape', () => {
    const f = mapSavedPlaceFact({ ...SAVED_PLACE_ROW, Note: 'great tacos' }, 'Happy Hour.csv', 0)
    expect(f?.value).toBe('Villa Bosque — great tacos')
    expect(mapSavedPlaceFact(REAL_NETFLIX_ROW, 'NetflixViewingHistory.csv', 0)).toBeNull()
  })
})

describe('mapBookmarkFact', () => {
  it('keys on the URL like the Chrome-bookmarks recognizer', () => {
    const f = mapBookmarkFact(BOOKMARK_ROW, 0)
    expect(f?.label).toBe('Bookmark')
    expect(f?.naturalKey).toBe(`Bookmark|${BOOKMARK_ROW.URL}`)
    expect(mapBookmarkFact(REAL_NETFLIX_ROW, 0)).toBeNull()
  })
})

describe('mapNoteDetail', () => {
  it('maps a note title with a day-precision date from the leading-space column', () => {
    const r = mapNoteDetail(NOTE_ROW)
    expect(r?.source).toBe('notes')
    expect(r?.type).toBe('note')
    expect(r?.occurredAt).toBe(new Date(2025, 10, 2).getTime()) // 11-02-2025, local
    expect(mapNoteDetail(REAL_NETFLIX_ROW)).toBeNull()
  })
})

describe('planNetflixRefile', () => {
  it('routes each misfiled family and leaves real Netflix rows alone', () => {
    const rows = [
      { id: 1, provenance: 'NetflixViewingHistory.csv', payload: JSON.stringify(REAL_NETFLIX_ROW) },
      {
        id: 2,
        provenance: 'PrimeVideo.ViewingHistory.csv',
        payload: JSON.stringify(PV_SESSION_ROW)
      },
      { id: 3, provenance: 'Want to go.csv', payload: JSON.stringify(SAVED_PLACE_ROW) },
      { id: 4, provenance: 'Bookmarks_1.csv', payload: JSON.stringify(BOOKMARK_ROW) },
      { id: 5, provenance: 'Notes Details.csv', payload: JSON.stringify(NOTE_ROW) },
      { id: 6, provenance: null, payload: JSON.stringify(SAVED_PLACE_ROW) }, // no provenance → untouched
      { id: 7, provenance: 'Camping.csv', payload: 'not-json' } // unparseable → untouched
    ]
    const plan = planNetflixRefile(rows)
    expect(plan.records.map((m) => [m.deleteId, m.input.source])).toEqual([
      [2, 'prime-video'],
      [5, 'notes']
    ])
    expect(plan.facts.map((m) => [m.deleteId, m.fact.label])).toEqual([
      [3, 'Want to go'],
      [4, 'Bookmark']
    ])
  })
})

describe('fresh-import recognizers', () => {
  function file(name: string, text: string) {
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    return { name, ext, text }
  }

  it('claim their own shapes but never the real Netflix CSV', () => {
    const netflixCsv = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    const savedList = file('Want to go.csv', 'Title,Note,URL,Tags,Comment\nVilla Bosque,,,,\n')
    const bookmarks = file(
      'Bookmarks_1.csv',
      'Title,URL,modifiedOn,favorite,deleted\na,b,c,no,no\n'
    )
    const notes = file(
      'Notes Details.csv',
      'Title, Created On, Modified On, Pinned, Deleted, Drawing/Handwriting\nA,11-02-2025 11:21:42,,,No,No\n'
    )
    expect(GOOGLE_SAVED_LIST_RECOGNIZER.detect(savedList)).toBe(true)
    expect(CSV_BOOKMARKS_RECOGNIZER.detect(bookmarks)).toBe(true)
    expect(NOTES_DETAILS_RECOGNIZER.detect(notes)).toBe(true)
    for (const rec of [
      GOOGLE_SAVED_LIST_RECOGNIZER,
      CSV_BOOKMARKS_RECOGNIZER,
      NOTES_DETAILS_RECOGNIZER
    ]) {
      expect(rec.detect(netflixCsv)).toBe(false)
    }
  })

  it('parses saved-list facts labeled by the filename', () => {
    const facts = GOOGLE_SAVED_LIST_RECOGNIZER.parse(
      file(
        'Madrid Trip.csv',
        'Title,Note,URL,Tags,Comment\nPrado,,https://www.google.com/maps/place/Prado,,\n'
      )
    )
    expect(facts).toHaveLength(1)
    expect(facts[0].label).toBe('Madrid Trip')
    expect(facts[0].value).toBe('Prado')
  })
})
