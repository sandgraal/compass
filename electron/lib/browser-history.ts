/**
 * Browser-history SQLite recognizers (Phase 10.4 — "The Acquisition Engine").
 *
 * A dropped browser-history database (Chrome `History`, Firefox `places.sqlite`,
 * Safari `History.db`) is opened READ-ONLY by the Drop Zone and queried — each page
 * visit becomes one timeline record. Two fiddly bits:
 *   - three different visit-time epochs (1601 µs / 1970 µs / 2001 s);
 *   - Chrome's microsecond timestamps (~1.3e16) exceed Number.MAX_SAFE_INTEGER, so
 *     the epoch conversion is done IN SQL (SQLite int64, exact) — the JS side only
 *     ever sees the already-small epoch-ms — and the dedup key uses the visit row's
 *     primary key (exact + stable) rather than the raw timestamp.
 */

import type Database from 'better-sqlite3'
import type { RecordInput, SqliteRecognizer } from './recognizers'

const LIMIT = 200000 // cap rows pulled from a single history DB

function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** True when every named table exists in the DB. */
function hasTables(db: Database.Database, ...tables: string[]): boolean {
  const inList = tables.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${inList})`)
    .get(...tables) as { n: number }
  return row.n === tables.length
}

// `ms` is epoch-ms computed in SQL (int64, no JS precision loss); `vid` is the
// visit row's primary key (exact + stable → a collision-free dedup key).
type VisitRow = { url: string; title: string | null; ms: number | null; vid: number }

function toRecords(rows: VisitRow[], browser: string): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.url) continue
    out.push({
      source: 'browser',
      type: 'visit',
      occurredAt: typeof r.ms === 'number' && Number.isFinite(r.ms) ? r.ms : null,
      title: r.title?.trim() || r.url,
      body: hostname(r.url),
      payload: { url: r.url, browser },
      naturalKey: `${r.url}|${r.vid}`
    })
  }
  return out
}

// Chrome: visit_time = microseconds since 1601-01-01 UTC → ms (offset 11644473600000).
const chrome: SqliteRecognizer = {
  id: 'chrome',
  label: 'Chrome history',
  detect: (db) => hasTables(db, 'urls', 'visits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT urls.url AS url, urls.title AS title, visits.id AS vid, ' +
            '(visits.visit_time / 1000 - 11644473600000) AS ms ' +
            'FROM visits JOIN urls ON urls.id = visits.url ' +
            'WHERE visits.visit_time > 0 ORDER BY visits.visit_time DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'chrome'
    )
}

// Firefox: visit_date = microseconds since the Unix epoch (PRTime) → ms.
const firefox: SqliteRecognizer = {
  id: 'firefox',
  label: 'Firefox history',
  detect: (db) => hasTables(db, 'moz_places', 'moz_historyvisits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT p.url AS url, p.title AS title, h.id AS vid, (h.visit_date / 1000) AS ms ' +
            'FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id ' +
            'WHERE h.visit_date > 0 ORDER BY h.visit_date DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'firefox'
    )
}

// Safari: visit_time = seconds since 2001-01-01 UTC (CFAbsoluteTime) → ms.
const safari: SqliteRecognizer = {
  id: 'safari',
  label: 'Safari history',
  detect: (db) => hasTables(db, 'history_items', 'history_visits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT i.url AS url, v.title AS title, v.id AS vid, ' +
            'CAST((v.visit_time + 978307200) * 1000 AS INTEGER) AS ms ' +
            'FROM history_visits v JOIN history_items i ON i.id = v.history_item ' +
            'ORDER BY v.visit_time DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'safari'
    )
}

export const BROWSER_RECOGNIZERS: SqliteRecognizer[] = [chrome, firefox, safari]
