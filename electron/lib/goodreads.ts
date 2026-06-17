/**
 * Goodreads reading-history recognizer (Phase 10 — "The Acquisition Engine").
 *
 * Opens the READING domain: a dropped Goodreads library export
 * (`goodreads_library_export.csv`) becomes one timeline record per book —
 * "Project Hail Mary — by Andy Weir · ★★★★★", dated when you finished it. Your
 * reading life, owned forever, on the unified timeline.
 *
 * A clean CSV (header on line 1), so it reuses the shared `matchHeader` column
 * resolver and `parseWhen` — zero new deps. Detection keys on the Goodreads
 * signature (`Book Id` + `Exclusive Shelf`), so it won't collide with Netflix's
 * `Title,Date` or the generic dated-CSV catch-all. Content-light: title, author,
 * rating, date; the full row is kept in `payload`.
 */

import { matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

export const GOODREADS_RECOGNIZER: Recognizer = {
  id: 'goodreads',
  label: 'Goodreads reading history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const header = f.text.slice(
      0,
      f.text.indexOf('\n') === -1 ? f.text.length : f.text.indexOf('\n')
    )
    return /book id/i.test(header) && /exclusive shelf/i.test(header)
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cBookId = matchHeader(keys, 'Book Id')
    const cTitle = matchHeader(keys, 'Title')
    const cAuthor = matchHeader(keys, 'Author')
    const cRating = matchHeader(keys, 'My Rating')
    const cDateRead = matchHeader(keys, 'Date Read')
    const cDateAdded = matchHeader(keys, 'Date Added')
    const cShelf = matchHeader(keys, 'Exclusive Shelf')

    const out: RecordInput[] = []
    for (const r of rows) {
      const bookId = cBookId ? r[cBookId].trim() : ''
      const title = cTitle ? r[cTitle].trim() : ''
      if (!bookId || !title) continue // every Goodreads row has a stable Book Id + Title
      const author = cAuthor ? r[cAuthor].trim() : ''
      const rating = cRating ? Number(r[cRating]) : 0
      const stars = rating > 0 ? '★'.repeat(rating) : ''
      // Surface the non-"read" shelves so "want to read" / "currently reading" are
      // distinguishable on the timeline (a plain `read` book needs no label).
      const shelf = cShelf ? r[cShelf].trim() : ''
      const shelfLabel = shelf && shelf !== 'read' ? shelf.replace(/-/g, ' ') : ''
      const by = author ? `by ${author}` : ''
      const body = [by, stars, shelfLabel].filter(Boolean).join(' · ') || undefined
      // Prefer the finished date; fall back to when it was added (to-read shelf).
      const when =
        parseWhen(cDateRead ? r[cDateRead] : '') ?? parseWhen(cDateAdded ? r[cDateAdded] : '')
      out.push({
        source: 'goodreads',
        type: 'book',
        occurredAt: when,
        title,
        body,
        payload: r,
        // Book Id is Goodreads' stable per-book key → exact dedup. NOT the shelf: a
        // book moving to-read → read between exports must dedupe to one record.
        naturalKey: bookId
      })
    }
    return out
  }
}
