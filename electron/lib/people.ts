/**
 * People — the "Connect" track (Phase 10.7).
 *
 * Derives a directory of the actual people across your timeline and collapses the
 * SAME person seen through different sources into one entry — a LinkedIn connection
 * who's also a Facebook friend becomes a single person with two source touchpoints.
 *
 * Pure + derived: no schema change, no stored links. We read the people-bearing
 * records (where the title is an unambiguous "verb + person", so precision stays
 * high and merchants/newsletters don't leak in) and match each to your `contacts`
 * by normalized display name. Recomputed on demand, exactly like the timeline
 * stats/facets aggregates.
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
 * Pull the person's name out of a people-bearing record title, or null if the
 * record doesn't name a person. Gated by (source, type) so the patterns stay
 * unambiguous — these titles are all minted by our own recognizers.
 */
export function extractPersonName(source: string, type: string, title: string): string | null {
  const t = title.trim()
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
  return null
}

/** (source, type) pairs whose titles name a person — used to scope the DB read. */
export const PEOPLE_RECORD_FILTERS: Array<{ source: string; types: string[] }> = [
  { source: 'linkedin', types: ['connection', 'invitation', 'recommendation', 'endorsement'] },
  { source: 'facebook', types: ['connection'] }
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
