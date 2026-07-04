/**
 * People — the "Connect" track (Phase 10.7).
 *
 * Derives a directory of the actual people across your timeline and collapses the
 * SAME person seen through different sources into one entry — a LinkedIn connection
 * who's also a Facebook friend becomes a single person with two source touchpoints.
 *
 * Pure + derived: no schema change, no stored links. Two kinds of source: the
 * social graph (LinkedIn/Facebook connections — titles that unambiguously name a
 * person) and the noisier counterparties (PayPal payees, message conversation
 * partners) which are passed through `isLikelyPerson` to drop merchants /
 * newsletters / groups / phone numbers. Each is matched to your `contacts` by
 * normalized display name. Recomputed on demand, like the timeline stats/facets.
 */

export interface PersonSourceRow {
  source: string
  type: string
  title: string
  occurredAt: number | null
}

export interface ContactRow {
  id: number
  displayName: string
}

export interface Person {
  /** Canonical display name (the most frequent original casing seen). */
  name: string
  /** Normalized match key (lowercased, whitespace-collapsed). */
  key: string
  /** Total record touchpoints. */
  count: number
  /** Distinct sources this person appears through (e.g. ['facebook','linkedin']). */
  sources: string[]
  firstSeen: number | null
  lastSeen: number | null
  /** Matched `contacts.id` when this person is already in your address book, else null. */
  contactId: number | null
}

/** Normalize a name for matching: lowercase, collapse internal whitespace, trim. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

function capture(title: string, re: RegExp): string | null {
  const m = title.match(re)
  return m ? m[1].trim() : null
}

/**
 * Best-effort person name from an email "From" value — a `"Display Name <addr>"`
 * header or a bare address. Returns the display name when present, else a
 * humanized `first.last`/`first_last` local part, else null. The CALLER still gates
 * the result through `isLikelyPerson` (this only extracts a candidate) — so brands
 * with a display name ("GitHub") are filtered downstream, and single-token local
 * parts ("noreply", "billing") never produce a name here.
 */
export function parseEmailSender(from: string): string | null {
  const full = (from ?? '').trim()
  if (!full) return null
  const angle = full.match(/^(.+?)\s*<([^>]+)>$/)
  if (angle) {
    const display = angle[1]
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim()
    if (display && !display.includes('@')) return display
    return humanizeLocalPart(angle[2])
  }
  if (full.includes('@')) return humanizeLocalPart(full)
  return full // already a bare name
}

/**
 * Turn a `first.last` / `first_last` / `first-last` handle (email local part or a
 * GitHub login) into "First Last", or null when it isn't a delimited multi-part
 * alphabetic handle (so single-token handles like "sandgraal" / "noreply" → null).
 */
export function humanizeHandle(handle: string): string | null {
  const parts = handle.split(/[._-]/).filter(Boolean)
  if (parts.length < 2 || !parts.every((p) => /^[a-z]+$/i.test(p))) return null
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ')
}

/** Humanize an email local part (drops the domain first). */
function humanizeLocalPart(email: string): string | null {
  return humanizeHandle(email.split('@')[0])
}

// Machine senders: no-reply mailers, role aliases, bulk-mail subdomains, and
// "Brand via LinkedIn"-style forwards. Real people almost never send from these.
// Matched as a whole `.-_`-delimited local-part segment so "googlealerts-noreply"
// and "newsletters-noreply" are caught, while a real "jane.alerts" is not.
const AUTOMATION_TOKENS = new Set([
  'noreply',
  'donotreply',
  'newsletter',
  'newsletters',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'mailer',
  'mailings',
  'bounce',
  'bounces',
  'updates',
  'update',
  'security',
  'support',
  'info',
  'hello',
  'team',
  'billing',
  'member',
  'members',
  'account',
  'marketing',
  'sales',
  'contact',
  'admin',
  'mail',
  'email'
])
const AUTOMATION_SUBDOMAIN =
  /@(?:mail|email|mailer|mc|em|member|members|updates|notification|notifications|news|newsletter|marketing|reply|bounce|alert|alerts)\./i

/**
 * Does this "From" value look like an automated / bulk sender rather than a human?
 * Catches no-reply + role-alias local parts (anywhere in the local, segment-wise),
 * bulk-mail subdomains (`member.`, `mail.`, `mc.`…), and "X via LinkedIn" newsletter
 * forwards. Used to keep the People directory clean when projecting Gmail senders.
 */
export function isAutomatedSender(from: string): boolean {
  if (/\bvia\s+\w/i.test(from)) return true // "Snowflake via LinkedIn"
  const angle = from.match(/<([^>]+)>/)
  const bare = from.match(/([^\s<]+@[^\s>]+)/)
  const email = (angle ? angle[1] : bare ? bare[1] : '').toLowerCase().trim()
  if (!email.includes('@')) return false
  const [local, domain] = email.split('@')
  // no-reply / do-not-reply, whether delimited ("no-reply", "no.reply") or not
  // ("donotreply") — matched on the delimiter-COLLAPSED local anchored at the start,
  // so "honoreply" (no leading boundary) is NOT flagged.
  if (/^(?:no|donot)reply/.test(local.replace(/[._-]+/g, ''))) return true
  // Role aliases / bulk tokens as whole `.-_`-delimited local segments.
  if (local.split(/[._-]+/).some((seg) => AUTOMATION_TOKENS.has(seg))) return true
  if (AUTOMATION_SUBDOMAIN.test(`@${domain}.`)) return true
  return false
}

// ── Person vs. merchant classifier ───────────────────────────────────────────
// The financial / messaging counterparties (PayPal payees, conversation labels)
// are a MIX of real people and merchants / newsletters / phone numbers / groups.
// This keeps the high-volume noise out of the People directory. Best-effort and
// conservative: a few stray merchants are tolerable; the social-graph sources
// (LinkedIn/Facebook connections) bypass it entirely since they're always people.

const CORP_SUFFIX =
  /\b(inc|llc|ltd|co|corp|corporation|company|gmbh|plc|srl|pllc|lp|llp|technologies|payments|services|solutions|systems|store|shop|market|media|group|holdings|enterprises|bank|insurance|foundation|fund)\b/i

const KNOWN_MERCHANTS = new Set([
  'netflix',
  'amazon',
  'uber',
  'lyft',
  'spotify',
  'paypal',
  'google',
  'apple',
  'ebay',
  'walmart',
  'target',
  'doordash',
  'grubhub',
  'instacart',
  'venmo',
  'cash app',
  'airbnb',
  'steam',
  'microsoft',
  'meta',
  'facebook',
  'starbucks',
  'whole foods',
  'best buy',
  'ikea',
  'etsy',
  'shopify',
  'stripe',
  'square',
  'patreon',
  'twitch',
  'youtube',
  'hulu',
  'disney'
])

/**
 * Heuristic: does this counterparty/conversation label look like a PERSON (vs a
 * merchant, newsletter, group thread, or phone number)? Permissive on real names
 * (keeps single first-name contacts like "Mom"), strict on the obvious non-people.
 */
export function isLikelyPerson(raw: string): boolean {
  const name = raw.trim()
  if (name.length < 2) return false
  if (KNOWN_MERCHANTS.has(normalizeName(name))) return false // normalize so "Cash  App" still matches
  if (/\d/.test(name)) return false // digits → handle / phone / order / SKU
  if (/[,&/|]| and /i.test(name)) return false // group thread / "Alice and Bob"
  if (/\.(com|net|org|io|co|app|gov)\b/i.test(name)) return false // a domain
  if (CORP_SUFFIX.test(name)) return false
  // Multi-word ALL-CAPS reads like a merchant ("ACME CORP"); a single all-caps token
  // could be a name typed in caps, so only reject the multi-word case.
  if (name === name.toUpperCase() && /\s/.test(name)) return false
  return true
}

/**
 * Pull the person's name out of a people-bearing record title, or null if the
 * record doesn't name a person. The social-graph titles (LinkedIn/Facebook
 * connections) are unambiguous; the financial/messaging counterparties are passed
 * through `isLikelyPerson` to drop merchants / newsletters / groups / phone numbers.
 */
export function extractPersonName(source: string, type: string, title: string): string | null {
  const t = title.trim()
  // Conversation partners (iMessage / Facebook / LinkedIn messages) — "N messages
  // with X" or "N messages — X"; LinkedIn labels can be "Chat with X".
  if (type === 'messages') {
    const m = t.match(/^\d+\s+messages?\s+(?:with\s+|—\s+)(.+)$/i)
    if (!m) return null
    const label = m[1]
      .trim()
      .replace(/^chat with\s+/i, '')
      .trim()
    return isLikelyPerson(label) ? label : null
  }
  if (source === 'linkedin') {
    if (type === 'connection') return capture(t, /^Connected with (.+)$/)
    if (type === 'invitation') {
      return capture(t, /^Invited (.+)$/) ?? capture(t, /^Invitation from (.+)$/)
    }
    if (type === 'recommendation') {
      return capture(t, /^Recommended (.+)$/) ?? capture(t, /^Recommendation from (.+)$/)
    }
    if (type === 'endorsement') return capture(t, /^(.+?) endorsed you for /)
    return null
  }
  if (source === 'facebook' && type === 'connection') {
    return capture(t, /^Became friends with (.+)$/)
  }
  // PayPal payees — the title is the counterparty name, EXCEPT when the recognizer
  // fell back to its generic placeholder (Name/Item/Type all empty); keep it only if
  // it's a real person.
  if (source === 'paypal' && type === 'payment') {
    if (t === 'PayPal transaction') return null
    return isLikelyPerson(t) ? t : null
  }
  return null
}

/** (source, type) pairs whose titles name a person — used to scope the DB read. */
export const PEOPLE_RECORD_FILTERS: Array<{ source: string; types: string[] }> = [
  {
    source: 'linkedin',
    types: ['connection', 'invitation', 'recommendation', 'endorsement', 'messages']
  },
  { source: 'facebook', types: ['connection', 'messages'] },
  { source: 'imessage', types: ['messages'] },
  { source: 'whatsapp', types: ['messages'] },
  { source: 'paypal', types: ['payment'] }
]

/**
 * Build the people directory from people-bearing records + the contacts list.
 * Records that don't name a person are ignored. Sorted most-touchpoints first,
 * then most-recent, then name.
 */
export function buildPeople(records: PersonSourceRow[], contacts: ContactRow[]): Person[] {
  const contactByKey = new Map<string, number>()
  for (const c of contacts) {
    const k = normalizeName(c.displayName)
    if (k && !contactByKey.has(k)) contactByKey.set(k, c.id)
  }

  interface Acc {
    count: number
    sources: Set<string>
    first: number | null
    last: number | null
    nameCounts: Map<string, number>
  }
  const acc = new Map<string, Acc>()
  for (const r of records) {
    const name = extractPersonName(r.source, r.type, r.title)
    if (!name) continue
    const key = normalizeName(name)
    if (!key) continue
    let e = acc.get(key)
    if (!e) {
      e = { count: 0, sources: new Set(), first: null, last: null, nameCounts: new Map() }
      acc.set(key, e)
    }
    e.count++
    e.sources.add(r.source)
    e.nameCounts.set(name, (e.nameCounts.get(name) ?? 0) + 1)
    if (r.occurredAt != null) {
      if (e.first == null || r.occurredAt < e.first) e.first = r.occurredAt
      if (e.last == null || r.occurredAt > e.last) e.last = r.occurredAt
    }
  }

  const people: Person[] = []
  for (const [key, e] of acc) {
    // Canonical display = the original casing seen most often; on a tie the
    // first-seen variant wins. `nameCounts` preserves insertion order and we only
    // replace on a STRICTLY greater count, so this is deterministic without leaning
    // on Array.sort stability.
    let name = ''
    let best = -1
    for (const [variant, c] of e.nameCounts) {
      if (c > best) {
        best = c
        name = variant
      }
    }
    people.push({
      name,
      key,
      count: e.count,
      sources: [...e.sources].sort(),
      firstSeen: e.first,
      lastSeen: e.last,
      contactId: contactByKey.get(key) ?? null
    })
  }
  people.sort(
    (a, b) =>
      b.count - a.count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name)
  )
  return people
}
