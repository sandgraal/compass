/**
 * Household & Assets IPC (Phase 9.5 — "The Storehouse").
 *
 * The things you OWN and the policies/memberships around them: property and its
 * value, vehicles, insurance, memberships, warranties, pets. One flat table with
 * a `type` discriminator. Non-secret identifiers (policy #, VIN, membership #)
 * live in `reference`; truly-sensitive numbers stay in the encrypted vault.
 * Exportable to CSV (and bundled into export:export-all).
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { assets } from '../db/schema'
import { serializeCsv } from '../lib/csv'

const MAX_TEXT = 4000
const MAX_NOTES = 20_000

export const ASSET_TYPES = [
  'insurance',
  'vehicle',
  'property',
  'membership',
  'warranty',
  'pet',
  'other'
] as const

export interface AssetInput {
  type?: string
  name: string
  value?: number | null
  provider?: string | null
  reference?: string | null
  renewalDate?: string | null
  status?: string
  notes?: string | null
}

type AssetRow = typeof assets.$inferSelect

function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  const t = String(s)
  return t.length > max ? t.slice(0, max) : t
}

function rowToRecord(row: AssetRow) {
  return {
    id: row.id,
    externalId: row.externalId,
    type: row.type,
    name: row.name,
    value: row.value,
    provider: row.provider,
    reference: row.reference,
    renewalDate: row.renewalDate,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null
  }
}

function toStorage(input: AssetInput) {
  const type = clamp(input.type, 32) || 'other'
  const value =
    input.value == null || !Number.isFinite(Number(input.value)) ? null : Number(input.value)
  return {
    type: (ASSET_TYPES as readonly string[]).includes(type) ? type : 'other',
    name: clamp(input.name, MAX_TEXT) || 'Untitled',
    value,
    provider: clamp(input.provider, MAX_TEXT),
    reference: clamp(input.reference, MAX_TEXT),
    renewalDate: clamp(input.renewalDate, 32),
    status: clamp(input.status, 32) || 'active',
    notes: clamp(input.notes, MAX_NOTES)
  }
}

const CSV_HEADERS = [
  'type',
  'name',
  'value',
  'provider',
  'reference',
  'renewal_date',
  'status',
  'notes'
]

/** All assets as a CSV string. Shared with the Export Center. */
export function buildAssetsCsv(): string {
  const db = getDb()
  const rows = db.select().from(assets).all()
  return serializeCsv(
    rows.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value ?? '',
      provider: r.provider ?? '',
      reference: r.reference ?? '',
      renewal_date: r.renewalDate ?? '',
      status: r.status,
      notes: r.notes ?? ''
    })),
    CSV_HEADERS
  )
}

export function registerAssetsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('assets:list', (_event, opts?: { type?: string }) => {
    const db = getDb()
    const rows = db.select().from(assets).all().map(rowToRecord)
    const filtered = opts?.type ? rows.filter((r) => r.type === opts.type) : rows
    // Group by type order, then biggest value first within a type.
    const typeOrder = (t: string) => {
      const i = (ASSET_TYPES as readonly string[]).indexOf(t)
      return i === -1 ? ASSET_TYPES.length : i
    }
    return filtered.sort(
      (a, b) => typeOrder(a.type) - typeOrder(b.type) || (b.value ?? 0) - (a.value ?? 0)
    )
  })

  ipcMain.handle('assets:create', (_event, input: AssetInput) => {
    if (!input?.name?.trim()) throw new Error('assets:create requires a name')
    const db = getDb()
    const result = db
      .insert(assets)
      .values({
        ...toStorage(input),
        externalId: `manual:${randomUUID()}`,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .run()
    return { success: true, id: Number(result.lastInsertRowid) }
  })

  ipcMain.handle('assets:update', (_event, id: number, updates: AssetInput) => {
    if (!Number.isInteger(id)) throw new Error('assets:update requires an integer id')
    const db = getDb()
    db.update(assets)
      .set({ ...toStorage(updates), updatedAt: new Date() })
      .where(eq(assets.id, id))
      .run()
    return { success: true }
  })

  ipcMain.handle('assets:delete', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('assets:delete requires an integer id')
    const db = getDb()
    db.delete(assets).where(eq(assets.id, id)).run()
    return { success: true }
  })

  ipcMain.handle('assets:export-csv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export assets to CSV',
      defaultPath: 'compass-assets.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      const db = getDb()
      const count = db.select({ id: assets.id }).from(assets).all().length
      writeFileSync(filePath, buildAssetsCsv(), 'utf-8')
      return { success: true, path: filePath, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
