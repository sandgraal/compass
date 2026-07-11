/**
 * People IPC — the "Connect" track (Phase 10.7), now fed by the cross-reference
 * engine (Phase-2 of the cross-reference work).
 *
 * `people:list` reads the `kind='person'` slice of the `derived_entities`
 * projection — which the engine (`electron/lib/entities.ts`) builds from ALL
 * people-bearing sources, not just the four the original hardcoded filter knew.
 *
 * People PROMOTED to Contacts are filtered out server-side: once someone is a
 * contact they live on the Contacts page (their info keeps flowing into the
 * contact record via enrichment) — People is the discovery surface for everyone
 * who ISN'T one yet. `promotedCount` keeps the header's "in your contacts" line
 * honest. "Not interested" exclusions never reach this query at all — they're
 * filtered out of the cache itself at rebuild (see entities-projection.ts).
 *
 * Read-only, local, no vault. The projection is rebuilt after each import and
 * self-heals on demand via `entities:refresh`.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { derivedEntities } from '../db/schema'
import type { Person } from '../lib/people'

export interface PeopleListResult {
  people: Person[]
  /** How many derived people are already promoted into Contacts (hidden here). */
  promotedCount: number
}

export function registerPeopleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('people:list', (): PeopleListResult => {
    const db = getDb()
    const rows = db
      .select()
      .from(derivedEntities)
      .where(and(eq(derivedEntities.kind, 'person'), isNull(derivedEntities.promotedId)))
      // Stable sort keys (the engine's order) — NOT `id`, which is a delete+insert
      // cache rowid that shuffles between refreshes and would jitter the UI.
      .orderBy(
        desc(derivedEntities.count),
        desc(derivedEntities.lastSeen),
        asc(derivedEntities.name)
      )
      .all()
    const promotedCount =
      db
        .select({ n: sql<number>`count(*)` })
        .from(derivedEntities)
        .where(and(eq(derivedEntities.kind, 'person'), eq(derivedEntities.promotedKind, 'contact')))
        .get()?.n ?? 0
    const people = rows.map((r) => {
      let sources: string[] = []
      try {
        sources = JSON.parse(r.sources) as string[]
      } catch {
        sources = []
      }
      // `attrs` carries the engine's per-entity rollup (JSON) — for people, the
      // P2P money exchanged (Venmo/PayPal) surfaces as totalSpend/currency.
      let totalSpend: number | undefined
      let currency: string | null | undefined
      try {
        const attrs = r.attrs
          ? (JSON.parse(r.attrs) as { totalSpend?: number; currency?: string | null })
          : null
        if (attrs?.totalSpend != null) {
          totalSpend = attrs.totalSpend
          currency = attrs.currency ?? null
        }
      } catch {
        /* malformed attrs → no spend */
      }
      return {
        name: r.name,
        key: r.matchKey,
        count: r.count,
        sources,
        firstSeen: r.firstSeen ? r.firstSeen.getTime() : null,
        lastSeen: r.lastSeen ? r.lastSeen.getTime() : null,
        contactId: null,
        ...(totalSpend != null ? { totalSpend, currency } : {})
      }
    })
    return { people, promotedCount }
  })
}
