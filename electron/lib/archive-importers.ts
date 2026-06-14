/**
 * Service data-export archive parsers (Phase 9.1 — "The Storehouse").
 *
 * Facebook and LinkedIn removed their friends/connections APIs years ago, so the
 * durable, local-first way to bring those people into Compass is each platform's
 * OFFICIAL data export — which is also the most "owned, never disappears" path.
 * These are pure string→contacts parsers, no network, no new dependency (they
 * reuse the in-house CSV parser), mirroring the hand-rolled vCard/ICS codecs.
 *
 * Sources covered:
 *   - LinkedIn  "Get a copy of your data" → `Connections.csv`
 *   - Facebook  "Download Your Information" → `friends.json` / `your_address_book…`
 *   - Google Voice  Google Takeout → `Voice/Calls/*.html` (hCard tel/fn markup)
 */

import { parseCSV } from './csv'

/**
 * Self-contained result shape. Structurally a subset of the IPC layer's
 * `ContactInput` (every field optional except `displayName`), so the contacts
 * handler can pass these straight to `upsertContacts` without a cast or a
 * lib→ipc type import.
 */
export interface ImportedContact {
  externalId: string
  displayName: string
  givenName?: string
  familyName?: string
  org?: string
  jobTitle?: string
  url?: string
  emails?: Array<{ value: string }>
  phones?: Array<{ value: string }>
  notes?: string
  relationship?: string
  source: string
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

/**
 * Parse a LinkedIn `Connections.csv`. The file ships with a 2–3 line "Notes:"
 * preamble before the real header row, so we skip everything up to the line that
 * starts with `First Name`. Columns: First Name, Last Name, URL, Email Address,
 * Company, Position, Connected On.
 */
export function parseLinkedInConnections(raw: string): ImportedContact[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const headerIdx = lines.findIndex((l) => /^"?First Name"?,/i.test(l.trim()))
  if (headerIdx === -1) return []
  const rows = parseCSV(lines.slice(headerIdx).join('\n'))

  const out: ImportedContact[] = []
  for (const row of rows) {
    const given = (row['First Name'] ?? '').trim()
    const family = (row['Last Name'] ?? '').trim()
    const company = (row.Company ?? '').trim()
    const displayName = [given, family].filter(Boolean).join(' ').trim() || company
    if (!displayName) continue
    const email = (row['Email Address'] ?? '').trim()
    const position = (row.Position ?? '').trim()
    const url = (row.URL ?? '').trim()
    const connectedOn = (row['Connected On'] ?? '').trim()
    // Prefer the LinkedIn profile URL as the stable per-person key; fall back to
    // a name+company composite so re-import dedupes.
    const key = url || `${displayName}|${company}`.toLowerCase()
    out.push({
      externalId: `linkedin:${key}`,
      displayName,
      givenName: given || undefined,
      familyName: family || undefined,
      org: company || undefined,
      jobTitle: position || undefined,
      url: url || undefined,
      emails: email ? [{ value: email }] : undefined,
      notes: connectedOn ? `LinkedIn connection since ${connectedOn}` : undefined,
      relationship: 'colleague',
      source: 'linkedin'
    })
  }
  return out
}

// ─── Facebook ─────────────────────────────────────────────────────────────────

interface FacebookFriend {
  name?: string
  timestamp?: number
}
interface FacebookAddressBookEntry {
  name?: string
  details?: Array<{ contact_point?: string }>
}

/**
 * Parse a Facebook "Download Your Information" export. Handles both the friends
 * list (`friends_v2`, name + timestamp only — FB exposes no contact details for
 * friends) and an uploaded address book (`address_book_v2`, which DOES carry
 * phone numbers). Accepts the parsed-file string for either shape.
 */
export function parseFacebookFriends(json: string): ImportedContact[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const root = (data ?? {}) as Record<string, unknown>
  const out: ImportedContact[] = []

  // friends_v2: [{ name, timestamp }]  (also tolerate a bare top-level array)
  const friends: FacebookFriend[] = Array.isArray(root.friends_v2)
    ? (root.friends_v2 as FacebookFriend[])
    : Array.isArray(data)
      ? (data as FacebookFriend[])
      : []
  for (const f of friends) {
    const name = (f?.name ?? '').trim()
    if (!name) continue
    const since =
      typeof f.timestamp === 'number'
        ? new Date(f.timestamp * 1000).toISOString().slice(0, 10)
        : undefined
    out.push({
      externalId: `facebook:${name.toLowerCase()}`,
      displayName: name,
      notes: since ? `Facebook friend since ${since}` : undefined,
      relationship: 'friend',
      source: 'facebook'
    })
  }

  // address_book_v2: { address_book: [{ name, details: [{ contact_point }] }] }
  const ab = root.address_book_v2 as { address_book?: FacebookAddressBookEntry[] } | undefined
  for (const entry of ab?.address_book ?? []) {
    const name = (entry?.name ?? '').trim()
    if (!name) continue
    const phones = (entry.details ?? [])
      .map((d) => (d?.contact_point ?? '').trim())
      .filter(Boolean)
      .map((value) => ({ value }))
    out.push({
      externalId: `facebook-ab:${name.toLowerCase()}|${phones[0]?.value ?? ''}`,
      displayName: name,
      phones: phones.length > 0 ? phones : undefined,
      source: 'facebook'
    })
  }

  return out
}

// ─── Google Voice ─────────────────────────────────────────────────────────────

/** Normalize a phone number to digits (keep a leading +) for dedup keys. */
function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  const plus = trimmed.startsWith('+') ? '+' : ''
  return plus + trimmed.replace(/[^\d]/g, '')
}

/**
 * Extract contacts from Google Voice Takeout conversation HTML. Each message
 * carries an hCard `<a class="tel" href="tel:+1…"><…class="fn">Name</…></a>`.
 * We collect unique numbers, preferring a non-empty display name; the file's
 * leading "Name - Text - date.html" segment is used as a fallback name hint.
 *
 * `files` is `{ name, content }[]` — the IPC handler reads the `Voice/Calls`
 * directory and passes the HTML strings here so this stays pure/testable.
 */
export function parseGoogleVoice(
  files: Array<{ name: string; content: string }>
): ImportedContact[] {
  const byNumber = new Map<string, { name: string; number: string }>()
  // tel href, then (optionally) the fn span/abbr text that follows.
  const telFn =
    /<a[^>]*class="[^"]*\btel\b[^"]*"[^>]*href="tel:([^"]+)"[^>]*>\s*(?:<[^>]*class="[^"]*\bfn\b[^"]*"[^>]*>([^<]*)<)?/gi

  for (const file of files) {
    const rawHint = file.name.split(/\s*[-_]\s*/)[0]?.trim() ?? ''
    // A filename that is just a number is no better than the number itself.
    const hint = /^\+?[\d\s()]+$/.test(rawHint) ? '' : rawHint
    telFn.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
    while ((m = telFn.exec(file.content)) !== null) {
      const number = normalizePhone(m[1] ?? '')
      if (!number || number.replace('+', '').length < 5) continue
      const fn = (m[2] ?? '').trim()
      // Best name wins: a real <fn> from the markup, then any name already seen
      // for this number, then the filename hint. A real fn always overrides.
      const bestName = fn || byNumber.get(number)?.name || hint || ''
      byNumber.set(number, { name: bestName, number })
    }
  }

  const out: ImportedContact[] = []
  for (const { name, number } of byNumber.values()) {
    out.push({
      externalId: `gvoice:${number}`,
      displayName: name || number,
      phones: [{ value: number }],
      source: 'gvoice'
    })
  }
  return out
}
