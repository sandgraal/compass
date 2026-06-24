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

import type { Recognizer, RecordInput, SnapshotFact, SnapshotRecognizer } from './recognizers'

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
      // Bounds-check so String.fromCodePoint can't throw on a malformed entity
      // (e.g. &#9999999999;) — it rejects non-integers, negatives, and > U+10FFFF.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m
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
    (f.ext === 'html' || f.ext === 'htm') &&
    // Signed by the DYI permalink, the `_a6-g` entry block, OR the obfuscated
    // table-cell class `_a6_q`/`_a6_r` (the table-format sections — e.g. Marketplace
    // — carry neither permalink nor `_a6-g`, only these cells).
    (FB_DYI.test(f.text) || f.text.includes(POST_BLOCK) || f.text.includes('_a6_'))
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
        // Dedup by (name, occurredAt) to reduce collisions for common names while staying stable on re-import.
        naturalKey: `fb-friend|${when ?? ''}|${name}`
      })
    }
    return out
  }
}

/**
 * Facebook comments — `comments_and_reactions/comments.html` (and the in-group
 * variants). Same `_a6-g` block: the `<h2>` is the context ("… commented on X's
 * post"), the `_a6-p` div is your comment text, the footer holds the date. Unlike
 * posts, we do NOT strip `<section>` blocks — a comment's text can live inside one.
 */
export const FACEBOOK_COMMENTS_RECOGNIZER: Recognizer = {
  id: 'facebook-comments',
  label: 'Facebook comments (HTML export)',
  detect: (f) => isFbHtml(f) && /comments/i.test(f.name),
  parse: (f) => {
    const out: RecordInput[] = []
    const blocks = f.text.split(POST_BLOCK).slice(1)
    blocks.forEach((raw, idx) => {
      const close = raw.indexOf('>')
      const block = close >= 0 ? raw.slice(close + 1) : raw
      const when = parseFbDate(block)
      const h2 = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)
      const action = h2 ? textOf(h2[1]) : ''
      // Body = the comment text: drop the <h2> + the footer (keep <section>), strip
      // tags + leftover tag fragments + the date.
      let rest = block
      if (h2) rest = rest.replace(h2[0], ' ')
      rest = rest.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
      const body = textOf(rest)
        .replace(/<[a-z!/][^>]*>?/gi, ' ')
        .replace(FB_DATE, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)

      if (when == null && !action && !body) return
      const title = action || (body ? `Comment: ${body.slice(0, 80)}` : 'Facebook comment')
      out.push({
        source: 'facebook',
        type: 'comment',
        occurredAt: when,
        title,
        body: body || undefined,
        naturalKey: `fb-comment|${when ?? `i${idx}`}|${(body || action).slice(0, 48)}`
      })
    })
    return out
  }
}

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Facebook messages — a conversation file (`messages/**​/message_N.html`). Detected
 * by the stable `message_<n>.html` filename + the `_a6-g` message blocks.
 * Aggregated to **content-light daily counts** ("N messages with X" per local day),
 * exactly like the iMessage recognizer — the message TEXT is never stored.
 *
 * The conversation label comes from the `<title>`: usually the other party's name
 * directly ("Yamilette Espinoza Aparicio"), or a "Participants: X and <you>" list
 * for archived/special threads (then we drop the trailing self).
 */
export const FACEBOOK_MESSAGES_RECOGNIZER: Recognizer = {
  id: 'facebook-messages',
  label: 'Facebook messages (HTML export)',
  detect: (f) => isFbHtml(f) && /message_\d/i.test(f.name),
  parse: (f) => {
    const titleM = f.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const rawTitle = titleM ? textOf(titleM[1]) : ''
    let conversation: string
    if (/^Participants:/i.test(rawTitle)) {
      // Participant list — drop "Participants:" and the trailing self.
      const parts = rawTitle.replace(/^Participants:\s*/i, '').split(/\s+and\s+/)
      conversation = (parts.length > 1 ? parts.slice(0, -1).join(' and ') : parts[0]) || ''
    } else {
      conversation = rawTitle // the <title> is the other party's name directly
    }
    conversation = conversation || 'a conversation'

    // Count messages per LOCAL day — content-light, no message text retained.
    const perDay = new Map<string, number>()
    for (const raw of f.text.split(POST_BLOCK).slice(1)) {
      const when = parseFbDate(raw)
      if (when == null) continue
      const day = localDay(when)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }

    const out: RecordInput[] = []
    for (const [day, count] of perDay) {
      out.push({
        source: 'facebook',
        type: 'messages',
        occurredAt: new Date(`${day}T00:00:00`).getTime(), // local midnight
        title: `${count} message${count === 1 ? '' : 's'} with ${conversation}`,
        naturalKey: `fb-msg|${day}|${conversation}`
      })
    }
    return out
  }
}

/**
 * Map an FB export filename to a timeline `type`, so the catch-all activity
 * recognizer lands each section under a meaningful kind chip. Order matters:
 * `liked_pages` contains "like", so the page check runs BEFORE the reaction one.
 */
function fbActivityType(name: string): string {
  const n = name.toLowerCase()
  if (/liked_pages|\bpages?\b|page_/.test(n)) return 'page'
  if (/react|\blike/.test(n)) return 'reaction'
  if (/photo|video|album/.test(n)) return 'post'
  if (/group/.test(n)) return 'group'
  if (/event/.test(n)) return 'event'
  if (/marketplace|buyer|seller/.test(n)) return 'marketplace'
  if (/saved|save_/.test(n)) return 'saved'
  if (/search/.test(n)) return 'search'
  if (/poll/.test(n)) return 'poll'
  if (/payment|purchase|order/.test(n)) return 'payment'
  if (/fundrais|donation/.test(n)) return 'fundraiser'
  if (/location|sampled_location/.test(n)) return 'location'
  // `\bads?_` (word-anchored) avoids matching the "ad_a" inside "had_a_buyer".
  if (/off_meta|off_facebook|activity_off|apps_and_websites|advertis|\bads?_/.test(n)) {
    return 'off-facebook'
  }
  if (
    /login|logout|logged_in|logged_out|session|device|ip_address|cookie|two-factor|security|account_activity/.test(
      n
    )
  ) {
    return 'security'
  }
  return 'activity'
}

/** A Facebook date opening a `<td>` cell — the signature of the table-format
 * sections (logins, devices, marketplace, interactions, off-Meta, …), as opposed
 * to the `_a6-g` activity blocks (where the date sits in a `<footer>` `<div>`). */
const TD_DATE = /<td[^>]*>\s*[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2}\s*[ap]m/i
const TABLE_BLOCK = /<table\b[\s\S]*?<\/table>/gi
const TABLE_ROW = /<tr\b[\s\S]*?<\/tr>/gi
const TABLE_CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gi
/** Labels worth promoting to a record title (a name/place/thing, not a flag). */
const TITLE_LABELS =
  /name|title|product|item|app|website|domain|advertiser|location|device|query|search|url|event|page|group|subject|recipient|sender|seller|merchant|description/i
const DATE_LABEL = /time|created|updated|\bdate\b/i
const FLAG_VALUE = /^(empty|true|false|n\/a|none|null)$/i

/** "where_you're_logged_in.html" → "Where you're logged in". */
function humanizeFbName(name: string): string {
  return (
    name
      .replace(/\.html?$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (c) => c.toUpperCase()) || 'Facebook record'
  )
}

/** Extract (label, value) pairs from one `<table>` block. Two-cell rows are
 * label/value; single (colspan) cells are "Label<div>value</div>". */
function parseFbTableRows(table: string): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  for (const tr of table.match(TABLE_ROW) ?? []) {
    const tds = [...tr.matchAll(TABLE_CELL)].map((m) => m[1])
    if (tds.length === 0) continue
    if (tds.length >= 2) {
      rows.push([textOf(tds[0]), textOf(tds.slice(1).join(' '))])
    } else {
      const div = tds[0].match(/^([\s\S]*?)<div\b[^>]*>([\s\S]*)<\/div>\s*$/i)
      if (div) rows.push([textOf(div[1]), textOf(div[2])])
      else rows.push(['', textOf(tds[0])])
    }
  }
  return rows
}

function fbTableTitle(rows: Array<[string, string]>, fallback: string): string {
  const usable = ([label, value]: [string, string]) =>
    value && !FLAG_VALUE.test(value) && !FB_DATE.test(value) && !DATE_LABEL.test(label)
  // Prefer a name/place/thing field; otherwise the first meaningful value.
  const titled = rows.find((r) => usable(r) && TITLE_LABELS.test(r[0]))
  const first = titled ?? rows.find(usable)
  return (first ? first[1] : fallback).slice(0, 120)
}

/**
 * Facebook table sections — the parts of the DYI export whose records are laid
 * out as `<table>` key/value blocks rather than `_a6-g` activity blocks: login
 * sessions & recognized devices, Marketplace conversations, off-Meta activity,
 * feed/ad interactions, dated profile fields, and more. Each dated `<table>` (one
 * with a `<td>` timestamp) becomes one record; the salient field is the title and
 * every field is kept in the body. Undated config tables (pure settings/snapshots)
 * are skipped here and surfaced on a dedicated page instead. Registered BEFORE the
 * `_a6-g` catch-all; its `<td>`-date detect never matches a genuine activity file.
 */
export const FACEBOOK_TABLE_RECOGNIZER: Recognizer = {
  id: 'facebook-table',
  label: 'Facebook records (HTML export, table format)',
  detect: (f) => isFbHtml(f) && TD_DATE.test(f.text),
  parse: (f) => {
    const type = fbActivityType(f.name)
    const fallback = humanizeFbName(f.name)
    const out: RecordInput[] = []
    for (const table of f.text.match(TABLE_BLOCK) ?? []) {
      const when = parseFbDate(table)
      if (when == null) continue // dated tables only — config snapshots go to a page
      const rows = parseFbTableRows(table)
      const title = fbTableTitle(rows, fallback)
      const body =
        rows
          .filter(([, v]) => v && !FB_DATE.test(v))
          .map(([l, v]) => (l ? `${l}: ${v}` : v))
          .join(' · ')
          .slice(0, 1500) || undefined
      out.push({
        source: 'facebook',
        type,
        occurredAt: when,
        title,
        body,
        naturalKey: `fb-tbl|${type}|${when}|${title.slice(0, 40)}`
      })
    }
    return out
  }
}

/** Pull FB's repeated list items — the `_a6-p` content divs — out of a section. */
function fbListItems(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<div\b[^>]*class="[^"]*_a6-p[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const v = textOf(m[1])
    if (v) out.push(v)
  }
  return out
}

/**
 * Facebook ad profile — the NON-timeline "how advertisers see you" snapshot, fed to
 * the dedicated Ad Profile page (not the records timeline). Two of the export's
 * eye-opener files: the advertisers that uploaded/used your info
 * (`advertisers_using_your_activity_or_information.html` — often thousands) and the
 * targeting categories Meta inferred about you (`other_categories_used_to_reach_you.html`).
 * Each list item becomes one `snapshot_fact` under category `ad-profile`, sub-grouped
 * by `label` (Advertiser / Category).
 */
export const FACEBOOK_AD_PROFILE_RECOGNIZER: SnapshotRecognizer = {
  id: 'facebook-ad-profile',
  label: 'Facebook ad profile (HTML export)',
  detect: (f) =>
    isFbHtml(f) &&
    /advertisers_using_your_activity|other_categories_used_to_reach_you/i.test(f.name),
  parse: (f) => {
    const label = /other_categories_used_to_reach_you/i.test(f.name) ? 'Category' : 'Advertiser'
    const out: SnapshotFact[] = []
    let position = 0
    for (const value of fbListItems(f.text)) {
      out.push({
        source: 'facebook',
        category: 'ad-profile',
        label,
        value,
        position: position++,
        naturalKey: `${label}|${value}`
      })
    }
    return out
  }
}

/**
 * Facebook profile identity — `personal_information/profile_information/profile_information.html`.
 * Unlike the rest of the export this section is a `<th>Label</th><td>value</td>`
 * table: Name, Username, Profile URL, Registration date, Emails, Phones, Birthday,
 * Gender, Family, etc. Each row becomes one `snapshot_fact` under category `profile`
 * (the dedicated Profile page), with `<li>` lists (emails/phones) flattened. Static
 * identity, not timeline events.
 */
export const FACEBOOK_PROFILE_RECOGNIZER: SnapshotRecognizer = {
  id: 'facebook-profile',
  label: 'Facebook profile information (HTML export)',
  detect: (f) => isFbHtml(f) && /profile_information/i.test(f.name),
  parse: (f) => {
    const out: SnapshotFact[] = []
    let position = 0
    for (const tr of f.text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const th = tr.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)
      const td = tr.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)
      if (!th || !td) continue
      const label = textOf(th[1])
      // Flatten `<li>` lists (Emails/Phones) to "; "-joined; else collapse to text.
      // Drop empty `<li>` entries so we never produce "; b@example.com" or a
      // whitespace-only value that should have been skipped.
      const lis = [...td[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => textOf(m[1]))
        .filter(Boolean)
      const value = lis.length ? lis.join('; ') : textOf(td[1])
      if (!label || !value) continue
      out.push({
        source: 'facebook',
        category: 'profile',
        label,
        value,
        position: position++,
        naturalKey: `${label}|${value}`
      })
    }
    return out
  }
}

/**
 * Catch-all Facebook recognizer — claims ANY FB DYI HTML the specific recognizers
 * (posts/friends/comments/messages) didn't, emitting one timeline record per
 * **dated** `_a6-g` block. Undated blocks are skipped: a pure snapshot/list file
 * (e.g. your ad-interest categories) produces nothing here and is surfaced via a
 * dedicated page instead. The `type` is derived from the filename so reactions,
 * groups, events, marketplace, searches, off-Facebook activity, etc. each land
 * under their own kind chip. Registered LAST among the FB recognizers.
 */
export const FACEBOOK_ACTIVITY_RECOGNIZER: Recognizer = {
  id: 'facebook-activity',
  label: 'Facebook activity (HTML export)',
  detect: (f) => isFbHtml(f) && f.text.includes(POST_BLOCK),
  parse: (f) => {
    const type = fbActivityType(f.name)
    const out: RecordInput[] = []
    for (const raw of f.text.split(POST_BLOCK).slice(1)) {
      const close = raw.indexOf('>')
      const block = close >= 0 ? raw.slice(close + 1) : raw
      const when = parseFbDate(block)
      if (when == null) continue // dated events only — undated snapshots go to a page
      const h2 = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)
      const action = h2 ? textOf(h2[1]) : ''
      let rest = block
      if (h2) rest = rest.replace(h2[0], ' ')
      rest = rest.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
      const body = textOf(rest)
        .replace(/<[a-z!/][^>]*>?/gi, ' ')
        .replace(FB_DATE, ' ')
        .replace(/\bUpdated\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000)
      const title = action || (body ? body.slice(0, 90) : 'Facebook activity')
      out.push({
        source: 'facebook',
        type,
        occurredAt: when,
        title,
        body: body || undefined,
        naturalKey: `fb-act|${type}|${when}|${title.slice(0, 40)}`
      })
    }
    return out
  }
}
