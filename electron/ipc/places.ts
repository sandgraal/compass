/**
 * Places IPC (places redesign, 2026-07) — the owned home for a merchant/place
 * the user promotes out of the derived-entity cache (`entities:promote`), plus
 * the tracked-place profile surface (the place analogue of merchants.ts):
 *
 *   places:list-tracked  → every tracked place (kind='place') + LIVE visit
 *     stats matched from the records spine via the place extractors
 *   places:profile       → everything we know about one place: visit stats,
 *     monthly visit buckets, recent visits, cross-source timeline activity,
 *     attached documents
 *   places:update        → the user-editable fields on the places row
 *   places:create-manual → a manual place (no derived projection)
 *   places:untrack       → delete the places row and clear the projection
 *     row's promoted flags so the place reappears in Discovered immediately
 *
 * PRIVACY BOUNDARY: these handlers read the records spine + owned tables —
 * raw `location_points` are touched ONLY through lib/location-place-geo.ts,
 * which returns a single ~1.1 km-rounded coordinate per tracked place (the
 * same granularity `location:map-data`'s cells already expose); raw points
 * never cross IPC. Like `location:map-data`, this namespace is a
 * renderer-local UI read and must never be registered as an assistant or
 * MCP tool.
 *
 * Also exports the shared places-row validators merchants.ts builds on
 * (dependency direction: merchants.ts → places.ts, never the reverse).
 */

import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { derivedEntities, documentLinks, documents, placeMergeAliases, places } from '../db/schema'
import { addExclusions, loadExclusionSet } from '../lib/curation'
import { placeExternalId } from '../lib/entities'
import { computePlaceGeo } from '../lib/location-place-geo'
import { allMatchKeysForPlace, matchKeyForPlace } from '../lib/merchant-match'
import {
  type DedupePlaceRow,
  computePlaceDedupe,
  dedupePairKey,
  pickPlaceSurvivor
} from '../lib/place-dedupe'
import {
  type PlaceCandidateRow,
  type PlaceMonthlyBucket,
  type PlaceVisit,
  type PlaceVisitStats,
  VISIT_SOURCES,
  computeVisitMonthly,
  computeVisitStats,
  indexVisitsByKey,
  placeMatchKey
} from '../lib/place-profile'
import type { PlaceWebEnrichment } from '../lib/place-web-enrichment'
import { searchRecords } from '../lib/records-search'

export interface PlaceRecord {
  id: number
  externalId: string
  kind: string
  name: string
  category: string | null
  address: string | null
  url: string | null
  totalSpend: number | null
  notes: string | null
  source: string
}

/** Namespaced JSON extras on a places row (`places.meta`, kind='place'). */
export interface PlaceMeta {
  /**
   * GPS-derived approximate coordinate (lib/location-place-geo.ts), rounded to
   * ~1.1 km. A geo WITHOUT lat/lng is a cached negative result — recomputed
   * only when `visitCount` (dated, non-trip visits at compute time) changes.
   */
  geo?: { lat?: number; lng?: number; confidence?: number; visitCount: number; computedAt: number }
  /** Consent-gated web enrichment (electron/ipc/place-web-enrich.ts). */
  enrichment?: { web?: PlaceWebEnrichment }
}

export interface TrackedPlace extends PlaceRecord {
  matchKey: string
  meta: PlaceMeta | null
  live: {
    visitCount: number
    firstVisit: number | null
    lastVisit: number | null
    topSource: string | null
  } | null
}

export interface PlaceActivityHit {
  recordId: number
  source: string
  type: string
  title: string
  occurredAt: number | null
}

export interface PlaceDocumentItem {
  linkId: number
  documentId: number
  title: string
  docDate: string | null
  mimeType: string | null
}

export interface PlaceUpdatePatch {
  name?: string
  category?: string | null
  address?: string | null
  url?: string | null
  notes?: string | null
}

export interface PlaceCreateInput {
  name: string
  category?: string | null
  address?: string | null
  url?: string | null
  notes?: string | null
}

export interface PlaceProfile {
  place: PlaceRecord & { meta: PlaceMeta | null }
  matchKey: string
  stats: PlaceVisitStats
  monthly: PlaceMonthlyBucket[]
  visits: PlaceVisit[]
  activity: PlaceActivityHit[]
  documents: PlaceDocumentItem[]
}

const VISIT_LIST_LIMIT = 50
const ACTIVITY_LIMIT = 20
// Visit rows already have their own canonical view (the recent-visits list) —
// keep their sources out of the cross-source activity feed or every calendar
// event / ride shows twice.
const VISIT_SOURCE_IDS = new Set(VISIT_SOURCES.map((v) => v.source))

// ── Shared places-row helpers (merchants.ts imports these) ──────────────────

export const MAX_LEN = { name: 2000, category: 200, address: 500, url: 500, notes: 5000 } as const

export function parseMeta<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function cleanString(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new Error('expected a string')
  const t = v.trim()
  return t.length === 0 ? null : t.slice(0, max)
}

export function cleanUrl(v: unknown): string | null | undefined {
  const s = cleanString(v, MAX_LEN.url)
  if (s === undefined || s === null) return s
  if (!/^https?:\/\//i.test(s)) throw new Error('url must start with http(s)://')
  return s
}

/**
 * Clear the projection row's promoted flags for a deleted owned row —
 * refreshDerivedEntities recomputes them from owned tables, but that only
 * runs on the next import; without this the entity would stay hidden from
 * Discovered until then.
 */
export function clearPromotedFlags(db: ReturnType<typeof getDb>, externalId: string): void {
  const derived = externalId.match(/^derived:(merchant|place):(.+)$/)
  if (!derived) return
  db.update(derivedEntities)
    .set({ promotedKind: null, promotedId: null })
    .where(and(eq(derivedEntities.kind, derived[1]), eq(derivedEntities.matchKey, derived[2])))
    .run()
}

/**
 * Untracking a merge survivor must not silently leave the businesses it
 * absorbed pointed at a now-deleted row — revert each merged-in alias back to
 * an independently discoverable state (own promotedId cleared) and remove
 * the alias rows. The only sane "undo" for a merge without a dedicated
 * un-merge action.
 */
export function clearAbsorbedAliases(
  db: ReturnType<typeof getDb>,
  kind: 'merchant' | 'place',
  placeId: number
): void {
  const aliases = db
    .select({ aliasKey: placeMergeAliases.aliasKey })
    .from(placeMergeAliases)
    .where(and(eq(placeMergeAliases.kind, kind), eq(placeMergeAliases.survivorPlaceId, placeId)))
    .all()
  for (const { aliasKey } of aliases) {
    db.update(derivedEntities)
      .set({ promotedKind: null, promotedId: null })
      .where(and(eq(derivedEntities.kind, kind), eq(derivedEntities.matchKey, aliasKey)))
      .run()
  }
  db.delete(placeMergeAliases)
    .where(and(eq(placeMergeAliases.kind, kind), eq(placeMergeAliases.survivorPlaceId, placeId)))
    .run()
}

type PlaceRow = typeof places.$inferSelect

function rowToRecord(r: PlaceRow): PlaceRecord {
  return {
    id: r.id,
    externalId: r.externalId,
    kind: r.kind,
    name: r.name,
    category: r.category,
    address: r.address,
    url: r.url,
    totalSpend: r.totalSpend,
    notes: r.notes,
    source: r.source
  }
}

/**
 * Promote a derived merchant/place into the owned `places` table. Idempotent by
 * `derived:<kind>:<key>`; returns the row id (existing or new) so `entities:promote`
 * can link it back on the projection row.
 */
export function promoteDerivedPlace(
  kind: 'merchant' | 'place',
  name: string,
  matchKey: string,
  opts: { category?: string | null; address?: string | null; totalSpend?: number | null } = {}
): { id: number; alreadyExisted: boolean } {
  const db = getDb()
  const externalId = placeExternalId(kind, matchKey)
  const existing = db
    .select({ id: places.id })
    .from(places)
    .where(eq(places.externalId, externalId))
    .all()[0]
  if (existing) return { id: existing.id, alreadyExisted: true }
  const result = db
    .insert(places)
    .values({
      externalId,
      kind,
      name: name.slice(0, 2000) || 'Untitled',
      category: opts.category ?? null,
      address: opts.address ?? null,
      totalSpend: opts.totalSpend ?? null,
      source: 'derived',
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .run()
  return { id: Number(result.lastInsertRowid), alreadyExisted: false }
}

/**
 * The candidate rows a visit can come from — the four place-extractor record
 * shapes, loaded once per call (calendar/rides/trips are bounded sources, not
 * the record firehose).
 */
function loadVisitCandidates(): PlaceCandidateRow[] {
  const where = VISIT_SOURCES.map(() => '(source = ? AND type = ?)').join(' OR ')
  const params = VISIT_SOURCES.flatMap((v) => [v.source, v.type])
  return getRawSqlite()
    .prepare(
      `SELECT id, source, type, title, body, occurred_at AS occurredAt
         FROM records WHERE ${where}`
    )
    .all(...params) as PlaceCandidateRow[]
}

/**
 * Concatenate the visits matched under a place's primary key with every
 * merged-in alias, re-sorted ascending by occurredAt — indexVisitsByKey
 * guarantees that ordering per key, but a union across several keys needs
 * re-sorting to preserve it.
 */
function mergeVisitsForKeys(byKey: Map<string, PlaceVisit[]>, keys: string[]): PlaceVisit[] {
  const merged = keys.flatMap((k) => byKey.get(k) ?? [])
  merged.sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0))
  return merged
}

/**
 * Persist an accepted web-enrichment run (electron/ipc/place-web-enrich.ts):
 * accepted core columns re-validated through the same cleaners as
 * places:update, the accepted findings into meta.enrichment.web (replacing
 * the whole namespace — rejected leftovers never linger), other meta
 * namespaces (geo) untouched. Deliberately NOT kind-filtered: this is the
 * shared enrichment writer for both tracked places and tracked merchants.
 */
export function applyPlaceWebEnrichment(
  placeId: number,
  fields: Partial<Record<'category' | 'address' | 'url', string>>,
  web: PlaceWebEnrichment
): boolean {
  const db = getDb()
  const row = db.select().from(places).where(eq(places.id, placeId)).all()[0]
  if (!row) return false
  const meta = parseMeta<PlaceMeta>(row.meta) ?? {}
  const updates: Partial<PlaceRow> = {
    meta: JSON.stringify({ ...meta, enrichment: { ...(meta.enrichment ?? {}), web } }),
    updatedAt: new Date()
  }
  const category = cleanString(fields.category, MAX_LEN.category)
  if (category != null) updates.category = category
  const address = cleanString(fields.address, MAX_LEN.address)
  if (address != null) updates.address = address
  const url = cleanUrl(fields.url)
  if (url != null) updates.url = url
  db.update(places).set(updates).where(eq(places.id, placeId)).run()
  return true
}

/**
 * Lazily (re)derive a tracked place's approximate coordinate from the GPS
 * history and cache it in meta.geo. Recomputes only when the dated-visit
 * count changed (a negative result is cached the same way, so a place with
 * no GPS overlap doesn't re-scan every page load). Trip visits are excluded —
 * a country-level "Trip to X" pins nothing. Deliberately does NOT bump
 * updatedAt: this is a derived cache, not a user edit (and the tracked list
 * orders by updatedAt).
 */
function ensurePlaceGeo(
  db: ReturnType<typeof getDb>,
  row: PlaceRow,
  meta: PlaceMeta | null,
  visits: PlaceVisit[]
): PlaceMeta | null {
  const times = visits
    .filter((v) => v.source !== 'travel')
    .map((v) => v.occurredAt)
    .filter((t): t is number => t != null)
  if (times.length === 0) return meta
  if (meta?.geo && meta.geo.visitCount === times.length) return meta
  const result = computePlaceGeo(getRawSqlite(), row.name, times)
  const next: PlaceMeta = {
    ...(meta ?? {}),
    geo: { ...(result ?? {}), visitCount: times.length, computedAt: Date.now() }
  }
  db.update(places)
    .set({ meta: JSON.stringify(next) })
    .where(eq(places.id, row.id))
    .run()
  return next
}

// ── Merge + duplicate detection (merge feature, 2026-07) ────────────────────
// One shared implementation for both kinds — merchants.ts never duplicates
// this (same dependency direction as the rest of the file: merchants.ts →
// places.ts, never the reverse).

export interface DuplicatePlaceSummary {
  id: number
  externalId: string
  name: string
  category: string | null
}

export interface DuplicatePlacePair {
  a: DuplicatePlaceSummary
  b: DuplicatePlaceSummary
}

/** The merge-key resolver for a `places` row, dispatched by kind. */
function resolveMatchKey(kind: 'merchant' | 'place', externalId: string, name: string): string {
  return kind === 'merchant' ? matchKeyForPlace(externalId, name) : placeMatchKey(externalId, name)
}

/** Rough completeness signal for survivor selection — no live-stat query, so
 * it stays cheap and self-contained; the promote-time totalSpend snapshot is
 * used as-is rather than a fresh ledger read. */
function filledFieldScore(row: PlaceRow): number {
  let score = 0
  for (const v of [row.category, row.address, row.url, row.notes, row.meta, row.totalSpend]) {
    if (v) score++
  }
  return score
}

function readDedupeRows(kind: 'merchant' | 'place'): DedupePlaceRow[] {
  return getDb()
    .select()
    .from(places)
    .where(eq(places.kind, kind))
    .all()
    .map((row) => ({
      id: row.id,
      externalId: row.externalId,
      kind,
      name: row.name,
      createdAt: row.createdAt ? row.createdAt.getTime() : null,
      filledScore: filledFieldScore(row)
    }))
}

/**
 * Fold the losers into the survivor and delete them, in ONE transaction:
 * empty scalar fields filled from losers, distinct notes concatenated, meta
 * merged by namespace (survivor's own namespace wins), each loser's match key
 * — plus any it had already absorbed from an earlier merge — re-pointed at the
 * survivor in `place_merge_aliases` so future transactions/visits keep
 * attributing correctly, `derived_entities.promotedId` re-pointed so
 * Discovered stays consistent immediately, attached documents re-pointed, and
 * the loser rows deleted. Read-time alias resolution (allMatchKeysForPlace,
 * refreshDerivedEntities) is what makes this durable — see entities-projection.ts.
 */
export function mergePlaces(
  kind: 'merchant' | 'place',
  survivorId: number,
  loserIds: number[]
): boolean {
  const db = getDb()
  const survivor = db
    .select()
    .from(places)
    .where(and(eq(places.id, survivorId), eq(places.kind, kind)))
    .all()[0]
  if (!survivor) return false
  const losers = loserIds
    .filter((id) => id !== survivorId)
    .map(
      (id) =>
        db
          .select()
          .from(places)
          .where(and(eq(places.id, id), eq(places.kind, kind)))
          .all()[0]
    )
    .filter((r): r is PlaceRow => !!r)
  if (losers.length === 0) return false

  let category = survivor.category
  let address = survivor.address
  let url = survivor.url
  const notes: string[] = survivor.notes ? [survivor.notes] : []
  let meta = parseMeta<Record<string, unknown>>(survivor.meta)
  for (const loser of losers) {
    if (!category && loser.category) category = loser.category
    if (!address && loser.address) address = loser.address
    if (!url && loser.url) url = loser.url
    if (loser.notes && !notes.includes(loser.notes)) notes.push(loser.notes)
    const loserMeta = parseMeta<Record<string, unknown>>(loser.meta)
    if (loserMeta) {
      const next: Record<string, unknown> = { ...(meta ?? {}) }
      for (const [k, v] of Object.entries(loserMeta)) {
        if (next[k] === undefined || next[k] === null) next[k] = v
      }
      meta = Object.keys(next).length > 0 ? next : null
    }
  }

  db.transaction((tx) => {
    tx.update(places)
      .set({
        category,
        address,
        url,
        notes: notes.length > 0 ? notes.join('\n\n') : survivor.notes,
        meta: meta ? JSON.stringify(meta) : null,
        updatedAt: new Date()
      })
      .where(eq(places.id, survivorId))
      .run()

    for (const loser of losers) {
      const loserKey = resolveMatchKey(kind, loser.externalId, loser.name)
      // Keys the loser had already absorbed from an EARLIER merge (transitive
      // — the loser was itself a survivor once) must move to the new survivor too.
      const inherited = tx
        .select({ aliasKey: placeMergeAliases.aliasKey })
        .from(placeMergeAliases)
        .where(
          and(eq(placeMergeAliases.kind, kind), eq(placeMergeAliases.survivorPlaceId, loser.id))
        )
        .all()
      const keysToRepoint = [loserKey, ...inherited.map((r) => r.aliasKey)].filter(
        (k) => k.length > 0
      )

      for (const key of keysToRepoint) {
        tx.insert(placeMergeAliases)
          .values({ survivorPlaceId: survivorId, kind, aliasKey: key, aliasName: loser.name })
          .onConflictDoUpdate({
            target: [placeMergeAliases.kind, placeMergeAliases.aliasKey],
            set: { survivorPlaceId: survivorId, aliasName: loser.name }
          })
          .run()
        tx.update(derivedEntities)
          .set({ promotedId: survivorId })
          .where(and(eq(derivedEntities.kind, kind), eq(derivedEntities.matchKey, key)))
          .run()
      }

      // Documents attached to the loser's externalId must not orphan.
      tx.update(documentLinks)
        .set({ targetId: survivor.externalId })
        .where(
          and(eq(documentLinks.targetKind, kind), eq(documentLinks.targetId, loser.externalId))
        )
        .run()

      tx.delete(places).where(eq(places.id, loser.id)).run()
    }
  })

  return true
}

/**
 * Deterministic survivor suggestion for the bulk-merge dialog (richer profile
 * → older → lowest id), so the dialog's default matches what a careful manual
 * pick would choose. Mirrors `contacts:suggest-survivor`.
 */
export function suggestPlaceSurvivor(
  kind: 'merchant' | 'place',
  ids: number[]
): { survivorId: number } {
  const idSet = new Set(ids)
  const members = readDedupeRows(kind).filter((r) => idSet.has(r.id))
  if (members.length < 2) {
    throw new Error('suggestPlaceSurvivor: found fewer than two matching rows')
  }
  return { survivorId: pickPlaceSurvivor(members).id }
}

/**
 * Review-only duplicate suggestions (no auto-merge tier — see place-dedupe.ts).
 * Computed on demand; the only persistence is the 'dedupe-dismissed' exclusion
 * for pairs the user rejected. Mirrors `contacts:duplicates`.
 */
export function listPlaceDuplicates(kind: 'merchant' | 'place'): DuplicatePlacePair[] {
  const db = getDb()
  const dismissed = loadExclusionSet(db, ['dedupe-dismissed'])
  const fullRows = db.select().from(places).where(eq(places.kind, kind)).all()
  const rows: DedupePlaceRow[] = fullRows.map((row) => ({
    id: row.id,
    externalId: row.externalId,
    kind,
    name: row.name,
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    filledScore: filledFieldScore(row)
  }))
  const byId = new Map(fullRows.map((r) => [r.id, r]))
  const pairs = computePlaceDedupe(rows, { dismissedPairs: dismissed })
  return pairs
    .map(({ aId, bId }) => {
      const a = byId.get(aId)
      const b = byId.get(bId)
      return a && b
        ? {
            a: { id: a.id, externalId: a.externalId, name: a.name, category: a.category },
            b: { id: b.id, externalId: b.externalId, name: b.name, category: b.category }
          }
        : null
    })
    .filter((p): p is DuplicatePlacePair => p !== null)
}

export function registerPlacesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('places:list-tracked', (): TrackedPlace[] => {
    const db = getDb()
    const sqlite = getRawSqlite()
    const rows = db
      .select()
      .from(places)
      .where(eq(places.kind, 'place'))
      .orderBy(desc(places.updatedAt))
      .all()
    const keyed = rows.map((r) => {
      const matchKey = placeMatchKey(r.externalId, r.name)
      return { row: r, matchKey, keys: allMatchKeysForPlace(sqlite, r.id, matchKey, 'place') }
    })
    const allKeys = new Set(keyed.flatMap((k) => k.keys).filter((k) => k.length > 0))
    const byKey = indexVisitsByKey(loadVisitCandidates(), allKeys)
    // One cheap probe gates all geo work — most stores have no GPS import.
    const hasPoints = sqlite.prepare('SELECT 1 FROM location_points LIMIT 1').get() != null
    return keyed.map(({ row, matchKey, keys }) => {
      const visits = mergeVisitsForKeys(byKey, keys)
      let live: TrackedPlace['live'] = null
      let meta = parseMeta<PlaceMeta>(row.meta)
      if (visits.length > 0) {
        // computeVisitStats ignores undated visits when picking first/last, so
        // a null-occurredAt row (sorted first by indexVisitsByKey) can't make
        // firstVisit/lastVisit read null when dated visits exist.
        const stats = computeVisitStats(visits)
        live = {
          visitCount: stats.visitCount,
          firstVisit: stats.firstVisit,
          lastVisit: stats.lastVisit,
          topSource: stats.bySource[0]?.source ?? null
        }
        if (hasPoints) meta = ensurePlaceGeo(db, row, meta, visits)
      }
      return { ...rowToRecord(row), matchKey, meta, live }
    })
  })

  ipcMain.handle('places:profile', (_event, id: number): PlaceProfile => {
    if (!Number.isInteger(id)) throw new Error('places:profile requires an integer id')
    const db = getDb()
    // kind='place' — the table is shared with merchants; without this filter
    // a merchant id would leak through the places surface.
    const row = db
      .select()
      .from(places)
      .where(and(eq(places.id, id), eq(places.kind, 'place')))
      .all()[0]
    if (!row) throw new Error('places:profile: not found')
    const matchKey = placeMatchKey(row.externalId, row.name)
    const keys = allMatchKeysForPlace(getRawSqlite(), id, matchKey, 'place').filter(
      (k) => k.length > 0
    )

    const visits =
      keys.length > 0
        ? mergeVisitsForKeys(indexVisitsByKey(loadVisitCandidates(), new Set(keys)), keys)
        : []

    // Cross-source activity: emails, notes, finance — the timeline hits for
    // this place's name, minus the visit sources (see VISIT_SOURCE_IDS) which
    // the recent-visits list already covers.
    const activity: PlaceActivityHit[] = searchRecords(getRawSqlite(), {
      q: row.name,
      limit: ACTIVITY_LIMIT * 2
    })
      .filter((h) => !VISIT_SOURCE_IDS.has(h.source))
      .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))
      .slice(0, ACTIVITY_LIMIT)
      .map((h) => ({
        recordId: h.id,
        source: h.source,
        type: h.type,
        title: h.title,
        occurredAt: h.occurredAt
      }))

    const docs = db
      .select({
        linkId: documentLinks.id,
        documentId: documents.id,
        title: documents.title,
        docDate: documents.docDate,
        mimeType: documents.mimeType
      })
      .from(documentLinks)
      .innerJoin(documents, eq(documents.id, documentLinks.documentId))
      .where(and(eq(documentLinks.targetKind, 'place'), eq(documentLinks.targetId, row.externalId)))
      .all()

    return {
      place: { ...rowToRecord(row), meta: parseMeta<PlaceMeta>(row.meta) },
      matchKey,
      stats: computeVisitStats(visits),
      monthly: computeVisitMonthly(visits),
      visits: visits.slice(-VISIT_LIST_LIMIT).reverse(),
      activity,
      documents: docs
    }
  })

  ipcMain.handle('places:update', (_event, id: number, patch: PlaceUpdatePatch) => {
    if (!Number.isInteger(id)) throw new Error('places:update requires an integer id')
    if (!patch || typeof patch !== 'object') throw new Error('places:update: patch required')
    const db = getDb()
    // kind='place' — see places:profile; keeps this handler from mutating a
    // merchant row if called with the wrong id.
    const row = db
      .select()
      .from(places)
      .where(and(eq(places.id, id), eq(places.kind, 'place')))
      .all()[0]
    if (!row) throw new Error('places:update: not found')

    const updates: Partial<PlaceRow> = {}
    const name = cleanString(patch.name, MAX_LEN.name)
    // A place can't be nameless; dropping the name entirely is rejected
    // rather than silently keeping the old one.
    if (name === null) throw new Error('places:update: name cannot be empty')
    if (name !== undefined) updates.name = name
    const category = cleanString(patch.category, MAX_LEN.category)
    if (category !== undefined) updates.category = category
    const address = cleanString(patch.address, MAX_LEN.address)
    if (address !== undefined) updates.address = address
    const url = cleanUrl(patch.url)
    if (url !== undefined) updates.url = url
    const notes = cleanString(patch.notes, MAX_LEN.notes)
    if (notes !== undefined) updates.notes = notes

    if (Object.keys(updates).length === 0) return { success: true }
    updates.updatedAt = new Date()
    db.update(places).set(updates).where(eq(places.id, id)).run()
    return { success: true }
  })

  ipcMain.handle('places:create-manual', (_event, input: PlaceCreateInput) => {
    if (!input || typeof input !== 'object') throw new Error('places:create-manual: input required')
    const name = cleanString(input.name, MAX_LEN.name)
    if (!name) throw new Error('places:create-manual: name is required')
    const db = getDb()
    const result = db
      .insert(places)
      .values({
        externalId: `manual:${randomUUID()}`,
        kind: 'place',
        name,
        category: cleanString(input.category, MAX_LEN.category) ?? null,
        address: cleanString(input.address, MAX_LEN.address) ?? null,
        url: cleanUrl(input.url) ?? null,
        notes: cleanString(input.notes, MAX_LEN.notes) ?? null,
        source: 'manual',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .run()
    return { success: true, id: Number(result.lastInsertRowid) }
  })

  // Untrack = delete the owned row AND clear the projection row's promoted
  // flags inline (see clearPromotedFlags) — identical contract to
  // merchants:untrack.
  ipcMain.handle('places:untrack', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('places:untrack requires an integer id')
    const db = getDb()
    // kind='place' — see places:profile; keeps this handler from deleting a
    // tracked merchant if called with the wrong id.
    const row = db
      .select()
      .from(places)
      .where(and(eq(places.id, id), eq(places.kind, 'place')))
      .all()[0]
    if (!row) return { success: true }
    db.delete(places).where(eq(places.id, id)).run()
    clearPromotedFlags(db, row.externalId)
    clearAbsorbedAliases(db, 'place', id)
    return { success: true }
  })

  // ── Merge + duplicates ─────────────────────────────────────────────────────
  ipcMain.handle(
    'places:merge',
    (_event, req: { kind: 'merchant' | 'place'; survivorId: number; loserIds: number[] }) => {
      const { kind, survivorId, loserIds } = req ?? {}
      if (
        (kind !== 'merchant' && kind !== 'place') ||
        !Number.isInteger(survivorId) ||
        !Array.isArray(loserIds) ||
        loserIds.length === 0
      ) {
        throw new Error('places:merge requires kind, survivorId, and loserIds')
      }
      const ok = mergePlaces(
        kind,
        survivorId,
        loserIds.filter((id: unknown): id is number => Number.isInteger(id))
      )
      return { success: ok }
    }
  )

  ipcMain.handle(
    'places:suggest-survivor',
    (_event, req: { kind: 'merchant' | 'place'; ids: number[] }) => {
      const kind = req?.kind
      const ids = Array.isArray(req?.ids)
        ? req.ids.filter((id): id is number => Number.isInteger(id))
        : []
      if (kind !== 'merchant' && kind !== 'place') {
        throw new Error('places:suggest-survivor requires a kind')
      }
      if (ids.length < 2) throw new Error('places:suggest-survivor requires at least two ids')
      return suggestPlaceSurvivor(kind, ids)
    }
  )

  ipcMain.handle('places:duplicates', (_event, req: { kind: 'merchant' | 'place' }) => {
    const kind = req?.kind
    if (kind !== 'merchant' && kind !== 'place') {
      throw new Error('places:duplicates requires a kind')
    }
    return listPlaceDuplicates(kind)
  })

  ipcMain.handle(
    'places:dismiss-duplicate',
    (_event, req: { aExternalId: string; bExternalId: string }) => {
      const { aExternalId, bExternalId } = req ?? {}
      if (!aExternalId || !bExternalId) {
        throw new Error('places:dismiss-duplicate requires both external ids')
      }
      addExclusions(getDb(), 'dedupe-dismissed', [dedupePairKey(aExternalId, bExternalId)])
      return { success: true }
    }
  )
}
