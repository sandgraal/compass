/**
 * Google Takeout — the HTML "My Activity" export. ONE recognizer covers every
 * `My Activity/<product>/MyActivity.html` plus the YouTube `watch-history.html` /
 * `search-history.html`, which all share Google's Material-Design template: a
 * repeating `<div class="outer-cell …">` with a `header-cell` (the product, e.g.
 * "YouTube"/"Search"/"Maps") and a `content-cell … body-1` holding the action
 * ("Watched …", "Searched for …", "Used Maps", "Viewed image …") plus a timestamp
 * like "Jun 23, 2026, 12:25:59 AM EDT".
 *
 * One timeline record per DATED cell, parsed from the date parts into the importing
 * machine's LOCAL time — the trailing TZ abbreviation is ignored, so the local
 * calendar day is preserved (same approach as the Facebook recognizer; a re-import
 * on a machine in a different timezone would shift the epoch ms / dedup hash).
 * Undated cells (some Android/“Used …” entries) are skipped. Brittle by nature:
 * Google's obfuscated mdl class names can change between export eras; detection is
 * structural (the `content-cell mdl-cell` + a Google-format date) so it never
 * collides with the Facebook `_a6-g` recognizers.
 */

import type { Recognizer, RecordInput } from './recognizers'

const OUTER_CELL = 'class="outer-cell'
const CONTENT_MARKER = 'content-cell mdl-cell'
/** "Jun 23, 2026, 12:25:59 AM EDT" → capture groups (TZ abbreviation ignored). The
 *  narrow no-break space Google puts before AM/PM is matched by `\s` (Unicode Zs). */
const GOOGLE_DATE = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s*([AP])M/
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
      // Bounds-check so String.fromCodePoint can't throw on a malformed entity.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
/** Strip tags, decode entities, collapse whitespace (incl. the narrow nbsp). */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse Google's "Mon DD, YYYY, h:mm:ss AM" into LOCAL epoch ms, or null. */
function parseGoogleDate(text: string): number | null {
  const m = text.match(GOOGLE_DATE)
  if (!m) return null
  const monthIdx = MONTHS.indexOf(m[1].toLowerCase())
  if (monthIdx < 0) return null
  let hour = Number(m[4]) % 12
  if (m[7] === 'P') hour += 12
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
 * Map a My Activity (product, action) to a timeline `type` so each lands under a
 * meaningful kind chip. YouTube carries both watch + search history under the same
 * "YouTube" header, so it's split on the action verb.
 */
function googleActivityType(product: string, action: string): string {
  const p = product.toLowerCase()
  const a = action.toLowerCase()
  if (/youtube/.test(p)) return /^searched/.test(a) ? 'search' : 'watch'
  if (/maps/.test(p)) return 'maps'
  if (/assistant|gemini|voice match|ai mode/.test(p)) return 'assistant'
  if (/android|play store/.test(p)) return 'app'
  if (/search|lens/.test(p)) return 'search'
  // Chrome (and some products) group activity by site, so the header is a domain,
  // not a product name — fall back to the action verb.
  if (/^watched\b/.test(a)) return 'watch'
  if (/^visited\b/.test(a)) return 'visit'
  if (/^searched\b/.test(a)) return 'search'
  if (/chrome/.test(p)) return 'visit'
  return 'activity'
}

/** A Google "My Activity" / YouTube-history HTML export, by its mdl template. */
function isGoogleActivityHtml(f: { ext: string; text: string }): boolean {
  return (
    (f.ext === 'html' || f.ext === 'htm') &&
    f.text.includes(CONTENT_MARKER) &&
    f.text.includes('mdl-typography--title')
  )
}

export const GOOGLE_ACTIVITY_RECOGNIZER: Recognizer = {
  id: 'google',
  label: 'Google My Activity (HTML export)',
  detect: (f) => isGoogleActivityHtml(f) && GOOGLE_DATE.test(f.text),
  parse: (f) => {
    const out: RecordInput[] = []
    // The first chunk before the first wrapper is the page header — drop it.
    for (const raw of f.text.split(OUTER_CELL).slice(1)) {
      const head = raw.match(/mdl-typography--title">([\s\S]*?)<\/p>/i)
      const product = head ? textOf(head[1]) : ''
      const cell = raw.match(/content-cell[^>]*body-1">([\s\S]*?)<\/div>/i)
      if (!cell) continue
      const text = textOf(cell[1]) // "Watched <title> <channel> Jun 23, 2026, 12:25:59 AM EDT"
      const dm = text.match(GOOGLE_DATE)
      const when = parseGoogleDate(text)
      if (dm?.index == null || when == null) continue // dated cells only
      const title = text.slice(0, dm.index).trim().slice(0, 200) || product || 'Google activity'
      const type = googleActivityType(product, title)
      out.push({
        source: 'google',
        type,
        occurredAt: when,
        title,
        body: product || undefined,
        naturalKey: `gact|${type}|${when}|${title.slice(0, 40)}`
      })
    }
    return out
  }
}
