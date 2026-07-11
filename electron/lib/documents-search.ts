/**
 * Full-text search over the documents store (Phase 9.2 "Storehouse").
 *
 * Pure helper over an injected better-sqlite3 handle — mirrors
 * `records-search.ts` and reuses its `toFtsMatchQuery` — so ⌘K can find a
 * document by a word that only appears INSIDE the file (extracted PDF / text),
 * not just its title. Backed by the `documents_fts` external-content FTS5 index
 * (title + extracted_text) created + kept in sync by triggers in
 * `electron/db/client.ts`.
 */

import type Database from 'better-sqlite3'
import { toFtsMatchQuery } from './records-search'

export interface DocumentSearchHit {
  id: number
  title: string
  fileName: string
  snippet: string
  rank: number
}

/** bm25-ranked full-text search over documents. Title is weighted above the
 *  extracted body; rows arrive best-first. Empty query → no results. */
export function searchDocuments(
  sqlite: Database.Database,
  opts: { q: string; limit?: number }
): DocumentSearchHit[] {
  const match = toFtsMatchQuery(opts.q ?? '')
  if (!match) return []
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100)
  return sqlite
    .prepare(
      `SELECT d.id AS id, d.title AS title, d.file_name AS fileName,
              snippet(documents_fts, 1, '[', ']', '…', 16) AS snippet,
              bm25(documents_fts, 10.0, 1.0) AS rank
         FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH @match
        ORDER BY rank
        LIMIT @limit`
    )
    .all({ match, limit }) as DocumentSearchHit[]
}
