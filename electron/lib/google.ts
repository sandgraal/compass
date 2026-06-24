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

import { parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput, SnapshotFact, SnapshotRecognizer } from './recognizers'

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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Best-effort hostname for a URL (body context); returns '' if unparseable. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ── Chrome history (Takeout `Chrome/History.json`) ────────────────────────────
// JSON `{ "Browser History": [{ title, url, time_usec }] }`. `time_usec` is
// microseconds since the Unix epoch (Takeout-normalized — unlike the native SQLite
// `History` db, which counts from 1601). Emitted under the shared `browser` source
// so Takeout + live-DB history sit on one timeline chip.
type ChromeRow = { title?: string; url?: string; time_usec?: number }
export const GOOGLE_CHROME_RECOGNIZER: Recognizer = {
  id: 'chrome-takeout',
  label: 'Chrome history (Takeout JSON)',
  detect: (f) => {
    if (f.ext !== 'json' || !f.text.includes('Browser History')) return false
    const v = safeJson(f.text) as { 'Browser History'?: unknown }
    return Array.isArray(v?.['Browser History'])
  },
  parse: (f) => {
    const rows =
      (safeJson(f.text) as { 'Browser History'?: ChromeRow[] })?.['Browser History'] ?? []
    const out: RecordInput[] = []
    for (const r of rows) {
      const url = r.url ?? ''
      if (!url) continue
      const when = typeof r.time_usec === 'number' ? Math.round(r.time_usec / 1000) : null
      out.push({
        source: 'browser',
        type: 'visit',
        occurredAt: when,
        title: r.title?.trim() || url,
        body: hostname(url) || undefined,
        naturalKey: `${url}|${r.time_usec ?? ''}`
      })
    }
    return out
  }
}

// ── Google Play Store purchases (`Google Play Store/Purchase History.json`) ────
// JSON array of `{ purchaseHistory: { doc: { title }, invoicePrice, purchaseTime } }`.
type PlayRow = {
  purchaseHistory?: {
    doc?: { title?: string; documentType?: string }
    invoicePrice?: string
    purchaseTime?: string
  }
}
export const GOOGLE_PLAY_RECOGNIZER: Recognizer = {
  id: 'google-play',
  label: 'Google Play purchases (Takeout JSON)',
  // Validate the JSON shape (not just substrings) so we never claim an unrelated
  // Takeout JSON and then return [] — which would starve the generic recognizer.
  detect: (f) => {
    if (f.ext !== 'json' || !f.text.includes('purchaseHistory')) return false
    const v = safeJson(f.text)
    return Array.isArray(v) && typeof (v[0] as PlayRow)?.purchaseHistory?.purchaseTime === 'string'
  },
  parse: (f) => {
    const rows = safeJson(f.text)
    if (!Array.isArray(rows)) return []
    const out: RecordInput[] = []
    for (const row of rows as PlayRow[]) {
      const ph = row.purchaseHistory
      const title = ph?.doc?.title
      const when = ph?.purchaseTime ? Date.parse(ph.purchaseTime) : Number.NaN
      if (!title) continue
      const price = ph?.invoicePrice
      out.push({
        source: 'google-play',
        type: 'purchase',
        occurredAt: Number.isNaN(when) ? null : when,
        title,
        body: [ph?.doc?.documentType, price].filter(Boolean).join(' · ') || undefined,
        naturalKey: `gplay|${ph?.purchaseTime ?? ''}|${title}`
      })
    }
    return out
  }
}

// ── Google Pay transactions (`Google Pay/.../transactions_*.csv`) ─────────────
// CSV: Time, Transaction ID, Description, Product, Payment method, Status, Amount.
export const GOOGLE_PAY_RECOGNIZER: Recognizer = {
  id: 'google-pay',
  label: 'Google Pay transactions (Takeout CSV)',
  // Inspect only the header line (O(header), not O(file)) — like the other CSV recognizers.
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const nl = f.text.indexOf('\n')
    const header = nl === -1 ? f.text : f.text.slice(0, nl)
    return /(^|,)\s*"?Transaction ID"?\s*,/i.test(header) && /(^|,)\s*"?Amount"?/i.test(header)
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const r of parseCSV(f.text)) {
      const desc = r.Description ?? r.description ?? ''
      const time = r.Time ?? r.time ?? ''
      if (!desc && !time) continue
      const amount = r.Amount ?? r.amount ?? ''
      const status = r.Status ?? r.status ?? ''
      out.push({
        source: 'google-pay',
        type: 'payment',
        occurredAt: parseWhen(time),
        title: desc || '(transaction)',
        body: [amount, status].filter(Boolean).join(' · ') || undefined,
        payload: r,
        naturalKey: r['Transaction ID'] || `${time}|${desc}`
      })
    }
    return out
  }
}

// ── Google Calendar (`Calendar/*.ics`) ────────────────────────────────────────
// iCalendar VEVENTs — historical calendars (distinct from the live OAuth sync).
const ICS_DATE = /^DTSTART[^:]*:(\d{8})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/m
/** Unescape RFC 5545 text (\, \; \n \\). */
function unescapeIcs(s: string): string {
  return s
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
}
/** Parse a VEVENT's DTSTART to epoch ms, or null. A trailing `Z` is UTC; `TZID=` and
 *  date-only values are taken as local (parts) — same convention as the rest of the
 *  Google recognizers. */
function parseIcsDate(vevent: string): number | null {
  const m = vevent.match(ICS_DATE)
  if (!m) return null
  const y = Number(m[1].slice(0, 4))
  const mo = Number(m[1].slice(4, 6)) - 1
  const d = Number(m[1].slice(6, 8))
  const hh = Number(m[2] ?? 0)
  const mm = Number(m[3] ?? 0)
  const ss = Number(m[4] ?? 0)
  const t = m[5] === 'Z' ? Date.UTC(y, mo, d, hh, mm, ss) : new Date(y, mo, d, hh, mm, ss).getTime()
  return Number.isNaN(t) ? null : t
}
export const GOOGLE_CALENDAR_RECOGNIZER: Recognizer = {
  id: 'gcal',
  label: 'Google Calendar (.ics)',
  detect: (f) => f.ext === 'ics' || f.text.startsWith('BEGIN:VCALENDAR'),
  parse: (f) => {
    // Unfold RFC 5545 continuation lines (a line break followed by space/tab).
    const text = f.text.replace(/\r?\n[ \t]/g, '')
    const out: RecordInput[] = []
    for (const m of text.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
      const ve = m[1]
      const when = parseIcsDate(ve)
      if (when == null) continue // dated events only
      const sum = ve.match(/^SUMMARY[^:]*:(.*)$/m)
      const loc = ve.match(/^LOCATION[^:]*:(.*)$/m)
      const uid = ve.match(/^UID[^:]*:(.*)$/m)
      const title = sum ? unescapeIcs(sum[1]) : '(event)'
      const location = loc ? unescapeIcs(loc[1]) : ''
      out.push({
        source: 'gcal',
        type: 'event',
        occurredAt: when,
        title: title || '(event)',
        body: location || undefined,
        naturalKey: uid ? `${unescapeIcs(uid[1])}|${when}` : `${when}|${title.slice(0, 40)}`
      })
    }
    return out
  }
}

// ── Google Fit daily activity (`Fit/Daily activity metrics/…csv`) ─────────────
// Two shapes: the aggregate `Daily activity metrics.csv` (one row per day, a `Date`
// column) and the per-day `YYYY-MM-DD.csv` files (15-min segments, date in the
// filename). Both collapse to ONE content-light daily record (steps · kcal · km ·
// move-min), deduped by `gfit|<day>`.
const FIT_DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.csv$/i
function fitNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function fitRecord(
  day: string,
  steps: number,
  kcal: number,
  dist: number,
  move: number
): RecordInput {
  const parts = [
    steps ? `${Math.round(steps)} steps` : '',
    kcal ? `${Math.round(kcal)} kcal` : '',
    dist ? `${(dist / 1000).toFixed(1)} km` : '',
    move ? `${Math.round(move)} move min` : ''
  ].filter(Boolean)
  const when = parseWhen(day)
  return {
    source: 'google-fit',
    type: 'fitness',
    occurredAt: when,
    title: parts[0] || 'Activity',
    body: parts.slice(1).join(' · ') || undefined,
    naturalKey: `gfit|${day}`
  }
}
export const GOOGLE_FIT_RECOGNIZER: Recognizer = {
  id: 'google-fit',
  label: 'Google Fit daily activity (Takeout CSV)',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const nl = f.text.indexOf('\n')
    const header = nl === -1 ? f.text : f.text.slice(0, nl)
    return /Move Minutes count/i.test(header) && /Step count/i.test(header)
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const out: RecordInput[] = []
    if ('Date' in rows[0]) {
      // Aggregate file — one row per day, already totaled.
      for (const r of rows) {
        const day = String(r.Date ?? '')
        if (!day) continue
        out.push(
          fitRecord(
            day,
            fitNum(r['Step count']),
            fitNum(r['Calories (kcal)']),
            fitNum(r['Distance (m)']),
            fitNum(r['Move Minutes count'])
          )
        )
      }
    } else {
      // Per-day file — sum the 15-min segments; the day is the filename.
      const m = f.name.match(FIT_DATE_FILE)
      if (!m) return []
      let steps = 0
      let kcal = 0
      let dist = 0
      let move = 0
      for (const r of rows) {
        steps += fitNum(r['Step count'])
        kcal += fitNum(r['Calories (kcal)'])
        dist += fitNum(r['Distance (m)'])
        move += fitNum(r['Move Minutes count'])
      }
      out.push(fitRecord(m[1], steps, kcal, dist, move))
    }
    return out
  }
}

// ── Google Voice calls & texts (`Voice/Calls/<contact> - <Type> - <ISO>Z.html`) ─
// CONTENT-LIGHT: the contact, kind, and timestamp all live in the FILENAME — the
// message text / call audio is never read. One dated record per call/text/voicemail.
const VOICE_FILE =
  /^(.+?) - (Text|Placed|Received|Missed|Voicemail|Recorded) - (\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}Z)\.html?$/i
function voiceKind(label: string): { type: string; verb: string } {
  switch (label.toLowerCase()) {
    case 'text':
      return { type: 'text', verb: 'Text with' }
    case 'voicemail':
      return { type: 'voicemail', verb: 'Voicemail from' }
    case 'missed':
      return { type: 'call', verb: 'Missed call from' }
    case 'placed':
      return { type: 'call', verb: 'Call to' }
    default: // received / recorded
      return { type: 'call', verb: 'Call from' }
  }
}
export const GOOGLE_VOICE_RECOGNIZER: Recognizer = {
  id: 'google-voice',
  label: 'Google Voice calls & texts (Takeout HTML)',
  detect: (f) => (f.ext === 'html' || f.ext === 'htm') && VOICE_FILE.test(f.name),
  parse: (f) => {
    const m = f.name.match(VOICE_FILE)
    if (!m) return []
    const contact = m[1].trim() || 'unknown'
    const { type, verb } = voiceKind(m[2])
    const when = Date.parse(m[3].replace(/_/g, ':')) // 2026-06-23T02_10_31Z → ISO
    return [
      {
        source: 'google-voice',
        type,
        occurredAt: Number.isNaN(when) ? null : when,
        title: `${verb} ${contact}`,
        body: m[2],
        // Key on kind + timestamp only (NOT the contact label) so a re-export with
        // renamed/merged contacts still dedupes to the same record.
        naturalKey: `gvoice|${m[2]}|${m[3]}`
      }
    ]
  }
}

// ── Snapshot recognizers — the static "Saved" lists → the Google Saved page ────
// Non-timeline facts (category `google-saved`), grouped by `label`.

// YouTube subscriptions (`YouTube and YouTube Music/subscriptions/subscriptions.csv`):
// CSV `Channel Id, Channel Url, Channel Title`.
export const GOOGLE_SUBSCRIPTIONS_RECOGNIZER: SnapshotRecognizer = {
  id: 'google-subscriptions',
  label: 'YouTube subscriptions (Takeout CSV)',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const nl = f.text.indexOf('\n')
    return /Channel (Id|Title)/i.test(nl === -1 ? f.text : f.text.slice(0, nl))
  },
  parse: (f) => {
    const out: SnapshotFact[] = []
    let position = 0
    for (const r of parseCSV(f.text)) {
      const title = (r['Channel Title'] ?? r['Channel title'] ?? '').trim()
      if (!title) continue
      out.push({
        source: 'google',
        category: 'google-saved',
        label: 'YouTube subscription',
        value: title,
        position: position++,
        naturalKey: `YouTube subscription|${title}`
      })
    }
    return out
  }
}

// Chrome bookmarks (`Chrome/Bookmarks.html` — Netscape bookmark file). Each `<A>` is
// a saved page; the value is the title.
export const GOOGLE_BOOKMARKS_RECOGNIZER: SnapshotRecognizer = {
  id: 'google-bookmarks',
  label: 'Chrome bookmarks (Takeout HTML)',
  detect: (f) =>
    (f.ext === 'html' || f.ext === 'htm') && /NETSCAPE-Bookmark-file/i.test(f.text.slice(0, 200)),
  parse: (f) => {
    const out: SnapshotFact[] = []
    let position = 0
    for (const m of f.text.matchAll(/<A\b[^>]*HREF="[^"]*"[^>]*>([\s\S]*?)<\/A>/gi)) {
      const value = textOf(m[1])
      if (!value) continue
      out.push({
        source: 'google',
        category: 'google-saved',
        label: 'Bookmark',
        value,
        position: position++,
        naturalKey: `Bookmark|${value}`
      })
    }
    return out
  }
}
