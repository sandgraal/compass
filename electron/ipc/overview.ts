/**
 * Overview IPC — the unified "one place for all my data" home (cross-reference
 * engine, final phase). A read-only aggregator that composes what the app already
 * knows into a single landing summary:
 *   - the owned-data rollup (`buildStorehouseSummary` — contacts/subs/assets counts
 *     + upcoming renewals),
 *   - the timeline at-a-glance (record count, distinct sources, dated span),
 *   - and the cross-reference SUGGESTIONS derived from the timeline (people to add
 *     to contacts, recurring services to track, merchants/places found).
 *
 * The renderer's "search everything" box uses the existing `records:search`; this
 * summary powers the suggestion cards + rollup. Pure `buildOverview(db, today)` so
 * it's unit-testable with an injected date, matching the Phase-7 aggregator pattern.
 */

import { type SQL, and, asc, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import type * as schema from '../db/schema'
import { derivedEntities, records } from '../db/schema'
import { type StorehouseSummary, buildStorehouseSummary } from './storehouse'

export interface OverviewSuggestionItem {
  name: string
  key: string
  count: number
  cadence?: string | null
  annualCost?: number | null
}

export interface OverviewSummary {
  storehouse: StorehouseSummary
  timeline: { records: number; sources: number; earliest: number | null; latest: number | null }
  suggestions: {
    peopleUnpromoted: number
    subscriptionsUntracked: number
    merchants: number
    places: number
    topPeople: OverviewSuggestionItem[]
    topSubscriptions: OverviewSuggestionItem[]
  }
}

type Db = BetterSQLite3Database<typeof schema>

/** A subscription-candidate is "untracked" when it isn't matched to an owned sub. */
const UNTRACKED_SUB: SQL = and(
  eq(derivedEntities.kind, 'subscription-candidate'),
  or(isNull(derivedEntities.promotedKind), ne(derivedEntities.promotedKind, 'subscription'))
) as SQL
/** A person is a contact SUGGESTION when it hasn't been promoted to a contact. */
const UNPROMOTED_PERSON: SQL = and(
  eq(derivedEntities.kind, 'person'),
  isNull(derivedEntities.promotedId)
) as SQL

function countWhere(db: Db, where: SQL): number {
  return db.select({ n: sql<number>`count(*)` }).from(derivedEntities).where(where).get()?.n ?? 0
}

export function buildOverview(db: Db, today: Date): OverviewSummary {
  const storehouse = buildStorehouseSummary(db, today)

  const t = db
    .select({
      total: sql<number>`count(*)`,
      sources: sql<number>`count(distinct ${records.source})`,
      earliest: sql<number | null>`min(${records.occurredAt})`,
      latest: sql<number | null>`max(${records.occurredAt})`
    })
    .from(records)
    .get()

  // Stable ordering (count, lastSeen, name) — never the delete+insert cache `id`.
  const order = [
    desc(derivedEntities.count),
    desc(derivedEntities.lastSeen),
    asc(derivedEntities.name)
  ]

  const topPeople = db
    .select({
      name: derivedEntities.name,
      key: derivedEntities.matchKey,
      count: derivedEntities.count
    })
    .from(derivedEntities)
    .where(UNPROMOTED_PERSON)
    .orderBy(...order)
    .limit(5)
    .all()

  const topSubRows = db
    .select({
      name: derivedEntities.name,
      key: derivedEntities.matchKey,
      count: derivedEntities.count,
      attrs: derivedEntities.attrs
    })
    .from(derivedEntities)
    .where(UNTRACKED_SUB)
    .orderBy(...order)
    .limit(5)
    .all()

  const topSubscriptions: OverviewSuggestionItem[] = topSubRows.map((r) => {
    let cadence: string | null = null
    let annualCost: number | null = null
    if (r.attrs) {
      try {
        const a = JSON.parse(r.attrs) as { cadence?: string; annualCost?: number }
        cadence = a.cadence ?? null
        annualCost = a.annualCost ?? null
      } catch {
        /* leave nulls */
      }
    }
    return { name: r.name, key: r.key, count: r.count, cadence, annualCost }
  })

  return {
    storehouse,
    timeline: {
      records: t?.total ?? 0,
      sources: t?.sources ?? 0,
      earliest: t?.earliest ?? null,
      latest: t?.latest ?? null
    },
    suggestions: {
      peopleUnpromoted: countWhere(db, UNPROMOTED_PERSON),
      subscriptionsUntracked: countWhere(db, UNTRACKED_SUB),
      merchants: countWhere(db, eq(derivedEntities.kind, 'merchant')),
      places: countWhere(db, eq(derivedEntities.kind, 'place')),
      topPeople: topPeople.map((r) => ({ name: r.name, key: r.key, count: r.count })),
      topSubscriptions
    }
  }
}

export function registerOverviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('overview:summary', () => buildOverview(getDb(), new Date()))
}
