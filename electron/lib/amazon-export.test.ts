/**
 * Amazon "Request My Data" full-export recognizers (Timeline 2.0, PR 2).
 * Row shapes mirror the REAL export's payloads (validated against the user's
 * archive): Prime Video watch events (whose `SecondsWatched` column the old
 * generic recognizer mis-picked as the date), Kindle reading sessions, Amazon
 * Music likes/library, Alexa utterances, and device geolocation.
 */

import { describe, expect, it } from 'vitest'
import {
  ALEXA_UTTERANCE_RECOGNIZER,
  AMAZON_LOCATION_RECOGNIZER,
  AMAZON_MUSIC_LIBRARY_RECOGNIZER,
  AMAZON_MUSIC_LIKES_RECOGNIZER,
  AMAZON_RETURNS_RECOGNIZER,
  AMAZON_REVIEWS_RECOGNIZER,
  AMAZON_SEARCH_RECOGNIZER,
  AMAZON_WISHLIST_RECOGNIZER,
  KINDLE_READING_RECOGNIZER,
  PRIME_VIDEO_RECOGNIZER,
  mapAlexaUtterance,
  mapAmazonGeolocation,
  mapAmazonMusicLike,
  mapAmazonMusicSave,
  mapAmazonReturn,
  mapAmazonReview,
  mapAmazonSearch,
  mapAmazonWishlist,
  mapKindleReadingSession,
  mapPrimeVideoWatch
} from './amazon-export'

function file(name: string, text: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return { name, ext, text }
}

describe('mapPrimeVideoWatch', () => {
  it('dates the watch from MostRecentWatchDate, never SecondsWatched', () => {
    const input = mapPrimeVideoWatch({
      TitleName: 'The Foretelling',
      TitleDescription: 'Edmund oversleeps…',
      SecondsWatched: '38', // the column the generic recognizer mis-read as year 2038
      LatestWatchProgress: 'Not Available',
      DeletedFromWatchHistory: 'no',
      MostRecentWatchDate: '2013-05-13T11:52:07Z',
      EntityType: 'TVEpisode'
    })
    expect(input?.source).toBe('prime-video')
    expect(input?.type).toBe('watch')
    expect(input?.title).toBe('The Foretelling')
    expect(input?.occurredAt).toBe(Date.parse('2013-05-13T11:52:07Z'))
    expect(input?.body).toBe('Episode') // 38 s < 1 min — no duration suffix
  })

  it('adds a minutes suffix for real watch sessions and skips untitled rows', () => {
    const input = mapPrimeVideoWatch({
      TitleName: 'Oppenheimer',
      SecondsWatched: '10800',
      MostRecentWatchDate: '2024-04-01T03:17:24Z',
      EntityType: 'Movie'
    })
    expect(input?.body).toBe('Movie · 180 min')
    expect(mapPrimeVideoWatch({ TitleName: '', MostRecentWatchDate: '2024-01-01' })).toBeNull()
  })
})

describe('mapKindleReadingSession', () => {
  it('maps a reading session with duration', () => {
    const input = mapKindleReadingSession({
      ASIN: 'B0BX7686JM',
      end_time: '2023-03-13T15:39:08.100Z',
      product_name: 'Snowflake SnowPro Core Certification Exam Guide',
      reading_marketplace: 'Amazon.com',
      start_time: '2023-03-13T15:00:59.900Z',
      total_reading_milliseconds: '2288100'
    })
    expect(input?.source).toBe('kindle')
    expect(input?.type).toBe('read')
    expect(input?.occurredAt).toBe(Date.parse('2023-03-13T15:00:59.900Z'))
    expect(input?.body).toBe('Read · 38 min')
  })

  it('omits the duration for zero-length sessions', () => {
    const input = mapKindleReadingSession({
      product_name: "Fool's Assassin",
      start_time: '2021-12-24T00:47:51.053Z',
      total_reading_milliseconds: '0'
    })
    expect(input?.body).toBeUndefined()
  })
})

describe('amazon music mappers', () => {
  it('maps a track thumbs-up', () => {
    const input = mapAmazonMusicLike({
      ASIN: 'B004LETIURI',
      'Device Type': 'A2TF17PFR55MTB',
      'Entity Type': 'TRACK',
      'Last Updated Date': '2018-04-11T00:18:22.528Z',
      'Product Name': 'No Hands (feat. Roscoe Dash & Wale) [Explicit]',
      Rating: 'POSITIVE'
    })
    expect(input?.source).toBe('amazon-music')
    expect(input?.type).toBe('like')
    expect(input?.title).toBe('No Hands (feat. Roscoe Dash & Wale) [Explicit]')
    expect(input?.body).toBe('Track')
    expect(input?.occurredAt).toBe(Date.parse('2018-04-11T00:18:22.528Z'))
  })

  it('titles library saves with the TRACK title, not the artist column', () => {
    const input = mapAmazonMusicSave({
      ASIN: 'B07TDDPZCW',
      'Album Artist Name': 'Lil Nas X',
      'Album Name': '7 [Explicit]',
      'Artist Name': 'Lil Nas X [feat. Billy Ray Cyrus]',
      'Creation Date': '2024-06-27T14:07:50.748Z',
      Title: 'Old Town Road (Remix)',
      'File Name': '01 - Old Town Road (Remix).mp3'
    })
    expect(input?.title).toBe('Old Town Road (Remix)')
    expect(input?.body).toBe('Lil Nas X [feat. Billy Ray Cyrus]')
    expect(input?.type).toBe('save')
    expect(input?.occurredAt).toBe(Date.parse('2024-06-27T14:07:50.748Z'))
  })
})

describe('mapAlexaUtterance', () => {
  it('maps an utterance and skips the "Data Not Available" sentinel rows', () => {
    const input = mapAlexaUtterance({
      'Utterance text': 'alexa stop',
      'Utterance Creation Date': '2026-04-21T16:12:36.937Z'
    })
    expect(input?.source).toBe('alexa')
    expect(input?.type).toBe('ask')
    expect(input?.title).toBe('alexa stop')
    expect(
      mapAlexaUtterance({
        'Utterance text': 'Data Not Available',
        'Utterance Creation Date': 'Data Not Available'
      })
    ).toBeNull()
  })
})

describe('mapAmazonGeolocation', () => {
  it('produces a location_points input (never a timeline record)', () => {
    const input = mapAmazonGeolocation({
      sourceOfLocation: 'DEVICE',
      longitudeInDegrees: '-84.087',
      coordinatesAccuracyInMeters: '17.5',
      latitudeInDegrees: '9.936',
      eventDate: '2023-06-08T00:30:36.252Z',
      deviceSerialNumber: 'G0911W0793360F4M'
    })
    expect(input?.source).toBe('location')
    expect(input?.type).toBe('location-point')
    expect(input?.payload).toEqual({ lat: 9.936, lng: -84.087, acc: 17.5, src: 'amazon-device' })
    expect(input?.occurredAt).toBe(Date.parse('2023-06-08T00:30:36.252Z'))
  })

  it('declines rows without coordinates or a date', () => {
    expect(mapAmazonGeolocation({ latitudeInDegrees: '', longitudeInDegrees: '' })).toBeNull()
    expect(
      mapAmazonGeolocation({
        latitudeInDegrees: '9.9',
        longitudeInDegrees: '-84.0',
        eventDate: 'Not Available'
      })
    ).toBeNull()
  })
})

describe('recognizers (fresh imports)', () => {
  it('detects + parses a Prime Video watch-event CSV', () => {
    const f = file(
      'PrimeVideo.WatchEvent.1.csv',
      'TitleName,TitleDescription,SecondsWatched,LatestWatchProgress,DeletedFromWatchHistory,MostRecentWatchDate,EntityType\n' +
        'Blink,"A drug gives people an edge.",39,Not Available,no,2018-08-31T16:39:20Z,TVEpisode\n'
    )
    expect(PRIME_VIDEO_RECOGNIZER.detect(f)).toBe(true)
    const out = PRIME_VIDEO_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0].occurredAt).toBe(Date.parse('2018-08-31T16:39:20Z'))
  })

  it('detects the other export families on their header signatures', () => {
    expect(
      KINDLE_READING_RECOGNIZER.detect(
        file(
          'Kindle.reading-insights-sessions_with_adjustments.csv',
          'ASIN,end_time,personal_document_id,product_name,reading_marketplace,start_time,total_reading_milliseconds\n'
        )
      )
    ).toBe(true)
    expect(
      AMAZON_MUSIC_LIKES_RECOGNIZER.detect(
        file(
          'Followed Artists and Accounts.csv',
          'ASIN,Device Type,Entity Type,Last Updated Date,Product Name,Rating\n'
        )
      )
    ).toBe(true)
    expect(
      AMAZON_MUSIC_LIBRARY_RECOGNIZER.detect(
        file('Saved Music.csv', 'ASIN,Album Artist Name,Album Name,Creation Date,Title\n')
      )
    ).toBe(true)
    expect(
      ALEXA_UTTERANCE_RECOGNIZER.detect(
        file('Intent-1-1.csv', 'Currently Playing Song,Utterance text,Utterance Creation Date\n')
      )
    ).toBe(true)
    expect(
      AMAZON_LOCATION_RECOGNIZER.detect(
        file(
          'Geolocation-1-1.csv',
          'sourceOfLocation,longitudeInDegrees,coordinatesAccuracyInMeters,latitudeInDegrees,eventDate,deviceSerialNumber\n'
        )
      )
    ).toBe(true)
    // …and none of them claim a Netflix-shaped CSV.
    const netflix = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    for (const r of [
      PRIME_VIDEO_RECOGNIZER,
      KINDLE_READING_RECOGNIZER,
      AMAZON_MUSIC_LIKES_RECOGNIZER,
      AMAZON_MUSIC_LIBRARY_RECOGNIZER,
      ALEXA_UTTERANCE_RECOGNIZER,
      AMAZON_LOCATION_RECOGNIZER
    ]) {
      expect(r.detect(netflix)).toBe(false)
    }
  })
})

// Best-guess families (UNVALIDATED against a real archive — headers may differ).
describe('mapAmazonReturn', () => {
  it('maps a return with reason + refund into a timeline record', () => {
    const r = mapAmazonReturn({
      ProductName: 'USB-C Cable',
      ReturnRequestDate: '2026-05-02',
      ReturnReason: 'Defective',
      RefundAmount: '$12.99',
      OrderID: '111-222'
    })
    expect(r).not.toBeNull()
    expect(r?.source).toBe('amazon')
    expect(r?.type).toBe('return')
    expect(r?.title).toBe('Returned: USB-C Cable')
    expect(r?.body).toBe('Defective · refunded $12.99')
    expect(r?.naturalKey).toBe('2026-05-02|111-222')
  })

  it('tolerates alternate header spellings and skips a titleless row', () => {
    const r = mapAmazonReturn({
      'Product Name': 'Book',
      'Return Date': '2026-01-01',
      Reason: 'Wrong item'
    })
    expect(r?.title).toBe('Returned: Book')
    expect(mapAmazonReturn({ ReturnReason: 'x' })).toBeNull()
  })
})

describe('mapAmazonReview', () => {
  it('maps a review with rating + headline', () => {
    const r = mapAmazonReview({
      ProductName: 'Headphones',
      SubmissionDate: '2026-03-10',
      Rating: '5',
      ReviewHeadline: 'Great sound',
      ReviewText: 'Loved them.'
    })
    expect(r?.type).toBe('review')
    expect(r?.title).toBe('Reviewed: Headphones')
    expect(r?.body).toBe('5★ · Great sound')
  })
})

describe('mapAmazonWishlist', () => {
  it('maps a wishlist item with its list name', () => {
    const r = mapAmazonWishlist({ ItemName: 'Tent', ListName: 'Camping', DateAdded: '2026-04-01' })
    expect(r?.type).toBe('wishlist')
    expect(r?.title).toBe('Wishlisted: Tent')
    expect(r?.body).toBe('List: Camping')
  })
})

describe('mapAmazonSearch', () => {
  it('maps a search query with department', () => {
    const r = mapAmazonSearch({
      'Search Query': 'running shoes',
      'First Search Time': '2026-06-01T10:00:00Z',
      Department: 'Shoes'
    })
    expect(r?.type).toBe('search')
    expect(r?.title).toBe('Searched "running shoes"')
    expect(r?.body).toBe('Shoes')
    expect(r?.occurredAt).toBe(Date.parse('2026-06-01T10:00:00Z'))
  })
})

describe('additional-family recognizers detect on distinctive headers only', () => {
  it('claims their own shapes and not a Netflix CSV', () => {
    expect(
      AMAZON_RETURNS_RECOGNIZER.detect(file('Returns.csv', 'OrderID,ReturnReason,RefundAmount\n'))
    ).toBe(true)
    expect(
      AMAZON_REVIEWS_RECOGNIZER.detect(file('Reviews.csv', 'ProductName,Rating,ReviewText\n'))
    ).toBe(true)
    expect(
      AMAZON_WISHLIST_RECOGNIZER.detect(file('Wishlist.csv', 'ListName,ItemName,DateAdded\n'))
    ).toBe(true)
    expect(
      AMAZON_SEARCH_RECOGNIZER.detect(file('Search-Data.csv', 'Search Query,First Search Time\n'))
    ).toBe(true)
    const netflix = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    for (const r of [
      AMAZON_RETURNS_RECOGNIZER,
      AMAZON_REVIEWS_RECOGNIZER,
      AMAZON_WISHLIST_RECOGNIZER,
      AMAZON_SEARCH_RECOGNIZER
    ]) {
      expect(r.detect(netflix)).toBe(false)
    }
  })
})
