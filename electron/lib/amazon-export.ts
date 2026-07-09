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
 *
 * Each family exposes its row mapper via `AMAZON_REFILE_FAMILIES` so the
 * one-shot reclassifier (`records-reclassify.ts`) can re-derive already-imported
 * generic rows from their stored payloads — same mapper, one source of truth.
 * Everything else in the archive (device telemetry, impressions, notification
 * metadata) deliberately stays generic; source-tiers collapses it as firehose.
 */

import { parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

/** Amazon CSVs write 'Not Available' / 'Data Not Available' instead of blanks. */
function field(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (v == null) return ''
  const s = String(v).trim()
  return /^(data )?not available$/i.test(s) ? '' : s
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
  { matches: (p) => /^Geolocation-\d/.test(p), map: mapAmazonGeolocation, location: true }
]
