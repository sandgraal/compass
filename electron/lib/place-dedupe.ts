/**
 * Merchant/place dedupe engine — PURE (no Electron, no Drizzle). Finds candidate
 * duplicate tracked merchants/places (the same business tracked twice under
 * different name spellings — "Starbucks" vs "Starbucks Coffee #4521") and
 * surfaces them for the user to review.
 *
 * Unlike contacts, there's no email/phone identity signal here, so there is NO
 * auto-merge tier — every suggestion is review-only: nothing merges without a
 * click. Similarity is token-set based: strip punctuation/stopwords/pure-numeric
 * tokens (store numbers), then two names are a candidate pair if the smaller
 * token set is fully contained in the larger, OR their Jaccard overlap clears a
 * threshold. Blocked via an inverted token index (same shape as contact-dedupe's
 * name bucketing) so the pass stays sub-quadratic on a large tracked list.
 * Dismissed pairs reuse `dedupePairKey`/the `dedupe-dismissed` curation kind
 * from `contact-dedupe.ts` — externalId namespaces never collide across kinds.
 */
import { dedupePairKey } from './contact-dedupe'

export interface DedupePlaceRow {
  id: number
  externalId: string
  kind: 'merchant' | 'place'
  name: string
  createdAt: number | null
  /** Richness signal (filled fields + live spend/visits) — computed by the caller. */
  filledScore: number
}

export interface PlaceFuzzyPair {
  aId: number
  bId: number
}

export { dedupePairKey }

const STOPWORDS = new Set(['the', 'inc', 'llc', 'co', 'corp', 'ltd', 'store', 'shop', 'and', 'of'])

/** Lowercase, strip punctuation, drop stopwords/pure-numeric/short tokens. */
export function tokenizePlaceName(name: string): string[] {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
}

const JACCARD_THRESHOLD = 0.5

/** Full token-set containment, or Jaccard overlap at/above the threshold. */
export function placesLikelyDuplicate(aTokens: string[], bTokens: string[]): boolean {
  if (aTokens.length === 0 || bTokens.length === 0) return false
  const aSet = new Set(aTokens)
  const bSet = new Set(bTokens)
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet]
  let intersection = 0
  for (const t of small) if (large.has(t)) intersection++
  if (intersection === small.size) return true
  const union = aSet.size + bSet.size - intersection
  return union > 0 && intersection / union >= JACCARD_THRESHOLD
}

const MAX_FUZZY_IDS_PER_TOKEN = 50
const MAX_FUZZY_PAIRS = 500

/**
 * Suggested duplicate pairs, scoped strictly within one `kind` (a merchant is
 * never suggested against a place) and filtered against `dismissedPairs`.
 */
export function computePlaceDedupe(
  rows: DedupePlaceRow[],
  opts: { dismissedPairs: Set<string> }
): PlaceFuzzyPair[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const tokensById = new Map<number, string[]>()
  for (const r of rows) tokensById.set(r.id, tokenizePlaceName(r.name))

  const byToken = new Map<string, number[]>()
  for (const r of rows) {
    for (const t of new Set(tokensById.get(r.id) ?? [])) {
      const list = byToken.get(t) ?? []
      list.push(r.id)
      byToken.set(t, list)
    }
  }

  const pairs: PlaceFuzzyPair[] = []
  const seenPairs = new Set<string>()
  const pushPair = (aId: number, bId: number): void => {
    if (aId === bId) return
    const idKey = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`
    if (seenPairs.has(idKey)) return
    seenPairs.add(idKey)
    const a = byId.get(aId)
    const b = byId.get(bId)
    if (!a || !b || a.kind !== b.kind) return
    if (opts.dismissedPairs.has(dedupePairKey(a.externalId, b.externalId))) return
    if (!placesLikelyDuplicate(tokensById.get(aId) ?? [], tokensById.get(bId) ?? [])) return
    pairs.push({ aId, bId })
  }

  for (const idsAll of byToken.values()) {
    if (pairs.length >= MAX_FUZZY_PAIRS) break
    const ids = idsAll.slice(0, MAX_FUZZY_IDS_PER_TOKEN)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (pairs.length >= MAX_FUZZY_PAIRS) break
        pushPair(ids[i], ids[j])
      }
    }
  }

  return pairs
}

/** Deterministic survivor: richest profile, then oldest, then lowest id. */
export function pickPlaceSurvivor(members: DedupePlaceRow[]): DedupePlaceRow {
  return [...members].sort((a, b) => {
    const filled = b.filledScore - a.filledScore
    if (filled !== 0) return filled
    const age = (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER)
    if (age !== 0) return age
    return a.id - b.id
  })[0]
}
