/**
 * Drop Zone recognizers (Phase 10.1 — "The Acquisition Engine").
 *
 * A registry of pure, zero-dependency parsers that turn a user-supplied data
 * export file into normalized timeline `records`. Each recognizer DETECTS whether
 * it can handle a file (by name / header / JSON shape) and PARSES it into
 * `RecordInput[]`. The Drop Zone tries them in order — specific first, the generic
 * dated-CSV/JSON catch-all LAST — exactly like the finance `PARSERS` dispatch.
 *
 * Pure + Electron-free (only `node:crypto` for the dedup hash, plus the shared CSV
 * codec) so the whole registry is unit-testable without a DB or Electron. Adding a
 * new source = one more entry in `RECOGNIZERS`.
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AMAZON_RECOGNIZER } from './amazon'
import { parseAppleHealth } from './apple-health'
import { BROWSER_RECOGNIZERS } from './browser-history'
import { parseCSV } from './csv'
import { parseWhen } from './dates'
import { GOODREADS_RECOGNIZER } from './goodreads'
import { IMESSAGE_RECOGNIZER } from './imessage'
import { parseMbox } from './mbox'
import { PAYPAL_RECOGNIZER } from './paypal'
import { VENMO_RECOGNIZER } from './venmo'

// Re-exported so existing importers keep `import { parseWhen } from './recognizers'`
// working; the implementation now lives in `./dates` so recognizer files can use it
// without an import cycle back through this module.
export { parseWhen }

export type RecordInput = {
  source: string
  type: string
  occurredAt: number | null // epoch ms, or null when undated
  title: string
  body?: string
  payload?: unknown
  naturalKey: string // stable per-event key so re-imports dedupe
}

export type RecognizerFile = {
  name: string // basename, e.g. 'NetflixViewingHistory.csv'
  ext: string // lowercased extension without the dot, e.g. 'csv'
  text: string // full file contents (utf-8, BOM already stripped by the caller)
}

export type Recognizer = {
  id: string
  label: string
  detect: (f: RecognizerFile) => boolean
  parse: (f: RecognizerFile) => RecordInput[]
}

/**
 * Content-addressed dedup key for `records.dedupHash`. Mirrors `hashTxn` in
 * `finance.ts`: the SHA-1 is NOT a security primitive — no secret, no signature —
 * just a deterministic key so the same event, seen again in a re-imported export,
 * maps to the same row and dedupes.
 */
export function hashRecord(
  source: string,
  type: string,
  occurredAt: number | null,
  naturalKey: string
): string {
  return createHash('sha1') // codeql[js/weak-cryptographic-algorithm] -- non-crypto content-dedup key
    .update(`${source}|${type}|${occurredAt ?? ''}|${naturalKey}`)
    .digest('hex')
    .slice(0, 16)
}

function safeJsonArray(text: string): unknown[] {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// ── Netflix viewing history (CSV: "Title","Date") ─────────────────────────────
const netflix: Recognizer = {
  id: 'netflix',
  label: 'Netflix viewing history',
  detect: (f) => f.ext === 'csv' && (/viewing/i.test(f.name) || /^"?title"?\s*,/i.test(f.text)),
  parse: (f) => {
    const out: RecordInput[] = []
    for (const r of parseCSV(f.text)) {
      const title = r.Title ?? r.title ?? ''
      const date = r.Date ?? r.date ?? ''
      if (!title) continue
      out.push({
        source: 'netflix',
        type: 'watch',
        occurredAt: parseWhen(date),
        title,
        payload: r,
        naturalKey: `${title}|${date}`
      })
    }
    return out
  }
}

// ── Spotify streaming history (JSON; basic + extended export shapes) ───────────
type SpotifyRow = {
  endTime?: string
  ts?: string
  artistName?: string
  trackName?: string
  msPlayed?: number
  master_metadata_track_name?: string | null
  master_metadata_album_artist_name?: string | null
  ms_played?: number
}

const spotify: Recognizer = {
  id: 'spotify',
  label: 'Spotify streaming history',
  detect: (f) => {
    if (f.ext !== 'json') return false
    const arr = safeJsonArray(f.text)
    if (!arr.length) return false
    const first = arr[0] as SpotifyRow
    return (
      (typeof first.endTime === 'string' && typeof first.trackName === 'string') ||
      (typeof first.ts === 'string' && 'master_metadata_track_name' in first)
    )
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const r of safeJsonArray(f.text) as SpotifyRow[]) {
      const when = r.ts ?? r.endTime ?? ''
      const track = r.master_metadata_track_name ?? r.trackName ?? ''
      const artist = r.master_metadata_album_artist_name ?? r.artistName ?? ''
      if (!track) continue
      const ms = r.ms_played ?? r.msPlayed ?? 0
      out.push({
        source: 'spotify',
        type: 'listen',
        occurredAt: parseWhen(when),
        title: artist ? `${track} — ${artist}` : track,
        body: ms ? `${Math.round(ms / 60000)} min` : undefined,
        payload: r,
        naturalKey: `${when}|${track}`
      })
    }
    return out
  }
}

// ── Generic dated CSV/JSON catch-all ──────────────────────────────────────────
const DATE_KEY = /date|time|timestamp|when|^ts$|played|watched/i
const TITLE_KEY = /title|name|track|show|movie|subject|description|event|summary|content/i

function genericRows(f: RecognizerFile): {
  rows: Record<string, unknown>[]
  dateKey?: string
  titleKey?: string
} {
  let rows: Record<string, unknown>[] = []
  if (f.ext === 'json') {
    rows = safeJsonArray(f.text).filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
    )
  } else if (f.ext === 'csv') {
    rows = parseCSV(f.text)
  }
  if (!rows.length) return { rows }
  const keys = Object.keys(rows[0])
  const dateKey = keys.find((k) => DATE_KEY.test(k))
  const titleKey = keys.find((k) => TITLE_KEY.test(k)) ?? keys.find((k) => k !== dateKey)
  // Only claim the file if the date column actually parses on some row.
  if (dateKey && rows.some((r) => parseWhen(String(r[dateKey] ?? '')) != null)) {
    return { rows, dateKey, titleKey }
  }
  return { rows, titleKey }
}

const genericTimeline: Recognizer = {
  id: 'generic',
  label: 'Generic dated CSV/JSON',
  detect: (f) => genericRows(f).dateKey != null,
  parse: (f) => {
    const { rows, dateKey, titleKey } = genericRows(f)
    if (!dateKey) return []
    const out: RecordInput[] = []
    for (const r of rows) {
      const when = parseWhen(String(r[dateKey] ?? ''))
      const title = titleKey ? String(r[titleKey] ?? '') : ''
      if (!title && when == null) continue
      out.push({
        source: 'generic',
        type: 'event',
        occurredAt: when,
        title: title || '(untitled)',
        payload: r,
        naturalKey: `${r[dateKey] ?? ''}|${title}`
      })
    }
    return out
  }
}

// ── YouTube watch history (Takeout watch-history.json) ────────────────────────
type YouTubeRow = {
  header?: string
  title?: string
  titleUrl?: string
  time?: string
  subtitles?: Array<{ name?: string }>
}
const youtube: Recognizer = {
  id: 'youtube',
  label: 'YouTube history',
  detect: (f) => {
    if (f.ext !== 'json' && !/watch-history/i.test(f.name)) return false
    const first = safeJsonArray(f.text)[0] as YouTubeRow | undefined
    return (
      !!first &&
      typeof first.title === 'string' &&
      typeof first.time === 'string' &&
      (typeof first.titleUrl === 'string' || first.header === 'YouTube')
    )
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const r of safeJsonArray(f.text) as YouTubeRow[]) {
      if (!r.time || !r.title) continue
      const when = Date.parse(r.time)
      out.push({
        source: 'youtube',
        type: 'watch',
        occurredAt: Number.isNaN(when) ? null : when,
        title: r.title.replace(/^Watched /, ''),
        body: r.subtitles?.[0]?.name,
        payload: r,
        naturalKey: r.titleUrl || `${r.time}|${r.title}`
      })
    }
    return out
  }
}

export const RECOGNIZERS: Recognizer[] = [
  netflix,
  spotify,
  youtube,
  AMAZON_RECOGNIZER,
  PAYPAL_RECOGNIZER,
  GOODREADS_RECOGNIZER,
  VENMO_RECOGNIZER,
  genericTimeline
]

/** First recognizer that claims this file (specific → generic), or null. */
export function recognize(f: RecognizerFile): Recognizer | null {
  return (
    RECOGNIZERS.find((rec) => {
      try {
        return rec.detect(f)
      } catch {
        return false
      }
    }) ?? null
  )
}

// ── Streaming recognizers (Phase 10.3) ────────────────────────────────────────
// For sources too large to read into a string and too dense to store 1:1 — e.g.
// Apple Health `export.xml` (100s of MB, millions of samples). These DETECT on a
// small head sample and PARSE by streaming the file path themselves (the parser
// aggregates). The Drop Zone tries these BEFORE the text recognizers.

export type StreamHead = { name: string; ext: string; head: string }

export type StreamingRecognizer = {
  id: string
  label: string
  detectHead: (f: StreamHead) => boolean
  parseStream: (path: string) => Promise<RecordInput[]>
}

const appleHealth: StreamingRecognizer = {
  id: 'apple-health',
  label: 'Apple Health',
  detectHead: (f) => f.name.toLowerCase() === 'export.xml' || f.head.includes('<HealthData'),
  parseStream: parseAppleHealth
}

const email: StreamingRecognizer = {
  id: 'email',
  label: 'Email archive',
  detectHead: (f) => f.ext === 'mbox' || /^From \S+ .*\d{4}/m.test(f.head.slice(0, 4096)),
  parseStream: parseMbox
}

export const STREAM_RECOGNIZERS: StreamingRecognizer[] = [appleHealth, email]

/** First streaming recognizer that claims this file (by head sniff), or null. */
export function recognizeStream(f: StreamHead): StreamingRecognizer | null {
  return (
    STREAM_RECOGNIZERS.find((rec) => {
      try {
        return rec.detectHead(f)
      } catch {
        return false
      }
    }) ?? null
  )
}

// ── SQLite-file recognizers (Phase 10.4) ──────────────────────────────────────
// For sources that ARE a database — a dropped browser-history / chat DB. The Drop
// Zone opens the file READ-ONLY and each recognizer claims it by checking which
// tables exist, then queries. (Parsers live in `browser-history.ts`.)

export type SqliteRecognizer = {
  id: string
  label: string
  detect: (db: Database.Database) => boolean
  parse: (db: Database.Database) => RecordInput[]
}

export const SQLITE_RECOGNIZERS: SqliteRecognizer[] = [...BROWSER_RECOGNIZERS, IMESSAGE_RECOGNIZER]

/** First SQLite recognizer that claims this opened DB, or null. */
export function recognizeSqlite(db: Database.Database): SqliteRecognizer | null {
  return (
    SQLITE_RECOGNIZERS.find((rec) => {
      try {
        return rec.detect(db)
      } catch {
        return false
      }
    }) ?? null
  )
}
