/**
 * Full-text search over the unified `records` timeline (Phase 10.7 — "Converse").
 *
 * Pure helpers over an injected better-sqlite3 handle — no Electron, no Drizzle —
 * so they're shared by the `records:search` IPC and the Ask-Compass `search_records`
 * tool, and unit-test against an in-memory DB. The MCP server (a separate package
 * that can't import `electron/`) duplicates this SQL in its own reader.
 *
 * Backed by the `records_fts` external-content FTS5 index (created + kept in sync
 * by triggers in `electron/db/client.ts`).
 */

import type Database from 'better-sqlite3'

export interface RecordSearchOpts {
  q: string
  source?: string
  type?: string
  from?: number | null // epoch ms inclusive
  to?: number | null // epoch ms inclusive
  limit?: number
  offset?: number
  mode?: 'keyword' | 'semantic' // PR1 is keyword-only; 'semantic' lands in PR2
}

export interface TimelineSearchHit {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
  titleSnippet: string
  bodySnippet: string
  rank: number
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression. Each whitespace token
 * is double-quoted (so FTS5 operators like `AND`/`*`/`:`/`(` and stray punctuation
 * are treated as literal text, not query syntax); the LAST token gets a trailing
 * `*` for prefix matching ("amaz" → "amazon"). Returns null when nothing usable
 * remains (the caller then yields no results rather than an FTS syntax error).
 */
export function toFtsMatchQuery(q: string): string | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim()) // drop embedded quotes; punctuation is tokenized away inside quotes
    .filter((t) => t.length > 0)
  if (terms.length === 0) return null
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ')
}

/**
 * bm25-ranked full-text search, composing the same source/type/date filters as the
 * timeline list. Title is weighted above body above payload so JSON noise in the
 * payload column adds recall without dominating the ranking. Rows arrive best-first.
 */
export function searchRecords(
  sqlite: Database.Database,
  opts: RecordSearchOpts
): TimelineSearchHit[] {
  const match = toFtsMatchQuery(opts.q ?? '')
  if (!match) return []
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200)
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
  return sqlite
    .prepare(
      `SELECT r.id AS id, r.source AS source, r.type AS type, r.occurred_at AS occurredAt,
              r.title AS title, r.body AS body,
              snippet(records_fts, 0, '[', ']', '…', 12) AS titleSnippet,
              snippet(records_fts, 1, '[', ']', '…', 16) AS bodySnippet,
              bm25(records_fts, 10.0, 5.0, 1.0) AS rank
         FROM records_fts
         JOIN records r ON r.id = records_fts.rowid
        WHERE records_fts MATCH @match
          AND (@source IS NULL OR r.source = @source)
          AND (@type   IS NULL OR r.type   = @type)
          AND (@from   IS NULL OR r.occurred_at >= @from)
          AND (@to     IS NULL OR r.occurred_at <= @to)
        ORDER BY rank
        LIMIT @limit OFFSET @offset`
    )
    .all({
      match,
      source: opts.source ?? null,
      type: opts.type ?? null,
      from: opts.from ?? null,
      to: opts.to ?? null,
      limit,
      offset
    }) as TimelineSearchHit[]
}
