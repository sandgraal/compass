/**
 * Contact enrichment — the pure core of "get everything about my contacts,
 * from everywhere we can".
 *
 * A contact's `enrichment` column is a JSON blob with two INDEPENDENTLY-OWNED
 * namespaces so the two writers never clobber each other:
 *   - `google`      — the rich People API fields that have no dedicated column
 *                     (nicknames, biography, extra urls, IM handles, relations,
 *                     important dates, occupations, extra orgs, contact-group
 *                     labels). Owned by the Google contacts sync.
 *   - `crossSource` — how the user knows this person, derived by scanning the
 *                     `records` timeline + the `derived_entities` people cache
 *                     (which connected sources mention them, touchpoint count,
 *                     first/last seen, most-recent activity). Owned by the
 *                     enrichment pass.
 *
 * This module is PURE — no Electron, no Drizzle — so it unit-tests against
 * fixtures. `mergeEnrichment` guarantees a `{crossSource}` patch preserves an
 * existing `google` block and vice-versa. `computeCrossSourceSummary`
 * (added below) turns a contact + its matched person entity + timeline hits
 * into the `crossSource` summary.
 */

/** The rich Google fields with no dedicated `contacts` column. */
export interface GoogleEnrichment {
  nicknames?: string[]
  biography?: string | null
  urls?: { type?: string; value: string }[]
  imHandles?: { protocol?: string; username: string }[]
  relations?: { person: string; type?: string }[]
  importantDates?: { type?: string; date: string }[]
  occupations?: string[]
  organizations?: { name?: string; title?: string }[]
  googleLabels?: string[]
  userDefined?: { key: string; value: string }[]
  phoneticName?: string | null
  updatedAt?: number | null
  /**
   * Source URL of the primary Google photo. Stored cheaply on every sync; the
   * actual image bytes are materialized into `contacts.photo` (as a data URI)
   * by the on-demand deep enrich pass, so the 15-min cron never re-downloads
   * every avatar.
   */
  photoUrl?: string | null
}

/** The most-recent timeline touchpoint for a person — deep-links into /timeline. */
export interface CrossSourceActivity {
  source: string
  type: string
  title: string
  occurredAt: number | null
  recordId: number
}

/** How the user knows this person across every connected source. */
export interface CrossSourceSummary {
  /** Distinct source ids the person appears through, sorted. */
  sources: string[]
  touchpointCount: number
  firstSeen: number | null
  lastSeen: number | null
  lastActivity: CrossSourceActivity | null
  /** Which channels linked this contact to timeline data. */
  matchedBy: ('name' | 'email' | 'phone')[]
  refreshedAt: number
}

export interface ContactEnrichment {
  google?: GoogleEnrichment
  crossSource?: CrossSourceSummary
}

/** One person-bearing hit from the `records` FTS search, tagged with the channel
 *  (contact name / email / phone) whose query surfaced it. */
export interface EnrichmentRecordHit {
  recordId: number
  source: string
  type: string
  title: string
  occurredAt: number | null
  matchedVia: 'name' | 'email' | 'phone'
}

/** The matched `derived_entities` person row (name-key match), if any. */
export interface EnrichmentPersonEntity {
  sources: string[]
  count: number
  firstSeen: number | null
  lastSeen: number | null
}

/**
 * Safely parse the `enrichment` column. Anything that isn't a JSON object
 * (legacy null, corruption, a stray array) collapses to `{}` so callers never
 * throw on a bad blob.
 */
export function parseEnrichment(json: string | null | undefined): ContactEnrichment {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ContactEnrichment) : {}
  } catch {
    return {}
  }
}

/**
 * Shallow-merge a patch into an existing enrichment BY NAMESPACE. A patch that
 * carries only `{crossSource}` leaves `google` untouched, and vice-versa — this
 * is what stops the Google sync and the cross-source pass from overwriting each
 * other's half of the column.
 */
export function mergeEnrichment(
  existing: ContactEnrichment | null | undefined,
  patch: Partial<ContactEnrichment>
): ContactEnrichment {
  const base: ContactEnrichment = existing ?? {}
  const merged: ContactEnrichment = { ...base }
  if (patch.google !== undefined) merged.google = patch.google
  if (patch.crossSource !== undefined) merged.crossSource = patch.crossSource
  return merged
}

/**
 * Fold a person's derived-entity match (name-key) and any timeline record hits
 * (email/phone/name FTS) into the `crossSource` summary. PURE — the caller does
 * the matching (querying `derived_entities` + `records`) and passes the results
 * plus a `refreshedAt` stamp.
 *
 * The two inputs overlap (the name-key entity aggregates records the name FTS
 * also finds), so counts are NOT summed: `touchpointCount` is the larger of the
 * derived count and the distinct record hits, which avoids double-counting while
 * still reflecting email-only matches the name-key missed. `sources` is a set
 * union; `firstSeen`/`lastSeen` span both; `lastActivity` is the newest hit
 * (deep pass only — the cheap cache pass passes no hits).
 */
export function computeCrossSourceSummary(
  personEntity: EnrichmentPersonEntity | null,
  recordHits: EnrichmentRecordHit[],
  refreshedAt: number
): CrossSourceSummary {
  const sources = new Set<string>()
  const matchedBy = new Set<'name' | 'email' | 'phone'>()
  let firstSeen: number | null = null
  let lastSeen: number | null = null

  const extendSpan = (t: number | null): void => {
    if (t == null) return
    if (firstSeen == null || t < firstSeen) firstSeen = t
    if (lastSeen == null || t > lastSeen) lastSeen = t
  }

  if (personEntity) {
    matchedBy.add('name')
    for (const s of personEntity.sources) sources.add(s)
    extendSpan(personEntity.firstSeen)
    extendSpan(personEntity.lastSeen)
  }

  // Dedup hits by recordId (a record can match both the name and email queries).
  const byId = new Map<number, EnrichmentRecordHit>()
  for (const h of recordHits) {
    matchedBy.add(h.matchedVia)
    sources.add(h.source)
    extendSpan(h.occurredAt)
    if (!byId.has(h.recordId)) byId.set(h.recordId, h)
  }

  let lastActivity: CrossSourceActivity | null = null
  for (const h of byId.values()) {
    const cur = lastActivity?.occurredAt ?? Number.NEGATIVE_INFINITY
    if ((h.occurredAt ?? Number.NEGATIVE_INFINITY) > cur) {
      lastActivity = {
        source: h.source,
        type: h.type,
        title: h.title,
        occurredAt: h.occurredAt,
        recordId: h.recordId
      }
    }
  }

  return {
    sources: [...sources].sort(),
    touchpointCount: Math.max(personEntity?.count ?? 0, byId.size),
    firstSeen,
    lastSeen,
    lastActivity,
    matchedBy: (['name', 'email', 'phone'] as const).filter((m) => matchedBy.has(m)),
    refreshedAt
  }
}

/** True when the summary carries no signal — the caller skips persisting these. */
export function isEmptySummary(s: CrossSourceSummary): boolean {
  return s.sources.length === 0 && s.touchpointCount === 0
}
