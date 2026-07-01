/**
 * Entity-derivation engine (Phase-1 of the cross-reference work).
 *
 * Generalizes the one-off `buildPeople` (electron/lib/people.ts) into a single
 * pure engine that turns the append-only `records` timeline into typed, deduped
 * ENTITIES — the people, merchants, places and subscription candidates that the
 * 191k rows are really *about* — so the rest of the app can surface them.
 *
 * How it works, mirroring the recognizer registry it parallels:
 *   records ──▶ ENTITY_EXTRACTORS (one record → 0..n refs) ──▶ merge by
 *   (kind, normalized key) ──▶ DerivedEntity[] matched against owned tables.
 *
 * Cross-source merge falls out of the shared key: a person seen via LinkedIn and
 * Facebook collapses to one entry; "Netflix" seen via the netflix history AND a
 * PayPal charge collapses to one merchant. Purely derived — the engine NEVER
 * writes; materialization is a separate, explicit "promote" step.
 *
 * Robustness note: extractors key off the recognizer's ALREADY-NORMALIZED record
 * fields (source / type / title / body) rather than the raw `payload`, whose keys
 * are fuzzy CSV headers that vary per export.
 */

import { type Cadence, PER_YEAR, detectCadence, median, normalizeMerchant } from './normalize'
import { extractPersonName, isLikelyPerson, normalizeName } from './people'

export type EntityKind = 'person' | 'merchant' | 'place' | 'subscription-candidate'

/** Kind-specific rollup carried on a derived entity (persisted as JSON). */
export interface EntityAttrs {
  /** Sum of |amount| across touchpoints (merchant / subscription spend). */
  totalSpend?: number
  /** Dominant currency code seen (e.g. 'USD'); null when unknown. */
  currency?: string | null
  /** Subscription-candidate cadence + per-charge economics. */
  cadence?: Cadence
  medianAmount?: number
  annualCost?: number
  /** The primary source id (most touchpoints) — used to build the promote key. */
  primarySource?: string
  /** Place address / location string, when derived from a calendar/maps signal. */
  address?: string | null
}

export interface DerivedEntity {
  kind: EntityKind
  /** Canonical display (the original casing seen most often). */
  name: string
  /** Normalized match key, unique within a kind — the merge key. */
  key: string
  count: number
  /** Distinct source ids this entity appears through, sorted. */
  sources: string[]
  firstSeen: number | null
  lastSeen: number | null
  attrs: EntityAttrs
  /** The owned row this maps to (set by the matcher), else null. */
  promotedId: number | null
  promotedKind: 'contact' | 'subscription' | 'place' | null
}

/** One record, reduced to the normalized fields the extractors consume. */
export interface EntityRecordRow {
  source: string
  type: string
  title: string
  body: string | null
  occurredAt: number | null
}

/** One entity reference emitted by an extractor for a single record. */
export interface ExtractedRef {
  kind: EntityKind
  /** Raw display name (pre-normalize). */
  name: string
  /** Signed touchpoint amount, when the record carries money (merchant spend). */
  amount?: number
  currency?: string | null
}

export interface EntityExtractor {
  id: string
  /** The source this claims, and optionally which types (default: any type). */
  match: { source: string; types?: string[] }
  extract: (r: EntityRecordRow) => ExtractedRef[]
}

/** The owned rows the matcher cross-references derived entities against. */
export interface OwnedRefs {
  contacts: Array<{ id: number; displayName: string }>
  /** Every `subscriptions.externalId` (the `detected:<merchant>::<account>` set). */
  subscriptionExternalIds: string[]
}

// ── Money parsing ─────────────────────────────────────────────────────────────
// Bodies carry the amount in their FIRST ' · '-separated segment across every
// money source: "-25.00 USD · Money Sent" (paypal), "- $25.00 · A → B" (venmo),
// "$42.00" (amazon legacy), "42.00 USD" (amazon modern), "$25.00 · Completed"
// (google-pay). Best-effort: a miss just leaves spend undefined.
export function parseMoney(
  body: string | null
): { amount: number; currency: string | null } | null {
  if (!body) return null
  const seg = body.split(' · ')[0].trim()
  const m = seg.match(/(-)?\s*[$€£¥]?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/)
  if (!m) return null
  const n = Number(m[2].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const sign = m[1] === '-' ? -1 : 1
  const cur = m[3] ? m[3].toUpperCase() : null
  return { amount: sign * n, currency: cur }
}

/** The `detected:` external id a subscription candidate promotes under. */
export function subscriptionKey(merchantKey: string, account: string): string {
  return `detected:${merchantKey}::${account}`
}

/**
 * Pull the merchant key out of a `detected:<merchant>::<account>` external id
 * (the account may itself be a source id OR a bank-account display name). Used to
 * dedupe a records-derived subscription candidate against an already-tracked one
 * BY MERCHANT, since the finance audit keys the account on the bank name while a
 * records candidate keys it on the source — the accounts won't match, but the
 * merchant does. Returns null for a non-`detected:` id.
 */
export function detectedMerchant(externalId: string): string | null {
  if (!externalId.startsWith('detected:')) return null
  const rest = externalId.slice('detected:'.length)
  const idx = rest.indexOf('::')
  return idx === -1 ? rest : rest.slice(0, idx)
}

// ── Extractors ────────────────────────────────────────────────────────────────
// Each is pure and individually testable. A source that yields both a person and
// a merchant (PayPal) does so by emitting the right ref per record.

/** Split a Venmo body ("- $25.00 · From → To") into counterparty names. */
function venmoCounterparties(body: string | null): string[] {
  if (!body) return []
  const parts = body.split(' · ')
  const who = parts.length > 1 ? parts.slice(1).join(' · ') : ''
  if (!who) return []
  return who
    .split('→')
    .map((s) => s.trim())
    .filter(Boolean)
}

const VOICE_VERB = /^(Text with|Voicemail from|Missed call from|Call to|Call from)\s+/

export const ENTITY_EXTRACTORS: EntityExtractor[] = [
  // ── People from the social graph + conversations (reuse extractPersonName) ──
  {
    id: 'linkedin-people',
    match: {
      source: 'linkedin',
      types: ['connection', 'invitation', 'recommendation', 'endorsement', 'messages']
    },
    extract: (r) => {
      const n = extractPersonName(r.source, r.type, r.title)
      return n ? [{ kind: 'person', name: n }] : []
    }
  },
  {
    id: 'facebook-people',
    match: { source: 'facebook', types: ['connection', 'messages'] },
    extract: (r) => {
      const n = extractPersonName(r.source, r.type, r.title)
      return n ? [{ kind: 'person', name: n }] : []
    }
  },
  {
    id: 'imessage-people',
    match: { source: 'imessage', types: ['messages'] },
    extract: (r) => {
      const n = extractPersonName(r.source, r.type, r.title)
      return n ? [{ kind: 'person', name: n }] : []
    }
  },
  {
    id: 'google-voice-people',
    match: { source: 'google-voice' },
    extract: (r) => {
      const contact = r.title.replace(VOICE_VERB, '').trim()
      return contact && isLikelyPerson(contact) ? [{ kind: 'person', name: contact }] : []
    }
  },
  // ── PayPal: a person OR a merchant, plus spend ──
  {
    id: 'paypal-counterparty',
    match: { source: 'paypal', types: ['payment'] },
    extract: (r) => {
      const t = r.title.trim()
      if (!t || t === 'PayPal transaction') return []
      const money = parseMoney(r.body)
      if (isLikelyPerson(t)) return [{ kind: 'person', name: t }]
      return [
        { kind: 'merchant', name: t, amount: money?.amount, currency: money?.currency ?? null }
      ]
    }
  },
  // ── Venmo: both counterparties (person or merchant), spend on the record ──
  {
    id: 'venmo-counterparty',
    match: { source: 'venmo', types: ['payment'] },
    extract: (r) => {
      const money = parseMoney(r.body)
      const refs: ExtractedRef[] = []
      for (const who of venmoCounterparties(r.body)) {
        if (isLikelyPerson(who)) refs.push({ kind: 'person', name: who })
        else
          refs.push({
            kind: 'merchant',
            name: who,
            amount: money?.amount,
            currency: money?.currency ?? null
          })
      }
      return refs
    }
  },
  // ── Fixed-merchant activity sources (great subscription candidates) ──
  {
    id: 'amazon-merchant',
    match: { source: 'amazon', types: ['order'] },
    extract: (r) => {
      const money = parseMoney(r.body)
      return [
        {
          kind: 'merchant',
          name: 'Amazon',
          amount: money?.amount,
          currency: money?.currency ?? null
        }
      ]
    }
  },
  {
    id: 'netflix-merchant',
    match: { source: 'netflix' },
    extract: () => [{ kind: 'merchant', name: 'Netflix' }]
  },
  {
    id: 'spotify-merchant',
    match: { source: 'spotify' },
    extract: () => [{ kind: 'merchant', name: 'Spotify' }]
  },
  {
    id: 'youtube-merchant',
    match: { source: 'youtube' },
    extract: () => [{ kind: 'merchant', name: 'YouTube' }]
  },
  {
    id: 'google-play-merchant',
    match: { source: 'google-play' },
    extract: (r) => {
      const money = parseMoney(r.body)
      return [
        {
          kind: 'merchant',
          name: 'Google Play',
          amount: money?.amount,
          currency: money?.currency ?? null
        }
      ]
    }
  },
  {
    id: 'google-pay-merchant',
    match: { source: 'google-pay', types: ['payment'] },
    extract: (r) => {
      const t = r.title.trim()
      if (!t || t === '(transaction)') return []
      const money = parseMoney(r.body)
      return [
        { kind: 'merchant', name: t, amount: money?.amount, currency: money?.currency ?? null }
      ]
    }
  },
  // ── Places from calendar event locations ──
  {
    id: 'gcal-place',
    match: { source: 'gcal', types: ['event'] },
    extract: (r) => {
      const loc = (r.body ?? '').trim()
      return loc ? [{ kind: 'place', name: loc }] : []
    }
  }
]

// ── Accumulation ───────────────────────────────────────────────────────────────

interface Acc {
  count: number
  sources: Set<string>
  sourceCounts: Map<string, number>
  first: number | null
  last: number | null
  nameCounts: Map<string, number>
  amounts: number[]
  dates: number[]
  currencyCounts: Map<string, number>
}

function newAcc(): Acc {
  return {
    count: 0,
    sources: new Set(),
    sourceCounts: new Map(),
    first: null,
    last: null,
    nameCounts: new Map(),
    amounts: [],
    dates: [],
    currencyCounts: new Map()
  }
}

/** Most-frequent original casing (deterministic — replace only on strictly greater). */
function canonicalName(nameCounts: Map<string, number>): string {
  let name = ''
  let best = -1
  for (const [variant, c] of nameCounts) {
    if (c > best) {
      best = c
      name = variant
    }
  }
  return name
}

/** Most-frequent source id. */
function primarySource(sourceCounts: Map<string, number>): string {
  let src = ''
  let best = -1
  for (const [s, c] of sourceCounts) {
    if (c > best) {
      best = c
      src = s
    }
  }
  return src
}

/**
 * Derive the full entity directory from the timeline + owned tables. Pure: the
 * caller supplies the record rows and owned refs; the engine never touches the DB.
 */
export function deriveEntities(records: EntityRecordRow[], owned: OwnedRefs): DerivedEntity[] {
  // Index extractors by source once (a source may have >1 extractor — e.g. none
  // today, but the map-of-arrays keeps that open like the recognizer registry).
  const bySource = new Map<string, EntityExtractor[]>()
  for (const ex of ENTITY_EXTRACTORS) {
    const list = bySource.get(ex.match.source) ?? []
    list.push(ex)
    bySource.set(ex.match.source, list)
  }

  const acc = new Map<string, Acc>()
  for (const r of records) {
    const extractors = bySource.get(r.source)
    if (!extractors) continue
    for (const ex of extractors) {
      if (ex.match.types && !ex.match.types.includes(r.type)) continue
      let refs: ExtractedRef[]
      try {
        refs = ex.extract(r)
      } catch {
        continue // one bad record can't break the engine
      }
      for (const ref of refs) {
        const rawKey =
          ref.kind === 'merchant' ? normalizeMerchant(ref.name) : normalizeName(ref.name)
        if (!rawKey) continue
        const mapKey = `${ref.kind}:${rawKey}`
        let e = acc.get(mapKey)
        if (!e) {
          e = newAcc()
          acc.set(mapKey, e)
        }
        e.count++
        e.sources.add(r.source)
        e.sourceCounts.set(r.source, (e.sourceCounts.get(r.source) ?? 0) + 1)
        e.nameCounts.set(ref.name, (e.nameCounts.get(ref.name) ?? 0) + 1)
        if (r.occurredAt != null) {
          if (e.first == null || r.occurredAt < e.first) e.first = r.occurredAt
          if (e.last == null || r.occurredAt > e.last) e.last = r.occurredAt
          e.dates.push(r.occurredAt)
        }
        if (ref.amount != null && Number.isFinite(ref.amount)) e.amounts.push(Math.abs(ref.amount))
        if (ref.currency)
          e.currencyCounts.set(ref.currency, (e.currencyCounts.get(ref.currency) ?? 0) + 1)
      }
    }
  }

  // Owned-table matchers.
  const contactByKey = new Map<string, number>()
  for (const c of owned.contacts) {
    const k = normalizeName(c.displayName)
    if (k && !contactByKey.has(k)) contactByKey.set(k, c.id)
  }
  // A merchant is "already tracked" if ANY owned detected subscription shares its
  // merchant key — regardless of the account it was tracked under (see
  // `detectedMerchant`), so a records-derived candidate for an already-tracked
  // service reports as tracked instead of looking promotable.
  const trackedMerchantKeys = new Set<string>()
  for (const ext of owned.subscriptionExternalIds) {
    const m = detectedMerchant(ext)
    if (m) trackedMerchantKeys.add(m)
  }

  const out: DerivedEntity[] = []
  for (const [mapKey, e] of acc) {
    const kind = mapKey.slice(0, mapKey.indexOf(':')) as EntityKind
    const key = mapKey.slice(mapKey.indexOf(':') + 1)
    const name = canonicalName(e.nameCounts)
    const src = primarySource(e.sourceCounts)
    const currency = [...e.currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const attrs: EntityAttrs = { primarySource: src }
    if (e.amounts.length > 0) {
      attrs.totalSpend = Math.round(e.amounts.reduce((s, n) => s + n, 0) * 100) / 100
      attrs.currency = currency
    }

    const base: DerivedEntity = {
      kind,
      name,
      key,
      count: e.count,
      sources: [...e.sources].sort(),
      firstSeen: e.first,
      lastSeen: e.last,
      attrs,
      promotedId: kind === 'person' ? (contactByKey.get(key) ?? null) : null,
      promotedKind: null
    }
    if (base.promotedId != null) base.promotedKind = 'contact'
    out.push(base)

    // Subscription-candidate: a merchant with ≥3 dated touchpoints on a regular
    // cadence. Emitted as a SEPARATE entity (the merchant row stays for the
    // Merchants surface); shares the merchant key so promote is deterministic.
    if (kind === 'merchant' && e.dates.length >= 3) {
      const sorted = [...e.dates].sort((a, b) => a - b)
      const cadence = detectCadence(sorted.map((d) => new Date(d)))
      if (cadence) {
        const medAmount = e.amounts.length > 0 ? Math.round(median(e.amounts) * 100) / 100 : 0
        out.push({
          kind: 'subscription-candidate',
          name,
          key,
          count: e.count,
          sources: [...e.sources].sort(),
          firstSeen: e.first,
          lastSeen: e.last,
          attrs: {
            primarySource: src,
            cadence,
            medianAmount: medAmount,
            annualCost: Math.round(medAmount * PER_YEAR[cadence] * 100) / 100,
            currency,
            totalSpend: attrs.totalSpend
          },
          promotedId: null,
          promotedKind: trackedMerchantKeys.has(key) ? 'subscription' : null
        })
      }
    }
  }

  // Most touchpoints first, then most-recent, then name — the buildPeople order.
  out.sort(
    (a, b) =>
      b.count - a.count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name)
  )
  return out
}
