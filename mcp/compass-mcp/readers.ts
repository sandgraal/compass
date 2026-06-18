/**
 * Read-only query helpers for the expanded MCP surface (Phase 7 Track C).
 *
 * Pure functions over an injected better-sqlite3 handle so they're testable
 * with an in-memory DB — index.ts owns opening/closing the real `compass.db`
 * (read-only) per call, same as every other tool there.
 */
import type Database from 'better-sqlite3'
import { localYmd } from './dates.js'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
/** Range cap so a careless agent can't ask for years of tasks at once. */
export const MAX_TASK_RANGE_DAYS = 31
export const MAX_RECENT_NOTES = 50

export type TaskRange = { ok: true; from: string; to: string } | { ok: false; error: string }

/**
 * Normalize/validate a task date range. Defaults to today → today+6
 * (a rolling week — the gap the plan-my-week / weekly-review skills had).
 */
export function normalizeTaskRange(
  fromArg?: unknown,
  toArg?: unknown,
  now = new Date()
): TaskRange {
  const from = fromArg == null ? localYmd(now) : String(fromArg)
  const to =
    toArg == null ? localYmd(new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000)) : String(toArg)
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
    return { ok: false, error: 'from/to must be YYYY-MM-DD' }
  }
  if (to < from) return { ok: false, error: 'to must be on or after from' }
  const days =
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) /
      (24 * 60 * 60 * 1000) +
    1
  if (days > MAX_TASK_RANGE_DAYS) {
    return { ok: false, error: `range too large — max ${MAX_TASK_RANGE_DAYS} days` }
  }
  return { ok: true, from, to }
}

export interface TaskRow {
  id: number
  listDate: string
  title: string
  category: string | null
  checked: number
  source: string | null
}

/** Daily-checklist tasks across a date range, oldest day first. */
export function readTasksRange(
  db: Database.Database,
  from: string,
  to: string,
  includeChecked = true
): TaskRow[] {
  const base =
    'SELECT id, list_date AS listDate, title, category, checked, source FROM checklist_items ' +
    "WHERE list_type = 'daily' AND list_date >= ? AND list_date <= ?"
  const sql = includeChecked
    ? `${base} ORDER BY list_date, sort_order`
    : `${base} AND checked = 0 ORDER BY list_date, sort_order`
  return db.prepare(sql).all(from, to) as TaskRow[]
}

export interface RecentNoteRow {
  path: string
  title: string
  lastModified: number | null
  wordCount: number | null
}

/**
 * Most recently modified knowledge files (titles + paths only — bodies stay
 * behind compass_read_knowledge_file so the agent reads deliberately).
 */
export function readRecentNotes(db: Database.Database, limit = 10): RecentNoteRow[] {
  const capped = Math.max(1, Math.min(Math.floor(limit), MAX_RECENT_NOTES))
  return db
    .prepare(
      'SELECT path, title, last_modified AS lastModified, word_count AS wordCount ' +
        'FROM knowledge_files WHERE last_modified IS NOT NULL ORDER BY last_modified DESC LIMIT ?'
    )
    .all(capped) as RecentNoteRow[]
}

export interface TimelineSummary {
  total: number
  sources: Array<{ source: string; count: number }>
  kinds: Array<{ kind: string; count: number }>
  span: { earliestYear: number; latestYear: number } | null
  byYear: Array<{ year: number; count: number }>
}

const EMPTY_TIMELINE: TimelineSummary = { total: 0, sources: [], kinds: [], span: null, byYear: [] }

/**
 * Content-light summary of the unified `records` Timeline — counts by source and
 * kind, the UTC year span, and per-year totals. NEVER the raw records or their
 * titles, honoring the same "summaries only" boundary the rest of the MCP keeps.
 * Returns an empty summary when nothing's imported, or when the `records` table
 * doesn't exist yet (an older DB predating the Acquisition Engine migration).
 */
export function readTimelineSummary(db: Database.Database): TimelineSummary {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'")
    .get()
  if (!hasTable) return EMPTY_TIMELINE
  const total = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n
  if (total === 0) return EMPTY_TIMELINE

  const sources = db
    .prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source ORDER BY n DESC, source')
    .all() as Array<{ source: string; n: number }>
  const kinds = db
    .prepare('SELECT type, COUNT(*) AS n FROM records GROUP BY type ORDER BY n DESC, type')
    .all() as Array<{ type: string; n: number }>
  const span = db
    .prepare(
      'SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM records WHERE occurred_at IS NOT NULL'
    )
    .get() as { lo: number | null; hi: number | null }
  const byYear = db
    .prepare(
      "SELECT CAST(strftime('%Y', occurred_at / 1000, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS n " +
        'FROM records WHERE occurred_at IS NOT NULL GROUP BY year ORDER BY year'
    )
    .all() as Array<{ year: number; n: number }>

  return {
    total,
    sources: sources.map((r) => ({ source: r.source, count: r.n })),
    kinds: kinds.map((r) => ({ kind: r.type, count: r.n })),
    span:
      span.lo != null && span.hi != null
        ? {
            earliestYear: new Date(span.lo).getUTCFullYear(),
            latestYear: new Date(span.hi).getUTCFullYear()
          }
        : null,
    byYear: byYear.map((r) => ({ year: r.year, count: r.n }))
  }
}
