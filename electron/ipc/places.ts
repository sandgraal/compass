/**
 * Places & merchants IPC — the owned home for a merchant/place the user promotes
 * out of the derived-entity cache (`entities:promote`). Mirrors the assets/contacts
 * shape: a flat table with a `kind` discriminator, idempotent by a stable
 * `derived:<kind>:<key>` external id so re-promoting is a no-op.
 *
 * Local-only, no vault, no network.
 */

import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { places } from '../db/schema'
import { placeExternalId } from '../lib/entities'

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

export function registerPlacesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('places:list', (): PlaceRecord[] => {
    const db = getDb()
    return db.select().from(places).all().map(rowToRecord)
  })

  ipcMain.handle('places:delete', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('places:delete requires an integer id')
    getDb().delete(places).where(eq(places.id, id)).run()
    return { success: true }
  })
}
