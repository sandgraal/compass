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
