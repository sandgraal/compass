/**
 * Browser-history SQLite recognizers (Phase 10.4 — "The Acquisition Engine").
 *
 * A dropped browser-history database (Chrome `History`, Firefox `places.sqlite`,
 * Safari `History.db`) is opened READ-ONLY by the Drop Zone and queried — each page
 * visit becomes one timeline record. The fiddly bit is that the three browsers
 * store the visit time in three different epochs.
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

type VisitRow = { url: string; title: string | null; t: number }

function toRecords(rows: VisitRow[], browser: string, toMs: (t: number) => number): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.url) continue
    const ms = toMs(r.t)
    out.push({
      source: 'browser',
      type: 'visit',
      occurredAt: Number.isFinite(ms) ? ms : null,
      title: r.title?.trim() || r.url,
      body: hostname(r.url),
      payload: { url: r.url, browser },
      naturalKey: `${r.url}|${r.t}`
    })
  }
  return out
}

// Chrome: visit_time is microseconds since 1601-01-01 UTC.
const CHROME_1601_OFFSET_MS = 11644473600000
const chrome: SqliteRecognizer = {
  id: 'chrome',
  label: 'Chrome history',
  detect: (db) => hasTables(db, 'urls', 'visits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT urls.url AS url, urls.title AS title, visits.visit_time AS t ' +
            'FROM visits JOIN urls ON urls.id = visits.url ' +
            'WHERE visits.visit_time > 0 ORDER BY visits.visit_time DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'chrome',
      (t) => t / 1000 - CHROME_1601_OFFSET_MS
    )
}

// Firefox: visit_date is microseconds since the Unix epoch (PRTime).
const firefox: SqliteRecognizer = {
  id: 'firefox',
  label: 'Firefox history',
  detect: (db) => hasTables(db, 'moz_places', 'moz_historyvisits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT p.url AS url, p.title AS title, h.visit_date AS t ' +
            'FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id ' +
            'WHERE h.visit_date > 0 ORDER BY h.visit_date DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'firefox',
      (t) => t / 1000
    )
}

// Safari: visit_time is seconds since 2001-01-01 UTC (CFAbsoluteTime).
const SAFARI_2001_OFFSET_S = 978307200
const safari: SqliteRecognizer = {
  id: 'safari',
  label: 'Safari history',
  detect: (db) => hasTables(db, 'history_items', 'history_visits'),
  parse: (db) =>
    toRecords(
      db
        .prepare(
          'SELECT i.url AS url, v.title AS title, v.visit_time AS t ' +
            'FROM history_visits v JOIN history_items i ON i.id = v.history_item ' +
            'ORDER BY v.visit_time DESC LIMIT ?'
        )
        .all(LIMIT) as VisitRow[],
      'safari',
      (t) => (t + SAFARI_2001_OFFSET_S) * 1000
    )
}

export const BROWSER_RECOGNIZERS: SqliteRecognizer[] = [chrome, firefox, safari]
