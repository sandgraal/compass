/**
 * Derived-entity projection writer (Phase-1 of the cross-reference work).
 *
 * Materializes the pure `deriveEntities` engine into the `derived_entities` cache
 * so the tabs read a small, indexed table instead of re-scanning 191k records on
 * every navigation. A full recompute runs after each import (hooked into
 * `ingestFiles`), mirroring the records semantic index. Best-effort: the caller
 * wraps it so a failure never blocks an import.
 *
 * The read is pre-filtered to the sources an extractor actually claims, so the
 * browser/email firehose is skipped without loading it.
 */

import { inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../db/schema'
import { contacts, derivedEntities, places, records, subscriptions } from '../db/schema'
import { ENTITY_EXTRACTORS, type EntityRecordRow, type OwnedRefs, deriveEntities } from './entities'

/** Distinct sources that have at least one extractor — the DB read is scoped here. */
export const EXTRACTOR_SOURCES: string[] = [
  ...new Set(ENTITY_EXTRACTORS.map((e) => e.match.source))
]

/**
 * Recompute the whole `derived_entities` cache from `records` + owned tables.
 * Returns how many entities were written. Synchronous (better-sqlite3); the
 * ingest hook calls it inside a try/catch so it stays best-effort.
 */
export function refreshDerivedEntities(db: BetterSQLite3Database<typeof schema>): {
  count: number
} {
  const recRows =
    EXTRACTOR_SOURCES.length === 0
      ? []
      : db
          .select({
            source: records.source,
            type: records.type,
            title: records.title,
            body: records.body,
            occurredAt: records.occurredAt
          })
          .from(records)
          .where(inArray(records.source, EXTRACTOR_SOURCES))
          .all()

  const rows: EntityRecordRow[] = recRows.map((r) => ({
    source: r.source,
    type: r.type,
    title: r.title,
    body: r.body,
    occurredAt: r.occurredAt ? r.occurredAt.getTime() : null
  }))

  const owned: OwnedRefs = {
    contacts: db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .all(),
    subscriptionExternalIds: db
      .select({ externalId: subscriptions.externalId })
      .from(subscriptions)
      .all()
      .map((s) => s.externalId),
    places: db.select({ id: places.id, externalId: places.externalId }).from(places).all()
  }

  const entities = deriveEntities(rows, owned)
  const now = new Date()

  // Full replace — the projection is a pure cache, so delete-then-insert is the
  // simplest correct recompute. Wrapped in one transaction so a reader never sees
  // a half-rebuilt cache.
  db.transaction((tx) => {
    tx.delete(derivedEntities).run()
    for (const e of entities) {
      tx.insert(derivedEntities)
        .values({
          kind: e.kind,
          matchKey: e.key,
          name: e.name,
          count: e.count,
          sources: JSON.stringify(e.sources),
          firstSeen: e.firstSeen != null ? new Date(e.firstSeen) : null,
          lastSeen: e.lastSeen != null ? new Date(e.lastSeen) : null,
          attrs: JSON.stringify(e.attrs),
          promotedKind: e.promotedKind,
          promotedId: e.promotedId,
          refreshedAt: now
        })
        .run()
    }
  })

  return { count: entities.length }
}

/**
 * Build the projection once if it's empty — the backfill for DBs whose records
 * were imported BEFORE this cache existed (an existing 191k-row timeline). A
 * no-op once populated; cheap even when empty (the read is scoped to extractor
 * sources). Called best-effort at startup.
 */
export function ensureDerivedEntities(db: BetterSQLite3Database<typeof schema>): {
  built: boolean
  count: number
} {
  const has = db.select({ id: derivedEntities.id }).from(derivedEntities).limit(1).all()
  if (has.length > 0) return { built: false, count: 0 }
  return { built: true, ...refreshDerivedEntities(db) }
}
