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
  AMAZON_DIGITAL_ITEMS_RECOGNIZER,
  AMAZON_LOCATION_RECOGNIZER,
  AMAZON_MUSIC_LIBRARY_RECOGNIZER,
  AMAZON_MUSIC_LIKES_RECOGNIZER,
  AMAZON_RETURNS_RECOGNIZER,
  AMAZON_REVIEWS_RECOGNIZER,
  AMAZON_SEARCH_RECOGNIZER,
  AMAZON_WISHLIST_RECOGNIZER,
  KINDLE_READING_RECOGNIZER,
  PRIME_VIDEO_RECOGNIZER,
  isAmazonTelemetryProvenance,
  mapAlexaUtterance,
  mapAmazonDigitalItem,
  mapAmazonGeolocation,
  mapAmazonGiftCertificate,
  mapAmazonMusicLike,
  mapAmazonMusicSave,
  mapAmazonReturn,
  mapAmazonReview,
  mapAmazonRiderLocation,
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
      'Return Reason': 'Wrong item'
    })
    expect(r?.title).toBe('Returned: Book')
    expect(r?.body).toBe('Wrong item')
    // Distinctive column present but no title → still skipped.
    expect(mapAmazonReturn({ ReturnReason: 'x' })).toBeNull()
  })
})

describe('reclassification safety — distinctive-column guard', () => {
  // The reclassifier matches provenance FILENAMES (broad regexes), then runs the
  // mapper on a stored generic payload. Without a column guard, a generic row from
  // a file merely named "…review…" could be misclassified. Each mapper must return
  // null unless its DISTINCTIVE column is present in the payload.
  it('declines a generic-shaped payload lacking the distinctive column', () => {
    const generic = { Title: 'Some Thing', Date: '2026-01-01', Name: 'x', Query: 'shoes' }
    expect(mapAmazonReturn(generic)).toBeNull() // no ReturnReason
    expect(mapAmazonReview(generic)).toBeNull() // no ReviewText
    expect(mapAmazonWishlist(generic)).toBeNull() // no ListName
    expect(mapAmazonSearch(generic)).toBeNull() // 'Query' is not a distinctive search header
  })

  it('accepts the same payload once the distinctive column is added', () => {
    expect(mapAmazonReturn({ Title: 'T', ReturnReason: 'Defective' })).not.toBeNull()
    expect(mapAmazonReview({ Title: 'T', ReviewText: 'good' })).not.toBeNull()
    expect(mapAmazonWishlist({ Title: 'T', ListName: 'Camping' })).not.toBeNull()
    expect(mapAmazonSearch({ 'Search Query': 'shoes' })).not.toBeNull()
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

// V2 families — row shapes copied from the REAL export's stored payloads.

describe('mapAmazonRiderLocation', () => {
  const ROW = {
    'Event Time (UTC)': '2026-06-09 00:15:27.887',
    'GPS Time (UTC)': '2026-06-09 00:15:24.694',
    'Horizontal Accuracy': '39.78507189614252',
    Latitude: '26.07069',
    Longitude: '-80.14414',
    'Speed (GPS)': '-1.0',
    City: 'miami',
    'Device Model': 'iPhone11,2',
    'Analytics Event Type': 'tap'
  }

  it('maps a GPS fix in UTC (never local) with accuracy, keyed on the fix time', () => {
    const r = mapAmazonRiderLocation(ROW)
    expect(r?.source).toBe('location')
    expect(r?.type).toBe('location-point')
    // The column is UTC — must parse as such, not local time.
    expect(r?.occurredAt).toBe(Date.parse('2026-06-09T00:15:24.694Z'))
    expect(r?.payload).toEqual({
      lat: 26.07069,
      lng: -80.14414,
      acc: 39.78507189614252,
      src: 'amazon-rider'
    })
  })

  it('collapses repeated taps sharing one GPS fix onto one naturalKey', () => {
    const a = mapAmazonRiderLocation(ROW)
    const b = mapAmazonRiderLocation({ ...ROW, 'Event Time (UTC)': '2026-06-09 00:15:28.146' })
    expect(a?.naturalKey).toBe(b?.naturalKey)
  })

  it('rejects rows without coordinates, (0,0), or without the distinctive time columns', () => {
    expect(mapAmazonRiderLocation({ ...ROW, Latitude: '', Longitude: '' })).toBeNull()
    expect(mapAmazonRiderLocation({ ...ROW, Latitude: '0.0', Longitude: '0.0' })).toBeNull()
    expect(mapAmazonRiderLocation({ Latitude: '26.1', Longitude: '-80.1' })).toBeNull()
  })
})

describe('mapAmazonDigitalItem', () => {
  const ROW = {
    ASIN: 'B09W897871',
    ProductName: 'Amazon Music Unlimited',
    OrderId: 'D01-6241216-2422661',
    DigitalOrderItemId: 'RSMOBNVH3I8DQU27HKBJRFUV8IKKTK7EDS4EETU19HPK2IP728CG',
    BaseCurrencyCode: 'USD',
    FulfilledDate: '2025-09-25T00:44:00Z',
    OrderDate: '2025-09-25T00:44:00Z',
    OurPrice: '10.99',
    OurPriceCurrencyCode: 'USD',
    OurPriceTax: 'Not Applicable'
  }

  it('maps a digital purchase with product name and price', () => {
    const r = mapAmazonDigitalItem(ROW)
    expect(r?.source).toBe('amazon')
    expect(r?.type).toBe('order')
    expect(r?.title).toBe('Amazon Music Unlimited')
    expect(r?.body).toBe('Digital · 10.99 USD')
    expect(r?.occurredAt).toBe(Date.parse('2025-09-25T00:44:00Z'))
  })

  it("declines rows without a product name or without the distinctive item id ('Not Applicable' counts as blank)", () => {
    expect(mapAmazonDigitalItem({ ...ROW, ProductName: 'Not Applicable' })).toBeNull()
    expect(mapAmazonDigitalItem({ ...ROW, ProductName: '' })).toBeNull()
    const { DigitalOrderItemId: _omit, ...withoutId } = ROW
    expect(mapAmazonDigitalItem(withoutId)).toBeNull()
  })
})

describe('mapAmazonGiftCertificate', () => {
  const ROW = {
    serialNumber: '2554883066759615',
    transactionDate: '2026-03-09T20:46:37Z',
    transactionType: 'MarkShipmentCompletion',
    transactionAmount: '23.42',
    currencyCode: 'USD'
  }

  it('maps a gift-card ledger entry with a humanized transaction type', () => {
    const r = mapAmazonGiftCertificate(ROW)
    expect(r?.source).toBe('amazon')
    expect(r?.type).toBe('gift-card')
    expect(r?.title).toBe('Gift card · 23.42 USD')
    expect(r?.body).toBe('Mark Shipment Completion')
    expect(r?.occurredAt).toBe(Date.parse('2026-03-09T20:46:37Z'))
  })

  it('keeps same-serial transactions distinct via type+amount in the naturalKey', () => {
    const a = mapAmazonGiftCertificate(ROW)
    const b = mapAmazonGiftCertificate({ ...ROW, transactionType: 'Settlement' })
    expect(a?.naturalKey).not.toBe(b?.naturalKey)
    expect(mapAmazonGiftCertificate({ ...ROW, transactionAmount: '' })).toBeNull()
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

describe('AMAZON_DIGITAL_ITEMS_RECOGNIZER detection', () => {
  it('detects on the distinctive item id regardless of the product-name header spelling', () => {
    expect(
      AMAZON_DIGITAL_ITEMS_RECOGNIZER.detect(
        file('Digital Items.csv', 'ASIN,ProductName,OrderId,DigitalOrderItemId,OrderDate\n')
      )
    ).toBe(true)
    expect(
      AMAZON_DIGITAL_ITEMS_RECOGNIZER.detect(
        file('Digital Items.csv', 'ASIN,Product Name,OrderId,DigitalOrderItemId,OrderDate\n')
      )
    ).toBe(true)
    expect(
      AMAZON_DIGITAL_ITEMS_RECOGNIZER.detect(file('orders.csv', 'OrderId,ProductName,Date\n'))
    ).toBe(false)
  })
})

describe('isAmazonTelemetryProvenance (purge scoping)', () => {
  it('matches the telemetry families observed in the real export', () => {
    for (const p of [
      'DeviceState-1-1.csv',
      'DeviceEngagement.csv',
      'node_metadata_na_1.csv',
      'AppEngagement.csv',
      'apps-and-more.app-purchase-download-install.csv',
      'Appstore.FireTVClient.operational_metrics.csv',
      'Whispered-1-1.csv',
      'Retail.OutboundNotifications.notificationMetadata.1.csv',
      'Request All Your Data.Detail Page Glance View Impressions.csv',
      'Alexa and Echo Devices.Alexa_Device_Daily_Toggle_Acivity.csv',
      'rider_app_analytics-0.csv',
      'FireTv.Live.CustomerStationList.1.csv',
      'Kindle.Devices.ReadingSession_v0.csv',
      'Digital Orders.csv',
      'TotalUsagePerDay.csv',
      'Device_Artifact_Frequency_Metrics-1.csv',
      'D2DiodeErpService.json'
    ]) {
      expect(isAmazonTelemetryProvenance(p), p).toBe(true)
    }
  })

  it('never matches non-Amazon imports (the purge must not touch them)', () => {
    for (const p of [
      'MyBankExport.csv',
      'NetflixViewingHistory.csv',
      'History.json',
      'export.csv',
      'Want to go.csv',
      null
    ]) {
      expect(isAmazonTelemetryProvenance(p), String(p)).toBe(false)
    }
  })
})
