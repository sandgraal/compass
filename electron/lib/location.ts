/**
 * Location-history recognizers (Phase 10.8 — "Location → Residency autopilot").
 *
 * A dropped location export (OwnTracks `.rec`/`.json`, a `.gpx` track, or a Google
 * "Records.json" Location History) becomes a stream of normalized GPS points. All
 * three recognizers emit the SAME shape — `source:'location'`, `type:'location-point'`,
 * `payload:{ lat, lng, acc?, src }` — so the downstream projector
 * (`electron/integrations/location-residency.ts`) is source-agnostic.
 *
 * PRIVACY — these points do NOT land in the `records` timeline. `electron/ipc/records.ts`
 * routes anything whose recognizer id is in `LOCATION_RECOGNIZER_IDS` into the dedicated
 * `location_points` table instead, keeping raw coordinates off the assistant/MCP-searchable
 * spine (mirrors how finance keeps rows in `finance_transactions`). Only the coarse derived
 * `travel_segments` (country + date window) ever surface.
 *
 * Pure + zero-dependency (OwnTracks/GPX parse a text string; Google streams the file path
 * via node built-ins), so the registry stays unit-testable without a DB or Electron.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Recognizer, RecordInput, StreamingRecognizer } from './recognizers'

/** The `payload` shape every location recognizer emits; read by `insertLocationPoints`. */
export type LocationPayload = { lat: number; lng: number; acc?: number; src: string }

/** Recognizer ids whose output `records.ts` diverts to `location_points` (never `records`). */
export const LOCATION_RECOGNIZER_IDS: ReadonlySet<string> = new Set([
  'owntracks',
  'gpx',
  'google-location'
])

/** Build one normalized location record. Title is deliberately COARSE (never surfaced). */
function locationPoint(
  lat: number,
  lng: number,
  occurredAt: number,
  src: string,
  acc?: number
): RecordInput {
  const payload: LocationPayload = { lat, lng, src }
  if (typeof acc === 'number' && Number.isFinite(acc)) payload.acc = acc
  return {
    source: 'location',
    type: 'location-point',
    occurredAt,
    title: `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    payload,
    // Include coordinates (≈1 m precision) so two DISTINCT points that share a
    // second-resolution timestamp don't collide on the same dedup hash and get
    // dropped — while a re-imported identical point still dedupes.
    naturalKey: `${src}|${occurredAt}|${lat.toFixed(5)}|${lng.toFixed(5)}`
  }
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// ─── OwnTracks (.rec line-log, or .json array/object of location messages) ────
// A location message is `{ _type:'location', lat, lon, tst (epoch SECONDS), acc? }`.

type OwnTracksMsg = { _type?: string; lat?: number; lon?: number; tst?: number; acc?: number }

function ownTracksMsgToPoint(m: OwnTracksMsg): RecordInput | null {
  if (m?._type !== 'location') return null
  if (!isFiniteNum(m.lat) || !isFiniteNum(m.lon) || !isFiniteNum(m.tst)) return null
  return locationPoint(m.lat, m.lon, m.tst * 1000, 'owntracks', m.acc)
}

/** Pull the JSON object out of a `.rec` line (`ISO \t TYPE \t {json}`) — from the first `{`. */
function recLineJson(line: string): OwnTracksMsg | null {
  const brace = line.indexOf('{')
  if (brace < 0) return null
  try {
    return JSON.parse(line.slice(brace)) as OwnTracksMsg
  } catch {
    return null
  }
}

/** Gather candidate location messages from a parsed `.json` export (array, {data:[…]}, or object-of-arrays). */
function ownTracksJsonMsgs(text: string): OwnTracksMsg[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed as OwnTracksMsg[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.data)) return obj.data as OwnTracksMsg[]
    if (obj._type === 'location') return [obj as OwnTracksMsg]
    // Object keyed by user/device → arrays of messages: flatten every array value.
    const out: OwnTracksMsg[] = []
    for (const v of Object.values(obj)) if (Array.isArray(v)) out.push(...(v as OwnTracksMsg[]))
    return out
  }
  return []
}

export const OWNTRACKS_RECOGNIZER: Recognizer = {
  id: 'owntracks',
  label: 'OwnTracks location log',
  detect: (f) => {
    if (f.ext === 'rec') return /"_type"\s*:\s*"location"/.test(f.text)
    if (f.ext !== 'json') return false
    return ownTracksJsonMsgs(f.text).some(
      (m) =>
        m?._type === 'location' && isFiniteNum(m.lat) && isFiniteNum(m.lon) && isFiniteNum(m.tst)
    )
  },
  parse: (f) => {
    const out: RecordInput[] = []
    if (f.ext === 'rec') {
      for (const line of f.text.split(/\r?\n/)) {
        const msg = recLineJson(line)
        const p = msg && ownTracksMsgToPoint(msg)
        if (p) out.push(p)
      }
    } else {
      for (const m of ownTracksJsonMsgs(f.text)) {
        const p = ownTracksMsgToPoint(m)
        if (p) out.push(p)
      }
    }
    return out
  }
}

// ─── GPX track (`<trkpt lat lon><time>ISO</time></trkpt>`) ─────────────────────
// Hand-parsed with regex (no XML dep, matching the codebase's other hand-parsers).
// Trackpoints without a `<time>` are skipped — undated points are useless for residency.

const TRKPT_RE = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g
const LAT_ATTR = /\blat\s*=\s*"([-\d.]+)"/
const LON_ATTR = /\blon\s*=\s*"([-\d.]+)"/
const TIME_TAG = /<time>\s*([^<]+?)\s*<\/time>/

export const GPX_RECOGNIZER: Recognizer = {
  id: 'gpx',
  label: 'GPX track',
  detect: (f) => f.ext === 'gpx' || (/<gpx\b/.test(f.text) && /<trkpt\b/.test(f.text)),
  parse: (f) => {
    const out: RecordInput[] = []
    for (const m of f.text.matchAll(TRKPT_RE)) {
      const attrs = m[1]
      const inner = m[2]
      const lat = LAT_ATTR.exec(attrs)
      const lon = LON_ATTR.exec(attrs)
      const time = TIME_TAG.exec(inner)
      if (!lat || !lon || !time) continue
      const at = Date.parse(time[1])
      const latN = Number(lat[1])
      const lonN = Number(lon[1])
      if (Number.isNaN(at) || !isFiniteNum(latN) || !isFiniteNum(lonN)) continue
      out.push(locationPoint(latN, lonN, at, 'gpx'))
    }
    return out
  }
}

// ─── Google Location History "Records.json" (streaming) ───────────────────────
// Frequently 100s of MB, so streamed line-by-line rather than read into a string.
// Each location object carries `latitudeE7`/`longitudeE7` (degrees × 1e7) + either
// `timestamp` (ISO) or `timestampMs` (epoch-ms string). We accumulate a lat/lng/ts
// triple then emit — and DOWNSAMPLE to ≥1 point per 30 min (residency only needs
// country-per-day, so a bounded handful of points per day is plenty and caps memory).

const MIN_SAMPLE_MS = 30 * 60 * 1000
const G_LAT = /"latitudeE7"\s*:\s*(-?\d+)/
const G_LNG = /"longitudeE7"\s*:\s*(-?\d+)/
const G_TS_MS = /"timestampMs"\s*:\s*"?(\d+)"?/
const G_TS_ISO = /"timestamp"\s*:\s*"([^"]+)"/

async function parseGoogleLocation(path: string): Promise<RecordInput[]> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY
  })
  const out: RecordInput[] = []
  let lat: number | null = null
  let lng: number | null = null
  let ts: number | null = null
  let lastEmit: number | null = null

  const flush = (): void => {
    if (lat != null && lng != null && ts != null) {
      if (lastEmit == null || Math.abs(ts - lastEmit) >= MIN_SAMPLE_MS) {
        out.push(locationPoint(lat, lng, ts, 'google'))
        lastEmit = ts
      }
    }
    lat = null
    lng = null
    ts = null
  }

  for await (const line of rl) {
    const mLat = G_LAT.exec(line)
    if (mLat) {
      if (lat != null) flush() // new object began before the previous completed
      lat = Number(mLat[1]) / 1e7
    }
    const mLng = G_LNG.exec(line)
    if (mLng) lng = Number(mLng[1]) / 1e7
    const mMs = G_TS_MS.exec(line)
    if (mMs) ts = Number(mMs[1])
    else {
      const mIso = G_TS_ISO.exec(line)
      if (mIso) {
        const parsed = Date.parse(mIso[1])
        if (!Number.isNaN(parsed)) ts = parsed
      }
    }
    if (lat != null && lng != null && ts != null) flush()
  }
  flush()
  return out
}

export const GOOGLE_LOCATION_STREAM: StreamingRecognizer = {
  id: 'google-location',
  label: 'Google Location History',
  detectHead: (f) => f.head.includes('"latitudeE7"'),
  parseStream: parseGoogleLocation
}
