/**
 * People IPC — the "Connect" track (Phase 10.7), now fed by the cross-reference
 * engine (Phase-2 of the cross-reference work).
 *
 * `people:list` reads the `kind='person'` slice of the `derived_entities`
 * projection — which the engine (`electron/lib/entities.ts`) builds from ALL
 * people-bearing sources, not just the four the original hardcoded filter knew.
 * Same `Person` shape as before, so the People page is unchanged; it's just no
 * longer blind to email/messages/payments people once those extractors land.
 *
 * Read-only, local, no vault. The projection is rebuilt after each import and
 * self-heals on demand via `entities:refresh`.
 */

import { asc, desc, eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { derivedEntities } from '../db/schema'
import type { Person } from '../lib/people'

export function registerPeopleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('people:list', (): Person[] => {
    const db = getDb()
    const rows = db
      .select()
      .from(derivedEntities)
      .where(eq(derivedEntities.kind, 'person'))
      .orderBy(desc(derivedEntities.count), asc(derivedEntities.id))
      .all()
    return rows.map((r) => {
      let sources: string[] = []
      try {
        sources = JSON.parse(r.sources) as string[]
      } catch {
        sources = []
      }
      return {
        name: r.name,
        key: r.matchKey,
        count: r.count,
        sources,
        firstSeen: r.firstSeen ? r.firstSeen.getTime() : null,
        lastSeen: r.lastSeen ? r.lastSeen.getTime() : null,
        contactId: r.promotedKind === 'contact' ? (r.promotedId ?? null) : null
      }
    })
  })
}
