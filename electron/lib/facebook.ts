/**
 * Facebook — the HTML "Download Your Information" (DYI) export. Recognizers for
 * `your_posts__…` (posts) and `connections/friends/your_friends.html` (friends).
 *
 * FB's archive (HTML format) packs each entry into a repeating `_a6-g` block: an
 * `<h2>` action header ("… shared a link", "… updated his status"), the post
 * text/links, and a timestamp like "May 02, 2011 8:12:17 am". One record per
 * post, dated in the export's local time (Cocoa-free — parsed from the parts so
 * it's timezone-deterministic and lands on the right local day).
 *
 * The full 6 GB archive is almost entirely media (jpg/mp4); the data lives in
 * small HTML files (`your_posts__…_N.html`, ~180 KB each). Drop the unzipped
 * HTML — the whole archive trips the Drop Zone's 5 GB zip cap, but each HTML
 * file is tiny.
 *
 * Brittle by nature: FB's obfuscated class names (`_a6-g`) can change between
 * export eras. Detection also accepts the stable `your_posts` filename, and the
 * parse degrades to "skip the block" rather than crashing if the shape drifts.
 */

import type { Recognizer, RecordInput } from './recognizers'

const FB_DYI = /facebook\.com\/dyi/i
const POST_BLOCK = 'class="_a6-g"'
/** "May 02, 2011 8:12:17 am" → capture groups. */
const FB_DATE = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2})\s*([ap])m/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
/** Strip tags, decode entities, collapse whitespace. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse FB's "Mon DD, YYYY h:mm:ss am" into LOCAL epoch ms, or null. */
function parseFbDate(block: string): number | null {
  const m = block.match(FB_DATE)
  if (!m) return null
  const monthIdx = MONTHS.indexOf(m[1].toLowerCase())
  if (monthIdx < 0) return null
  let hour = Number(m[4]) % 12
  if (m[7].toLowerCase() === 'p') hour += 12
  const t = new Date(
    Number(m[3]),
    monthIdx,
    Number(m[2]),
    hour,
    Number(m[5]),
    Number(m[6])
  ).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * A Facebook "Download Your Information" HTML file (any section). Signed by the
 * DYI permalink marker (posts) OR the `_a6-g` entry-block class (friends and the
 * rest, which have no permalinks). Detection still anchors on the section
 * filename, so this just confirms "yes, an FB export".
 */
function isFbHtml(f: { ext: string; text: string }): boolean {
  return (
    (f.ext === 'html' || f.ext === 'htm') && (FB_DYI.test(f.text) || f.text.includes(POST_BLOCK))
  )
}

export const FACEBOOK_POSTS_RECOGNIZER: Recognizer = {
  id: 'facebook',
  label: 'Facebook posts (HTML export)',
  // Filename-anchored: several FB sections share the `_a6-g` block, so matching on
  // the block alone would mis-claim friends/comments/etc. The export filenames are
  // stable (`your_posts__…`).
  detect: (f) => isFbHtml(f) && /your_posts/i.test(f.name),
  parse: (f) => {
    const out: RecordInput[] = []
    // The first chunk before the first wrapper is the page header — drop it.
    const blocks = f.text.split(POST_BLOCK).slice(1)
    blocks.forEach((raw, idx) => {
      // Splitting on the class attribute leaves the tail of the wrapper's opening
      // tag (` aria-labelledby="…">`) at the front — drop up to its closing `>`.
      const close = raw.indexOf('>')
      const block = close >= 0 ? raw.slice(close + 1) : raw
      const when = parseFbDate(block)
      // The <h2> is the action ("Christopher D Ennis shared a link.").
      const h2 = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)
      const action = h2 ? textOf(h2[1]) : ''
      // Body = the post content: drop the <h2> action, the DYI permalink <footer>,
      // and the <section> metadata blocks (attachments, place/checkin ids, the
      // "Updated <date>" line), then strip tags + leftover date/"Updated" text.
      let rest = block
      if (h2) rest = rest.replace(h2[0], ' ')
      rest = rest
        .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<section\b[\s\S]*?<\/section>/gi, ' ')
      const body = textOf(rest)
        .replace(/<[a-z!/][^>]*>?/gi, ' ') // any tag fragment the strip left (unclosed/nested)
        .replace(FB_DATE, ' ')
        .replace(/\bUpdated\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)

      if (when == null && !action && !body) return // split noise / empty trailer
      const title = action || (body ? body.slice(0, 90) : 'Facebook post')
      out.push({
        source: 'facebook',
        type: 'post',
        occurredAt: when,
        title,
        body: body || undefined,
        naturalKey: `fb-post|${when ?? `i${idx}`}|${title.slice(0, 48)}`
      })
    })
    return out
  }
}

/**
 * Facebook friends — `connections/friends/your_friends.html`. Same `_a6-g` block
 * shape as posts, simpler: the `<h2>` is the friend's name and the footer date is
 * when you connected. One `connection` record per friend (matching LinkedIn's
 * `connection` type, so the kind filter groups them together).
 */
export const FACEBOOK_FRIENDS_RECOGNIZER: Recognizer = {
  id: 'facebook-friends',
  label: 'Facebook friends (HTML export)',
  detect: (f) => isFbHtml(f) && /your_friends/i.test(f.name),
  parse: (f) => {
    const out: RecordInput[] = []
    const blocks = f.text.split(POST_BLOCK).slice(1)
    for (const raw of blocks) {
      const close = raw.indexOf('>')
      const block = close >= 0 ? raw.slice(close + 1) : raw
      const h2 = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)
      const name = h2 ? textOf(h2[1]) : ''
      if (!name) continue
      const when = parseFbDate(block)
      out.push({
        source: 'facebook',
        type: 'connection',
        occurredAt: when,
        title: `Became friends with ${name}`,
        // Dedup by name (the friendship is the event); a name twice just dedupes.
        naturalKey: `fb-friend|${name}`
      })
    }
    return out
  }
}
