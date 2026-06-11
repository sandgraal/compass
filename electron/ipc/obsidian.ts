/**
 * Obsidian vault bridge IPC (Phase 7 Track B). Thin glue over
 * `electron/integrations/obsidian.ts`: configure / inspect / clear the vault
 * path. The sync itself runs through the standard `sync:trigger('obsidian')`
 * dispatch (+ per-integration cron), like every other integration.
 */
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { appSettings, integrations } from '../db/schema'
import {
  VAULT_PATH_SETTING,
  readVaultPathSetting,
  validateVaultPath
} from '../integrations/obsidian'

export interface ObsidianStatus {
  configured: boolean
  vaultPath: string | null
  looksLikeVault: boolean
  error: string | null
}

export function registerObsidianHandlers(ipcMain: IpcMain): void {
  // Re-validates the stored path on every call so a vault that was moved or
  // deleted since configuration surfaces as an error instead of a silent
  // no-op sync.
  ipcMain.handle('obsidian:get-status', (): ObsidianStatus => {
    const stored = readVaultPathSetting()
    if (!stored) {
      return { configured: false, vaultPath: null, looksLikeVault: false, error: null }
    }
    const validation = validateVaultPath(stored)
    if (!validation.ok) {
      return { configured: true, vaultPath: stored, looksLikeVault: false, error: validation.error }
    }
    return {
      configured: true,
      vaultPath: validation.path,
      looksLikeVault: validation.looksLikeVault,
      error: null
    }
  })

  ipcMain.handle('obsidian:set-vault-path', (_event, path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) {
      return { success: false, error: 'Vault path is required' }
    }
    const validation = validateVaultPath(path)
    if (!validation.ok) {
      return { success: false, error: validation.error }
    }
    const db = getDb()
    db.insert(appSettings)
      .values({ key: VAULT_PATH_SETTING, value: validation.path, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: validation.path, updatedAt: new Date() }
      })
      .run()
    db.insert(integrations)
      .values({ service: 'obsidian', status: 'connected', connectedAt: new Date() })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', connectedAt: new Date(), errorMessage: null }
      })
      .run()
    return { success: true, looksLikeVault: validation.looksLikeVault }
  })

  // Disconnect: forget the path and flip the integration row. Files already
  // mirrored (both directions) are left in place — nothing is deleted.
  ipcMain.handle('obsidian:clear', () => {
    const db = getDb()
    db.delete(appSettings).where(eq(appSettings.key, VAULT_PATH_SETTING)).run()
    db.update(integrations)
      .set({ status: 'disconnected', errorMessage: null })
      .where(eq(integrations.service, 'obsidian'))
      .run()
    return { success: true }
  })
}
