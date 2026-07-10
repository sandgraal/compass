/**
 * Contact dedupe engine — PURE (no Electron, no Drizzle). Finds duplicate
 * contacts across sources (the same person arrives via Google, Google "Other
 * contacts", a LinkedIn CSV, and a derived-promote with four different
 * externalIds) and decides what merges automatically vs. what needs the user.
 *
 * Two tiers, per the user's decision:
 *  - AUTO:   contacts sharing an email address (case-folded) or a normalized
 *            phone number are provably the same person → merge groups, executed
 *            by the caller without asking.
 *            SAFETY GUARD: a *phone-only* link between contacts whose
 *            normalized names differ is demoted to review — shared family
 *            landlines make "same phone" weaker evidence than "same email".
 *  - REVIEW: same normalized display name (≥ 2 tokens — never pair bare
 *            "John"s) with NO shared identifier → suggested pairs for the
 *            Duplicates panel; nothing merges without a click. Pairs the user
 *            rejected ("Not the same person") are supplied as `dismissedPairs`
 *            and never re-suggested.
 *
 * Survivor selection is deterministic (source rank → filledness → age → id) so
 * repeated runs are idempotent: running the engine over an already-merged set
 * produces no new groups.
 */
import { normalizeName } from './people'

export interface DedupeContact {
  id: number
  externalId: string
  displayName: string
  source: string
  createdAt: number | null
  emails: { value: string }[]
  phones: { value: string }[]
  /** Rough completeness signal: how many meaningful fields are filled. */
  filledScore: number
}

export interface AutoGroup {
  survivorId: number
  loserIds: number[]
  reason: 'email' | 'phone'
}

export interface FuzzyPair {
  aId: number
  bId: number
  nameKey: string
}

export interface DedupeResult {
  autoGroups: AutoGroup[]
  fuzzyPairs: FuzzyPair[]
}

/** Stable key for a dismissed pair — JSON, not a joined string (ids can contain '|'). */
export function dedupePairKey(extIdA: string, extIdB: string): string {
  return JSON.stringify([extIdA, extIdB].sort())
}

/**
 * Normalize a phone for identity comparison: digits only, international-prefix
 * `00` stripped, and REQUIRE ≥ 7 digits (shorter is a short code / extension
 * fragment, not an identity). Numbers ≥ 10 digits compare on their LAST 10 so
 * `+1 (415) 555-0100` and `415-555-0100` collide.
 */
export function normalizePhone(raw: string): string | null {
  let digits = (raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length < 7) return null
  return digits.length >= 10 ? digits.slice(-10) : digits
}

/** Curated user sources outrank auto-harvested ones when choosing the survivor. */
const SOURCE_RANK: Record<string, number> = {
  manual: 0,
  google: 1,
  vcard: 2,
  macos: 2,
  csv: 3,
  linkedin: 4,
  facebook: 4,
  gvoice: 4,
  nylas: 5,
  'google-other': 6,
  derived: 7
}
const sourceRank = (s: string): number => SOURCE_RANK[s] ?? 5

/** Deterministic survivor: best source, then most-filled, then oldest, then lowest id. */
function pickSurvivor(members: DedupeContact[]): DedupeContact {
  return [...members].sort((a, b) => {
    const src = sourceRank(a.source) - sourceRank(b.source)
    if (src !== 0) return src
    const filled = b.filledScore - a.filledScore
    if (filled !== 0) return filled
    const age = (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER)
    if (age !== 0) return age
    return a.id - b.id
  })[0]
}

/** Union-find over contact ids. */
class UnionFind {
  private parent = new Map<number, number>()
  find(x: number): number {
    let p = this.parent.get(x)
    if (p === undefined || p === x) {
      this.parent.set(x, x)
      return x
    }
    p = this.find(p)
    this.parent.set(x, p)
    return p
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

export function computeDedupe(
  rows: DedupeContact[],
  opts: { dismissedPairs: Set<string> }
): DedupeResult {
  const byId = new Map(rows.map((r) => [r.id, r]))

  // ── Identifier keys per contact ────────────────────────────────────────────
  const emailKeys = new Map<number, Set<string>>()
  const phoneKeys = new Map<number, Set<string>>()
  for (const r of rows) {
    const em = new Set<string>()
    for (const e of r.emails) {
      const v = e.value?.trim().toLowerCase()
      if (v) em.add(v)
    }
    emailKeys.set(r.id, em)
    const ph = new Set<string>()
    for (const p of r.phones) {
      const v = normalizePhone(p.value ?? '')
      if (v) ph.add(v)
    }
    phoneKeys.set(r.id, ph)
  }

  // ── Link by shared identifiers ─────────────────────────────────────────────
  // Email links always auto-merge. Phone links auto-merge ONLY when the two
  // contacts' normalized names agree (or one side is a bare email-ish name);
  // otherwise the pair is demoted to review.
  const uf = new UnionFind()
  const groupReason = new Map<number, 'email' | 'phone'>() // root → strongest reason
  const demotedPhonePairs: Array<[number, number]> = []

  const byEmail = new Map<string, number[]>()
  const byPhone = new Map<string, number[]>()
  for (const r of rows) {
    for (const k of emailKeys.get(r.id) ?? []) {
      const list = byEmail.get(k) ?? []
      list.push(r.id)
      byEmail.set(k, list)
    }
    for (const k of phoneKeys.get(r.id) ?? []) {
      const list = byPhone.get(k) ?? []
      list.push(r.id)
      byPhone.set(k, list)
    }
  }

  for (const ids of byEmail.values()) {
    for (let i = 1; i < ids.length; i++) {
      uf.union(ids[0], ids[i])
    }
    if (ids.length > 1) {
      // reason recorded after all unions (roots move); mark on the fly below
      for (const id of ids) groupReason.set(id, 'email')
    }
  }

  const namesAgree = (a: DedupeContact, b: DedupeContact): boolean => {
    const na = normalizeName(a.displayName)
    const nb = normalizeName(b.displayName)
    if (na === nb) return true
    // An email-as-name row (e.g. a name-less Other Contact) carries no real
    // name signal — let the phone link stand rather than demote.
    return na.includes('@') || nb.includes('@')
  }

  for (const ids of byPhone.values()) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i])
        const b = byId.get(ids[j])
        if (!a || !b) continue
        if (uf.find(a.id) === uf.find(b.id)) continue // already linked (email)
        if (namesAgree(a, b)) {
          uf.union(a.id, b.id)
          if (!groupReason.has(a.id) && !groupReason.has(b.id)) {
            groupReason.set(a.id, 'phone')
            groupReason.set(b.id, 'phone')
          }
        } else {
          demotedPhonePairs.push([a.id, b.id])
        }
      }
    }
  }

  // ── Materialize auto groups ────────────────────────────────────────────────
  const components = new Map<number, DedupeContact[]>()
  for (const r of rows) {
    const root = uf.find(r.id)
    const list = components.get(root) ?? []
    list.push(r)
    components.set(root, list)
  }
  const autoGroups: AutoGroup[] = []
  const grouped = new Set<number>()
  for (const members of components.values()) {
    if (members.length < 2) continue
    const survivor = pickSurvivor(members)
    const reason = members.some((m) => groupReason.get(m.id) === 'email') ? 'email' : 'phone'
    autoGroups.push({
      survivorId: survivor.id,
      loserIds: members.filter((m) => m.id !== survivor.id).map((m) => m.id),
      reason
    })
    for (const m of members) grouped.add(m.id)
  }

  // ── Fuzzy pairs: same ≥2-token name, no shared identifier ─────────────────
  const byName = new Map<string, number[]>()
  for (const r of rows) {
    if (grouped.has(r.id)) continue // already auto-merging this run
    const key = normalizeName(r.displayName)
    if (key.includes('@')) continue // email-as-name rows carry no name signal
    if (key.split(' ').filter(Boolean).length < 2) continue
    const list = byName.get(key) ?? []
    list.push(r.id)
    byName.set(key, list)
  }
  const fuzzyPairs: FuzzyPair[] = []
  const pushFuzzy = (aId: number, bId: number, nameKey: string): void => {
    const a = byId.get(aId)
    const b = byId.get(bId)
    if (!a || !b) return
    if (opts.dismissedPairs.has(dedupePairKey(a.externalId, b.externalId))) return
    fuzzyPairs.push({ aId, bId, nameKey })
  }
  const MAX_FUZZY_IDS_PER_NAME = 50
  const MAX_FUZZY_PAIRS = 500
  for (const [key, idsAll] of byName) {
    if (fuzzyPairs.length >= MAX_FUZZY_PAIRS) break
    const ids = idsAll.slice(0, MAX_FUZZY_IDS_PER_NAME)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (fuzzyPairs.length >= MAX_FUZZY_PAIRS) break
        pushFuzzy(ids[i], ids[j], key)
      }
    }
  }
  // Demoted phone-only links join the review queue too (they ARE plausible dupes).
  for (const [aId, bId] of demotedPhonePairs) {
    if (grouped.has(aId) || grouped.has(bId)) continue
    pushFuzzy(aId, bId, 'shared-phone')
  }

  return { autoGroups, fuzzyPairs }
}
