import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { appSettings } from '../db/schema'

const REQUESTED_SETTING_KEY = 'dataRightsRequested'

type RequestedMap = Record<string, { requestedAt: number }>

function readRequestedMap(db: ReturnType<typeof getDb>): RequestedMap {
  const row = db.select().from(appSettings).where(eq(appSettings.key, REQUESTED_SETTING_KEY)).get()
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RequestedMap) : {}
  } catch {
    return {}
  }
}

function writeRequestedMap(db: ReturnType<typeof getDb>, map: RequestedMap): void {
  const value = JSON.stringify(map)
  db.insert(appSettings)
    .values({ key: REQUESTED_SETTING_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() }
    })
    .run()
}

/**
 * Tracks which Get Your Data sources the user has clicked "Mark as
 * requested" for — a lightweight "I'm waiting on this" state that sits
 * between "not started" and "imported" (which is derived for free from
 * records:facets / connected-integration state, not stored here).
 */
export function registerDataRightsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('data-rights:get-requested', () => {
    const db = getDb()
    return readRequestedMap(db)
  })

  ipcMain.handle('data-rights:mark-requested', (_event, sourceId: string) => {
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('invalid sourceId')
    const db = getDb()
    const map = readRequestedMap(db)
    map[sourceId] = { requestedAt: Date.now() }
    writeRequestedMap(db, map)
    return { success: true }
  })

  ipcMain.handle('data-rights:clear-requested', (_event, sourceId: string) => {
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('invalid sourceId')
    const db = getDb()
    const map = readRequestedMap(db)
    delete map[sourceId]
    writeRequestedMap(db, map)
    return { success: true }
  })
}
