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
import { derivedEntities, documentLinks, documents, places } from '../db/schema'
import { placeExternalId } from '../lib/entities'
import { computePlaceGeo } from '../lib/location-place-geo'
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

export function registerPlacesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('places:list-tracked', (): TrackedPlace[] => {
    const db = getDb()
    const rows = db
      .select()
      .from(places)
      .where(eq(places.kind, 'place'))
      .orderBy(desc(places.updatedAt))
      .all()
    const keyed = rows.map((r) => ({ row: r, matchKey: placeMatchKey(r.externalId, r.name) }))
    const byKey = indexVisitsByKey(
      loadVisitCandidates(),
      new Set(keyed.map((k) => k.matchKey).filter((k) => k.length > 0))
    )
    // One cheap probe gates all geo work — most stores have no GPS import.
    const hasPoints = getRawSqlite().prepare('SELECT 1 FROM location_points LIMIT 1').get() != null
    return keyed.map(({ row, matchKey }) => {
      const visits = byKey.get(matchKey)
      let live: TrackedPlace['live'] = null
      let meta = parseMeta<PlaceMeta>(row.meta)
      if (visits && visits.length > 0) {
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

    const visits =
      matchKey.length > 0
        ? (indexVisitsByKey(loadVisitCandidates(), new Set([matchKey])).get(matchKey) ?? [])
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
    return { success: true }
  })
}
