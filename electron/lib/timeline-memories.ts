/**
 * Memory-worthiness ranking + sensitivity guard (Timeline 2.0, PR 6).
 *
 * "On this day" should resurface MEMORIES — the trip booking, the career move,
 * the show you binged that winter — not the 214th track of a shuffle session.
 * This module is the pure ranking layer the on-this-day handlers apply before
 * capping each year's records:
 *
 *  - a 0–100 memory score from signals the record itself carries (source/kind
 *    weight, spend magnitude, title richness, how unusual the record is within
 *    its own day — a lone order outranks one listen of forty);
 *  - a sensitivity guard that keeps painful classes (medical records, loss /
 *    breakup language) OUT of unsolicited resurfacing — they stay fully
 *    visible in browse and search, they just don't get pushed at you;
 *  - mute filtering ("never resurface this"), the user's explicit veto.
 */

export type MemoryCandidate = {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
}

export type MuteSet = {
  recordIds: Set<number>
  sourceTypes: Set<string> // 'source|type'
}

// How memorable a record CLASS is, before per-record signals. Career events and
// money movements anchor real memories; a single shuffle-play listen doesn't.
const SOURCE_TYPE_BASE: Record<string, number> = {
  'linkedin|job': 45,
  'linkedin|position': 45,
  'linkedin|connection': 40,
  'linkedin|certification': 40,
  'facebook|post': 32,
  'document|document': 30,
  'credit-report|credit-report': 25,
  'tax-document|document': 30,
  'amazon|order': 26,
  'paypal|payment': 24,
  'venmo|payment': 24,
  'finance|txn': 22,
  'goodreads|book': 24,
  'kindle|read': 18,
  'netflix|watch': 15,
  'prime-video|watch': 15,
  'youtube|watch': 10,
  'gcal|event': 22,
  'email|email': 12,
  'gmail|email': 12,
  'amazon-music|save': 10,
  'amazon-music|like': 8,
  'spotify|listen': 6,
  'amazon-music|listen': 5,
  'apple-health|steps': 3,
  'apple-health|active-energy': 3,
  'alexa|ask': 4
}

function baseScore(source: string, type: string): number {
  const exact = SOURCE_TYPE_BASE[`${source}|${type}`]
  if (exact != null) return exact
  // Sensible defaults by kind family for sources without an explicit weight.
  if (type === 'connection' || type === 'job') return 35
  if (type === 'order' || type === 'purchase' || type === 'payment') return 24
  if (type === 'post' || type === 'comment') return 25
  if (type === 'watch' || type === 'read') return 14
  if (type === 'listen' || type === 'visit' || type === 'event') return 6
  return 12
}

/** First $-ish amount in the body ("$1,234.56", "42.00 USD"), or null. */
function amountFrom(body: string | null): number | null {
  if (!body) return null
  const m = body.match(
    /(?:[$€£]\s?)(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|EUR|GBP|CRC)/
  )
  const raw = m?.[1] ?? m?.[2]
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Sensitive classes never auto-resurface (still browsable/searchable). Kinds
 * first (medical/diagnosis style records), then loss/grief/breakup language —
 * a deliberately narrow list: false positives hide a memory, false negatives
 * push a painful one, and the mute button covers the long tail.
 */
const SENSITIVE_TYPES = new Set(['medical', 'diagnosis', 'condition', 'lab'])
const SENSITIVE_TEXT =
  /\b(funeral|obituar\w*|passed away|in memoriam|bereave\w*|divorce\w*|break[- ]?up|autopsy|biopsy|oncolog\w*|chemo(?:therapy)?|hospice|miscarriage)\b/i

export function isSensitiveMemory(r: Pick<MemoryCandidate, 'type' | 'title' | 'body'>): boolean {
  if (SENSITIVE_TYPES.has(r.type)) return true
  return SENSITIVE_TEXT.test(r.title) || (r.body != null && SENSITIVE_TEXT.test(r.body))
}

/**
 * Score one record given how many records of the same (source, kind) share its
 * day (`sameDayPeers`, ≥1 counting itself): a distinctive one-off outranks one
 * drop of a 40-listen burst.
 */
export function memoryScore(r: MemoryCandidate, sameDayPeers: number): number {
  let score = baseScore(r.source, r.type)
  if (r.title.length > 40) score += 5
  const amount = amountFrom(r.body)
  if (amount != null) {
    if (amount >= 1000) score += 35
    else if (amount >= 200) score += 20
    else if (amount >= 50) score += 10
    else score += 3
  }
  if (sameDayPeers <= 1) score += 15
  else if (sameDayPeers <= 3) score += 5
  else if (sameDayPeers > 5) score -= 15
  return Math.max(0, Math.min(100, score))
}

export function muteKey(source: string, type: string): string {
  return `${source}|${type}`
}

/**
 * The resurfacing pipeline: drop muted + sensitive records, rank the rest by
 * memory score (recency as the tiebreak), cap. Pure — used by both on-this-day
 * handlers so the Timeline hero and the Dashboard card agree on what a memory is.
 */
export function rankMemories<T extends MemoryCandidate>(
  records: T[],
  opts: { mutes?: MuteSet; cap: number }
): T[] {
  const peers = new Map<string, number>()
  for (const r of records) {
    const key = muteKey(r.source, r.type)
    peers.set(key, (peers.get(key) ?? 0) + 1)
  }
  return records
    .filter((r) => {
      if (opts.mutes?.recordIds.has(r.id)) return false
      if (opts.mutes?.sourceTypes.has(muteKey(r.source, r.type))) return false
      return !isSensitiveMemory(r)
    })
    .map((r) => ({ r, score: memoryScore(r, peers.get(muteKey(r.source, r.type)) ?? 1) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.r.occurredAt ?? Number.NEGATIVE_INFINITY) - (a.r.occurredAt ?? Number.NEGATIVE_INFINITY)
    )
    .slice(0, opts.cap)
    .map((x) => x.r)
}
