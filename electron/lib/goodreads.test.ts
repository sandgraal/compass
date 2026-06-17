/**
 * Tests for the Goodreads reading-history recognizer (Phase 10). Covers the
 * library export shape, the author + rating-stars body, the Date Read → Date Added
 * fallback, the Book Id dedup key, and that it claims the file ahead of the generic
 * catch-all without grabbing a non-Goodreads CSV.
 */

import { describe, expect, it } from 'vitest'
import { GOODREADS_RECOGNIZER } from './goodreads'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const EXPORT = [
  'Book Id,Title,Author,My Rating,Average Rating,Number of Pages,Date Read,Date Added,Exclusive Shelf',
  '54493401,Project Hail Mary,Andy Weir,5,4.52,476,2026/01/15,2025/12/01,read',
  '2767052,The Hunger Games,Suzanne Collins,0,4.33,374,,2026/02/01,to-read'
].join('\n')

describe('Goodreads reading-history recognizer', () => {
  it('recognizes a library export — one record per book', () => {
    const f = file('goodreads_library_export.csv', EXPORT)
    expect(recognize(f)?.id).toBe('goodreads') // claims it ahead of the generic catch-all

    const out = GOODREADS_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.source === 'goodreads' && r.type === 'book')).toBe(true)

    const phm = out.find((r) => r.title === 'Project Hail Mary')
    expect(phm?.body).toBe('by Andy Weir · ★★★★★') // author + rating stars
    expect(phm?.occurredAt).toBe(Date.parse('2026/01/15')) // Date Read
    expect(phm?.naturalKey).toBe('54493401') // Book Id

    const hg = out.find((r) => r.title === 'The Hunger Games')
    expect(hg?.body).toBe('by Suzanne Collins') // unrated → no stars
    expect(hg?.occurredAt).toBe(Date.parse('2026/02/01')) // falls back to Date Added
  })

  it('does not claim a non-Goodreads CSV', () => {
    const f = file('NetflixViewingHistory.csv', 'Title,Date\nThe Matrix,1/2/26\n')
    expect(GOODREADS_RECOGNIZER.detect(f)).toBe(false)
    expect(recognize(f)?.id).not.toBe('goodreads')
  })
})
