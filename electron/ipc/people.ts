/**
 * People IPC — the "Connect" track (Phase 10.7).
 *
 * `people:list` derives the cross-source people directory: it reads only the
 * people-bearing records (the (source, type) combos whose titles name a person)
 * plus the contacts list, then hands them to the pure `buildPeople` aggregator.
 * Read-only, local, no vault. Recomputed on demand like `records:facets`.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { contacts, records } from '../db/schema'
import {
  PEOPLE_RECORD_FILTERS,
  type Person,
  type PersonSourceRow,
  buildPeople
} from '../lib/people'

export function registerPeopleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('people:list', (): Person[] => {
    const db = getDb()
    const rows: PersonSourceRow[] = []
    for (const f of PEOPLE_RECORD_FILTERS) {
      const found = db
        .select({
          source: records.source,
          type: records.type,
          title: records.title,
          occurredAt: records.occurredAt
        })
        .from(records)
        .where(and(eq(records.source, f.source), inArray(records.type, f.types)))
        .all()
      for (const x of found) {
        rows.push({
          source: x.source,
          type: x.type,
          title: x.title,
          occurredAt: x.occurredAt ? x.occurredAt.getTime() : null
        })
      }
    }
    const cs = db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .all()
    return buildPeople(rows, cs)
  })
}
