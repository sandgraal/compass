/**
 * Amazon "Request My Data" full-export recognizers (Timeline 2.0, PR 2).
 *
 * The full Amazon archive is ~200 CSVs; before these recognizers existed it fell
 * through to the generic dated-CSV catch-all, which mis-picked date columns
 * (`SecondsWatched` matched /watched/) and buried 170k rows under source
 * 'generic'. These recognizers claim the HIGH-SIGNAL families, validated
 * against the real export's payloads:
 *
 *  - `PrimeVideo.WatchEvent.*.csv`  → prime-video / watch
 *  - `Kindle.reading-insights-sessions_with_adjustments.csv` → kindle / read
 *  - `Followed Artists and Accounts.csv` (track thumbs-ups) → amazon-music / like
 *  - `Saved Music.csv` (library adds) → amazon-music / save
 *  - `Intent-1-1.csv` (Alexa utterances) → alexa / ask
 *  - `Geolocation-1-1.csv` → location_points (NEVER the records spine)
 *  - `rider_app_analytics-*.csv` (shopping-app GPS fixes) → location_points
 *  - `Digital Items.csv` (digital purchases w/ product names) → amazon / order
 *  - `Retail.GiftCertificates.Transaction.csv` → amazon / gift-card
 *
 * Each family exposes its row mapper via `AMAZON_REFILE_FAMILIES` so the
 * one-shot reclassifier (`records-reclassify.ts`) can re-derive already-imported
 * generic rows from their stored payloads — same mapper, one source of truth.
 * Everything else in the archive (device telemetry, impressions, notification
 * metadata) deliberately stays generic; source-tiers collapses it as firehose.
 *
 * Deliberately NOT claimed:
 *  - `Kindle.Devices.ReadingSession_v0.csv` — the same sessions already reach
 *    the spine via `Kindle.reading-insights-sessions_with_adjustments.csv`
 *    (the adjusted view, WITH book titles); claiming the raw device log would
 *    double-count every read.
 *  - `Digital Orders.csv` — carries order ids/addresses but no product name;
 *    `Digital Items.csv` covers the same orders with real titles and prices.
 */

import { parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

/** Amazon CSVs write 'Not Available' / 'Data Not Available' / 'Not Applicable' instead of blanks. */
function field(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (v == null) return ''
  const s = String(v).trim()
  return /^(data )?not (available|applicable)$/i.test(s) ? '' : s
}

/** First non-empty value across candidate column names (header naming varies by export vintage). */
function firstField(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = field(row, k)
    if (v) return v
  }
  return ''
}

/**
 * Does the payload carry one of these DISTINCTIVE columns? The fresh-import
 * `detect()` gate checks the CSV header, but the reclassifier (records-reclassify.ts)
 * only matches the provenance FILENAME and then runs the mapper on a stored
 * generic-row payload — so without this guard a generic row from any file whose
 * name merely contains "review"/"return"/… could be misclassified. Requiring the
 * distinctive column here makes reclassification exactly as safe as fresh import.
 */
function hasKey(row: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => k in row)
}

function minutesBody(label: string, ms: number): string | undefined {
  const mins = Math.floor(ms / 60_000)
  return mins >= 1 ? `${label} · ${mins} min` : label || undefined
}

// ── Row mappers (shared by fresh imports and the generic-row reclassifier) ────

export function mapPrimeVideoWatch(row: Record<string, unknown>): RecordInput | null {
  const title = field(row, 'TitleName')
  if (!title) return null
  const watchDate = field(row, 'MostRecentWatchDate')
  const entity = field(row, 'EntityType') === 'TVEpisode' ? 'Episode' : field(row, 'EntityType')
  const seconds = Number(field(row, 'SecondsWatched'))
  const body =
    Number.isFinite(seconds) && seconds > 0
      ? minutesBody(entity, seconds * 1000)
      : entity || undefined
  return {
    source: 'prime-video',
    type: 'watch',
    occurredAt: parseWhen(watchDate),
    title,
    body,
    payload: row,
    naturalKey: `${watchDate}|${title}`
  }
}

export function mapKindleReadingSession(row: Record<string, unknown>): RecordInput | null {
  const title = field(row, 'product_name')
  if (!title) return null
  const start = field(row, 'start_time')
  const ms = Number(field(row, 'total_reading_milliseconds'))
  return {
    source: 'kindle',
    type: 'read',
    occurredAt: parseWhen(start),
    title,
    body: Number.isFinite(ms) && ms > 0 ? minutesBody('Read', ms) : undefined,
    payload: row,
    naturalKey: `${start}|${field(row, 'ASIN') || title}`
  }
}

export function mapAmazonMusicLike(row: Record<string, unknown>): RecordInput | null {
  const title = field(row, 'Product Name')
  if (!title) return null
  const when = field(row, 'Last Updated Date')
  const entity = field(row, 'Entity Type')
  return {
    source: 'amazon-music',
    type: 'like',
    occurredAt: parseWhen(when),
    title,
    body: entity ? entity.charAt(0) + entity.slice(1).toLowerCase() : undefined,
    payload: row,
    naturalKey: `${when}|${field(row, 'ASIN') || title}`
  }
}

export function mapAmazonMusicSave(row: Record<string, unknown>): RecordInput | null {
  // The generic import titled these rows with the ARTIST column; the real track
  // title lives in 'Title' (fallback: file name / album for odd rows).
  const title =
    field(row, 'Title') ||
    field(row, 'File Name').replace(/\.[a-z0-9]+$/i, '') ||
    field(row, 'Album Name')
  if (!title) return null
  const when = field(row, 'Creation Date')
  return {
    source: 'amazon-music',
    type: 'save',
    occurredAt: parseWhen(when),
    title,
    body: field(row, 'Artist Name') || undefined,
    payload: row,
    naturalKey: `${field(row, 'ASIN') || when}|${title}`
  }
}

export function mapAlexaUtterance(row: Record<string, unknown>): RecordInput | null {
  const text = field(row, 'Utterance text')
  if (!text) return null
  const when = field(row, 'Utterance Creation Date')
  return {
    source: 'alexa',
    type: 'ask',
    occurredAt: parseWhen(when),
    title: text,
    payload: row,
    naturalKey: `${when}|${text}`
  }
}

// ── Additional archive families (returns / reviews / wishlists / searches) ────
// CAVEAT: unlike the mappers above (validated against a real export), these four
// are written to the DOCUMENTED / best-guess column names and are UNVALIDATED
// against a real Amazon archive. `firstField` tries several header spellings to
// improve the odds; if none match a given export the recognizer simply stays
// inert (rows fall through to generic — no misclassification). Confirm the
// headers against a real archive before claiming coverage.
//
// Each mapper first requires its DISTINCTIVE column via `hasKey` — the same
// column the fresh-import recognizer detects on — so the reclassifier (which
// only matches provenance FILENAMES) can't misclassify unrelated generic rows.

export function mapAmazonReturn(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['ReturnReason', 'Return Reason'])) return null
  const title = firstField(row, ['ProductName', 'Product Name', 'Title', 'Item Name'])
  if (!title) return null
  const when = firstField(row, [
    'ReturnRequestDate',
    'ReturnDate',
    'Return Date',
    'DateOfReturn',
    'OrderDate'
  ])
  const reason = firstField(row, ['ReturnReason', 'Return Reason', 'Reason'])
  const refund = firstField(row, ['RefundAmount', 'Refund Amount', 'AmountRefunded'])
  const orderId = firstField(row, ['OrderID', 'Order ID', 'OrderId'])
  const bodyBits = [reason, refund ? `refunded ${refund}` : ''].filter(Boolean)
  return {
    source: 'amazon',
    type: 'return',
    occurredAt: parseWhen(when),
    title: `Returned: ${title}`,
    body: bodyBits.length > 0 ? bodyBits.join(' · ') : undefined,
    payload: row,
    naturalKey: `${when}|${orderId || title}`
  }
}

export function mapAmazonReview(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['ReviewText', 'Review Text'])) return null
  const product = firstField(row, ['ProductName', 'Product Name', 'Product Title', 'Title'])
  if (!product) return null
  const when = firstField(row, [
    'SubmissionDate',
    'Submission Date',
    'ReviewDate',
    'Date',
    'Last Modified Date'
  ])
  const rating = firstField(row, ['Rating', 'StarRating', 'Star Rating', 'Overall Rating'])
  const headline = firstField(row, ['ReviewHeadline', 'Headline', 'ReviewTitle', 'Review Title'])
  const text = firstField(row, ['ReviewText', 'Review Text', 'Body', 'Content', 'Review'])
  const bodyBits = [rating ? `${rating}★` : '', (headline || text).slice(0, 160)].filter(Boolean)
  return {
    source: 'amazon',
    type: 'review',
    occurredAt: parseWhen(when),
    title: `Reviewed: ${product}`,
    body: bodyBits.length > 0 ? bodyBits.join(' · ') : undefined,
    payload: row,
    naturalKey: `${when}|${product}`
  }
}

export function mapAmazonWishlist(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['ListName', 'List Name', 'Wishlist Name', 'WishlistName'])) return null
  const title = firstField(row, [
    'ItemName',
    'Item Name',
    'ProductName',
    'Product Name',
    'Title',
    'Name'
  ])
  if (!title) return null
  const when = firstField(row, ['DateAdded', 'Date Added', 'AddedDate', 'CreatedDate', 'Date'])
  const list = firstField(row, ['ListName', 'List Name', 'Wishlist Name', 'WishlistName'])
  return {
    source: 'amazon',
    type: 'wishlist',
    occurredAt: parseWhen(when),
    title: `Wishlisted: ${title}`,
    body: list ? `List: ${list}` : undefined,
    payload: row,
    naturalKey: `${when}|${list || 'list'}|${title}`
  }
}

export function mapAmazonSearch(row: Record<string, unknown>): RecordInput | null {
  // 'Keyword'/'Query' are too generic to be distinctive — require a search-specific header.
  if (!hasKey(row, ['Search Query', 'SearchQuery', 'First Search Query'])) return null
  const query = firstField(row, [
    'Search Query',
    'SearchQuery',
    'Keyword',
    'Query',
    'First Search Query'
  ])
  if (!query) return null
  const when = firstField(row, [
    'First Search Time',
    'Search Time',
    'SearchTime',
    'Date',
    'Timestamp'
  ])
  const dept = firstField(row, ['Department', 'Site Variant', 'Category', 'Marketplace'])
  return {
    source: 'amazon',
    type: 'search',
    occurredAt: parseWhen(when),
    title: `Searched "${query}"`,
    body: dept || undefined,
    payload: row,
    naturalKey: `${when}|${query}`
  }
}

/**
 * Amazon device geolocation → a `location_points` input (source 'location',
 * LocationPayload shape — mirrors `locationPoint()` in location.ts). These rows
 * must NEVER sit on the records spine: raw coordinates are the most sensitive
 * stream in the app and timeline search has no per-source denylist.
 */
export function mapAmazonGeolocation(row: Record<string, unknown>): RecordInput | null {
  const lat = Number(field(row, 'latitudeInDegrees'))
  const lng = Number(field(row, 'longitudeInDegrees'))
  const when = parseWhen(field(row, 'eventDate'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || when == null) return null
  const acc = Number(field(row, 'coordinatesAccuracyInMeters'))
  const payload: { lat: number; lng: number; acc?: number; src: string } = {
    lat,
    lng,
    src: 'amazon-device'
  }
  if (Number.isFinite(acc)) payload.acc = acc
  return {
    source: 'location',
    type: 'location-point',
    occurredAt: when,
    title: `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    payload,
    naturalKey: `amazon-device|${when}|${lat.toFixed(5)}|${lng.toFixed(5)}`
  }
}

/**
 * Shopping-app analytics GPS fixes (`rider_app_analytics-*.csv`). Every UI tap
 * logs a row that repeats the device's latest GPS fix, so thousands of rows
 * collapse to a few hundred distinct fixes — the naturalKey (fix time + coords)
 * does that collapsing. Same LocationPayload shape as `mapAmazonGeolocation`;
 * routed to `location_points`, never the records spine.
 */
export function mapAmazonRiderLocation(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['GPS Time (UTC)', 'Event Time (UTC)'])) return null
  const lat = Number(field(row, 'Latitude'))
  const lng = Number(field(row, 'Longitude'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null
  // Timestamps are 'YYYY-MM-DD HH:mm:ss.SSS' in UTC (the column says so) —
  // rewrite to ISO so Date.parse doesn't read them as local time. Prefer the
  // GPS fix time over the tap's event time.
  const rawWhen = firstField(row, ['GPS Time (UTC)', 'Event Time (UTC)'])
  const when = parseWhen(rawWhen ? `${rawWhen.replace(' ', 'T')}Z` : '')
  if (when == null) return null
  const acc = Number(field(row, 'Horizontal Accuracy'))
  const payload: { lat: number; lng: number; acc?: number; src: string } = {
    lat,
    lng,
    src: 'amazon-rider'
  }
  if (Number.isFinite(acc)) payload.acc = acc
  return {
    source: 'location',
    type: 'location-point',
    occurredAt: when,
    title: `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    payload,
    naturalKey: `amazon-rider|${when}|${lat.toFixed(5)}|${lng.toFixed(5)}`
  }
}

/**
 * Digital purchases (`Digital Items.csv`) — one row per purchased item with a
 * real product name and price. The sibling `Digital Orders.csv` is deliberately
 * unclaimed (order ids without product names).
 */
export function mapAmazonDigitalItem(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['DigitalOrderItemId'])) return null
  const title = firstField(row, ['ProductName', 'Product Name'])
  if (!title) return null
  const when = firstField(row, ['OrderDate', 'FulfilledDate'])
  const price = field(row, 'OurPrice')
  const currency = field(row, 'OurPriceCurrencyCode')
  return {
    source: 'amazon',
    type: 'order',
    occurredAt: parseWhen(when),
    title,
    body: price ? `Digital · ${price}${currency ? ` ${currency}` : ''}` : 'Digital',
    payload: row,
    naturalKey: `${when}|${field(row, 'OrderId') || 'order'}|${field(row, 'ASIN') || title}`
  }
}

/** Gift-card ledger (`Retail.GiftCertificates.Transaction.csv`). */
export function mapAmazonGiftCertificate(row: Record<string, unknown>): RecordInput | null {
  if (!hasKey(row, ['serialNumber'])) return null
  const amount = field(row, 'transactionAmount')
  if (!amount) return null
  const when = field(row, 'transactionDate')
  const currency = field(row, 'currencyCode')
  const txType = field(row, 'transactionType')
  return {
    source: 'amazon',
    type: 'gift-card',
    occurredAt: parseWhen(when),
    title: `Gift card · ${amount}${currency ? ` ${currency}` : ''}`,
    body: txType ? txType.replace(/([a-z])([A-Z])/g, '$1 $2') : undefined,
    payload: row,
    naturalKey: `${when}|${field(row, 'serialNumber')}|${txType}|${amount}`
  }
}

// ── Recognizers for FRESH imports of the same files ───────────────────────────

function csvHeader(f: { ext: string; text: string }): string {
  if (f.ext !== 'csv') return ''
  const nl = f.text.indexOf('\n')
  return nl === -1 ? f.text : f.text.slice(0, nl)
}

function csvRecognizer(
  id: string,
  label: string,
  headerCols: string[],
  map: (row: Record<string, unknown>) => RecordInput | null
): Recognizer {
  return {
    id,
    label,
    detect: (f) => {
      const header = csvHeader(f)
      return header !== '' && headerCols.every((c) => header.includes(c))
    },
    parse: (f) => {
      const out: RecordInput[] = []
      for (const row of parseCSV(f.text)) {
        const input = map(row)
        if (input) out.push(input)
      }
      return out
    }
  }
}

export const PRIME_VIDEO_RECOGNIZER = csvRecognizer(
  'prime-video',
  'Prime Video watch history',
  ['TitleName', 'MostRecentWatchDate'],
  mapPrimeVideoWatch
)

export const KINDLE_READING_RECOGNIZER = csvRecognizer(
  'kindle',
  'Kindle reading sessions',
  ['product_name', 'start_time', 'total_reading_milliseconds'],
  mapKindleReadingSession
)

export const AMAZON_MUSIC_LIKES_RECOGNIZER = csvRecognizer(
  'amazon-music-likes',
  'Amazon Music likes',
  ['Entity Type', 'Product Name', 'Rating', 'Last Updated Date'],
  mapAmazonMusicLike
)

export const AMAZON_MUSIC_LIBRARY_RECOGNIZER = csvRecognizer(
  'amazon-music-library',
  'Amazon Music library',
  ['Album Artist Name', 'Creation Date', 'Title'],
  mapAmazonMusicSave
)

export const ALEXA_UTTERANCE_RECOGNIZER = csvRecognizer(
  'alexa',
  'Alexa voice requests',
  ['Utterance text', 'Utterance Creation Date'],
  mapAlexaUtterance
)

/** Routed to location_points via LOCATION_RECOGNIZER_IDS — never `records`. */
export const AMAZON_LOCATION_RECOGNIZER = csvRecognizer(
  'amazon-location',
  'Amazon device locations',
  ['latitudeInDegrees', 'longitudeInDegrees', 'eventDate'],
  mapAmazonGeolocation
)

/** Routed to location_points via LOCATION_RECOGNIZER_IDS — never `records`. */
export const AMAZON_RIDER_LOCATION_RECOGNIZER = csvRecognizer(
  'amazon-rider-location',
  'Amazon app GPS fixes',
  ['GPS Time (UTC)', 'Latitude', 'Longitude'],
  mapAmazonRiderLocation
)

export const AMAZON_DIGITAL_ITEMS_RECOGNIZER = csvRecognizer(
  'amazon-digital-items',
  'Amazon digital purchases',
  ['DigitalOrderItemId', 'ProductName'],
  mapAmazonDigitalItem
)

export const AMAZON_GIFT_CERT_RECOGNIZER = csvRecognizer(
  'amazon-gift-certificates',
  'Amazon gift card transactions',
  ['serialNumber', 'transactionAmount', 'transactionType'],
  mapAmazonGiftCertificate
)

// Best-guess header detection for the four unvalidated families. Each requires a
// distinctive column so they don't steal generic dated CSVs; if the real archive
// spells the header differently, the file falls through to generic (safe).
export const AMAZON_RETURNS_RECOGNIZER = csvRecognizer(
  'amazon-returns',
  'Amazon returns & refunds',
  ['ReturnReason'],
  mapAmazonReturn
)

export const AMAZON_REVIEWS_RECOGNIZER = csvRecognizer(
  'amazon-reviews',
  'Amazon product reviews',
  ['ReviewText'],
  mapAmazonReview
)

export const AMAZON_WISHLIST_RECOGNIZER = csvRecognizer(
  'amazon-wishlist',
  'Amazon wishlists',
  ['ListName'],
  mapAmazonWishlist
)

export const AMAZON_SEARCH_RECOGNIZER = csvRecognizer(
  'amazon-search',
  'Amazon search history',
  ['Search Query'],
  mapAmazonSearch
)

// ── Reclassification registry (already-imported generic rows) ─────────────────

export type RefileFamily = {
  /** Matches the original import filename (`records.provenance`). */
  matches: (provenance: string) => boolean
  map: (row: Record<string, unknown>) => RecordInput | null
  /** Route the mapped input to `location_points` instead of `records`. */
  location?: boolean
}

export const AMAZON_REFILE_FAMILIES: readonly RefileFamily[] = [
  { matches: (p) => p.includes('PrimeVideo.WatchEvent'), map: mapPrimeVideoWatch },
  {
    matches: (p) => p.includes('Kindle.reading-insights-sessions'),
    map: mapKindleReadingSession
  },
  { matches: (p) => p.includes('Followed Artists and Accounts'), map: mapAmazonMusicLike },
  { matches: (p) => p.includes('Saved Music'), map: mapAmazonMusicSave },
  { matches: (p) => /^Intent-\d/.test(p), map: mapAlexaUtterance },
  { matches: (p) => /^Geolocation-\d/.test(p), map: mapAmazonGeolocation, location: true },
  // V2 families (recordsReclassifyV2) — validated against the real export.
  {
    matches: (p) => p.includes('rider_app_analytics'),
    map: mapAmazonRiderLocation,
    location: true
  },
  { matches: (p) => p.includes('Digital Items'), map: mapAmazonDigitalItem },
  { matches: (p) => p.includes('GiftCertificates'), map: mapAmazonGiftCertificate },
  // Unvalidated families — filename patterns are best-guess (see caveat above).
  { matches: (p) => /return/i.test(p), map: mapAmazonReturn },
  { matches: (p) => /review/i.test(p), map: mapAmazonReview },
  { matches: (p) => /wishlist|wish[\s_-]?list/i.test(p), map: mapAmazonWishlist },
  { matches: (p) => /search[\s_-]?(query|data|history)/i.test(p), map: mapAmazonSearch }
]
