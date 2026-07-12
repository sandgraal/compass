/**
 * Repair for the over-greedy Netflix recognizer (data cleanup pass, 2026-07).
 *
 * The original `netflix` detect() claimed any CSV whose filename contained
 * "viewing" OR whose header merely BEGAN with "Title," — so four unrelated
 * export families were misfiled as `netflix|watch` (live-DB audit, 2026-07-11):
 *
 *  - `PrimeVideo.ViewingHistory*.csv` (2,084 rows) — Amazon per-playback
 *    sessions; quoted titles, dates stuck in payload → prime-video / watch
 *  - Google Maps saved lists (`Want to go.csv`, `Madrid Trip.csv`, … ~35
 *    files, ~430 rows; shape Title,Note,URL,Tags,Comment) → `google-saved`
 *    snapshot facts labeled by list (they're bookmarks, not timeline events)
 *  - `Bookmarks_N.csv` (321 rows; Title,URL,modifiedOn,favorite,deleted) →
 *    'Bookmark' snapshot facts, URL-keyed exactly like the Chrome-bookmarks
 *    recognizer so re-exports and overlapping sources dedupe
 *  - `Notes Details.csv` (41 rows; note titles + created/modified dates,
 *    header keys carry a LEADING SPACE) → notes / note records
 *
 * Real Netflix rows (`NetflixViewingHistory.csv`, payload exactly
 * {Title, Date}) are untouched: every mapper here structurally guards on
 * columns Netflix rows don't have, so the refile executor leaves them alone.
 *
 * Mirrors the `records-reclassify.ts` planner: pure functions over stored
 * payloads; the IPC layer executes through the production insert paths.
 */

import { mapPrimeVideoSession } from './amazon-export'
import { parseCSV } from './csv'
import { parseWhen } from './dates'
import type {
  Recognizer,
  RecognizerFile,
  RecordInput,
  SnapshotFact,
  SnapshotRecognizer
} from './recognizers'
import type { GenericRowLite } from './records-reclassify'

function text(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  return v == null ? '' : String(v).trim()
}

/** List name for a Google Maps saved-list file: the filename minus extension. */
export function savedListLabel(provenance: string): string {
  return provenance.replace(/\.[a-z0-9]+$/i, '').trim() || 'Saved list'
}

/**
 * Google Maps saved-list row → a `google-saved` snapshot fact grouped under
 * the list's name. Guarded on the full structural shape (URL+Note+Tags — the
 * exact Takeout saved-list header) so nothing else can match.
 */
export function mapSavedPlaceFact(
  row: Record<string, unknown>,
  provenance: string,
  position: number
): SnapshotFact | null {
  if (!('URL' in row) || !('Note' in row) || !('Tags' in row)) return null
  const title = text(row, 'Title')
  if (!title) return null
  const url = text(row, 'URL')
  const note = text(row, 'Note')
  const label = savedListLabel(provenance)
  return {
    source: 'google',
    category: 'google-saved',
    label,
    value: note ? `${title} — ${note}` : title,
    position,
    // Key on the stable place URL (titles collide across lists); fall back to title.
    naturalKey: `${label}|${url || title}`
  }
}

/**
 * Browser-bookmark CSV row → a 'Bookmark' snapshot fact. Same label and
 * URL-based naturalKey as `GOOGLE_BOOKMARKS_RECOGNIZER` (google.ts), so the
 * same page saved via two exports collapses to one fact.
 */
export function mapBookmarkFact(
  row: Record<string, unknown>,
  position: number
): SnapshotFact | null {
  if (!('modifiedOn' in row) || !('favorite' in row)) return null
  const title = text(row, 'Title')
  if (!title) return null
  const url = text(row, 'URL')
  return {
    source: 'google',
    category: 'google-saved',
    label: 'Bookmark',
    value: title,
    position,
    naturalKey: `Bookmark|${url || title}`
  }
}

/**
 * Note-metadata row (`Notes Details.csv` — keys carry a leading space) →
 * notes/note record. Dates are 'MM-DD-YYYY HH:mm:ss'; `parseWhen` can't take
 * the time suffix, so parse the date part (day precision is plenty).
 */
export function mapNoteDetail(row: Record<string, unknown>): RecordInput | null {
  if (!(' Created On' in row)) return null
  const title = text(row, 'Title')
  if (!title) return null
  const created = text(row, ' Created On')
  return {
    source: 'notes',
    type: 'note',
    occurredAt: parseWhen(created.split(' ')[0] ?? ''),
    title,
    payload: row,
    naturalKey: `${created}|${title}`
  }
}

// ── Fresh-import recognizers for the same families ────────────────────────────
// (Refiling repairs old rows; these make NEW imports of the same files land
// right the first time. A file can match a snapshot recognizer AND a regular
// one, so these coexist with the strict netflix detect.)

function csvHeader(f: RecognizerFile): string {
  if (f.ext !== 'csv') return ''
  const nl = f.text.indexOf('\n')
  return nl === -1 ? f.text : f.text.slice(0, nl)
}

/** Google Maps saved lists (`Want to go.csv`, trip lists, …). */
export const GOOGLE_SAVED_LIST_RECOGNIZER: SnapshotRecognizer = {
  id: 'google-saved-list',
  label: 'Google Maps saved list',
  detect: (f) => {
    const header = csvHeader(f)
    return header !== '' && ['Title', 'Note', 'URL', 'Tags'].every((c) => header.includes(c))
  },
  parse: (f) => {
    const out: SnapshotFact[] = []
    let position = 0
    for (const row of parseCSV(f.text)) {
      const fact = mapSavedPlaceFact(row, f.name, position)
      if (fact) {
        out.push(fact)
        position++
      }
    }
    return out
  }
}

/** Browser-bookmark CSVs (`Bookmarks_1.csv`, …). */
export const CSV_BOOKMARKS_RECOGNIZER: SnapshotRecognizer = {
  id: 'csv-bookmarks',
  label: 'Bookmarks (CSV)',
  detect: (f) => {
    const header = csvHeader(f)
    return header !== '' && ['Title', 'URL', 'modifiedOn'].every((c) => header.includes(c))
  },
  parse: (f) => {
    const out: SnapshotFact[] = []
    let position = 0
    for (const row of parseCSV(f.text)) {
      const fact = mapBookmarkFact(row, position)
      if (fact) {
        out.push(fact)
        position++
      }
    }
    return out
  }
}

/** Note-metadata exports (`Notes Details.csv` — leading-space header keys). */
export const NOTES_DETAILS_RECOGNIZER: Recognizer = {
  id: 'notes-details',
  label: 'Notes export',
  detect: (f) => {
    // 'Title' + 'Created On' is too common across exports — require the
    // distinctive Drawing/Handwriting column this notes export carries.
    const header = csvHeader(f)
    return header !== '' && header.includes('Title') && header.includes('Drawing/Handwriting')
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const row of parseCSV(f.text)) {
      const input = mapNoteDetail(row)
      if (input) out.push(input)
    }
    return out
  }
}

export type NetflixRefilePlan = {
  /** Misfiled rows to re-insert as properly-sourced records, then delete. */
  records: Array<{ deleteId: number; provenance: string; input: RecordInput }>
  /** Misfiled rows that become snapshot facts (bookmarks / saved places), then delete. */
  facts: Array<{ deleteId: number; provenance: string; fact: SnapshotFact }>
}

/**
 * Route stored `netflix|watch` rows to where they belong. Rows nothing claims
 * (the real Netflix history) are left untouched.
 */
export function planNetflixRefile(rows: Iterable<GenericRowLite>): NetflixRefilePlan {
  const plan: NetflixRefilePlan = { records: [], facts: [] }
  let position = 0
  for (const row of rows) {
    const { provenance, payload } = row
    if (!provenance || !payload) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const r = parsed as Record<string, unknown>

    if (provenance.includes('PrimeVideo.ViewingHistory')) {
      const input = mapPrimeVideoSession(r)
      if (input) plan.records.push({ deleteId: row.id, provenance, input })
      continue
    }
    if (provenance.includes('Notes Details')) {
      const input = mapNoteDetail(r)
      if (input) plan.records.push({ deleteId: row.id, provenance, input })
      continue
    }
    if (/^Bookmarks[_\s-]?\d/i.test(provenance)) {
      const fact = mapBookmarkFact(r, position)
      if (fact) {
        plan.facts.push({ deleteId: row.id, provenance, fact })
        position++
      }
      continue
    }
    // Fallback: any other CSV the greedy detect stole — claimed only when the
    // payload has the exact Google saved-list shape (real Netflix rows decline).
    const fact = mapSavedPlaceFact(r, provenance, position)
    if (fact) {
      plan.facts.push({ deleteId: row.id, provenance, fact })
      position++
    }
  }
  return plan
}
