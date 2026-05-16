/**
 * IPC + watcher glue for the Spotlight-friendly knowledge mirror
 * (Phase 5.14). Pure planning lives in
 * `electron/integrations/spotlight-mirror.ts`; this module wires it
 * onto the existing chokidar watcher and exposes the renderer-facing
 * status / configure / backfill calls.
 *
 * State machine:
 *   - settings.spotlightMirrorEnabled = 'true' | 'false' (default 'false')
 *   - settings.spotlightMirrorPath = absolute path (default
 *     `~/Documents/Compass Notes`; must be under ~/Documents or
 *     ~/Desktop or the reconcile call throws)
 *
 * The watcher is started by `startKnowledgeMirrorWatcher()` from
 * `electron/main.ts` after `initDb`. It's safe to call multiple
 * times — the old watcher is closed first.
 */

import { existsSync } from 'node:fs'
import chokidar from 'chokidar'
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { appSettings } from '../db/schema'
import {
  type BackfillResult,
  applyMirrorChange,
  defaultMirrorPath,
  isAllowedMirrorPath,
  reconcileMirror
} from '../integrations/spotlight-mirror'
import { KNOWLEDGE_DIR } from '../paths'

let mirrorWatcher: ReturnType<typeof chokidar.watch> | null = null
let lastError: string | null = null
let lastBackfillAt: number | null = null

interface MirrorConfig {
  enabled: boolean
  path: string
}

function readConfig(): MirrorConfig {
  try {
    const db = getDb()
    const enabledRow = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'spotlightMirrorEnabled'))
      .get()
    const pathRow = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'spotlightMirrorPath'))
      .get()
    return {
      enabled: enabledRow?.value === 'true',
      path: pathRow?.value?.trim() || defaultMirrorPath()
    }
  } catch {
    return { enabled: false, path: defaultMirrorPath() }
  }
}

/**
 * Start (or restart) the mirror watcher. No-op when disabled.
 * Idempotent — closes the existing watcher before starting a new one
 * so a settings change picks up cleanly.
 */
export function startKnowledgeMirrorWatcher(): void {
  if (mirrorWatcher) {
    void mirrorWatcher.close()
    mirrorWatcher = null
  }
  const cfg = readConfig()
  if (!cfg.enabled) return
  if (!isAllowedMirrorPath(cfg.path)) {
    lastError = `Spotlight mirror path is not under ~/Documents or ~/Desktop: ${cfg.path}`
    return
  }
  lastError = null

  const w = chokidar.watch(KNOWLEDGE_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 }
  })
  for (const event of ['add', 'change', 'unlink'] as const) {
    w.on(event, (filePath: string) => {
      try {
        applyMirrorChange(event, KNOWLEDGE_DIR, cfg.path, filePath)
      } catch (err) {
        lastError = (err as Error).message
        console.warn('[spotlight-mirror] apply failed:', lastError)
      }
    })
  }
  mirrorWatcher = w
}

export function registerSpotlightHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('spotlight:get-status', () => {
    const cfg = readConfig()
    return {
      enabled: cfg.enabled,
      path: cfg.path,
      defaultPath: defaultMirrorPath(),
      pathAllowed: isAllowedMirrorPath(cfg.path),
      mirrorExists: existsSync(cfg.path),
      lastError,
      lastBackfillAt
    }
  })

  ipcMain.handle('spotlight:set-enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'enabled must be a boolean' }
    }
    try {
      const db = getDb()
      db.insert(appSettings)
        .values({
          key: 'spotlightMirrorEnabled',
          value: String(enabled),
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: String(enabled), updatedAt: new Date() }
        })
        .run()

      if (enabled) {
        // Backfill before starting the watcher so the user has a fully
        // populated mirror as soon as the toggle flips. Otherwise
        // they'd only see new edits.
        const cfg = readConfig()
        if (!isAllowedMirrorPath(cfg.path)) {
          return {
            success: false,
            error: 'Mirror path must be under ~/Documents or ~/Desktop'
          }
        }
        const result = reconcileMirror(KNOWLEDGE_DIR, cfg.path)
        lastBackfillAt = Date.now()
        startKnowledgeMirrorWatcher()
        return { success: true, result }
      }
      // Disable — keep existing mirrored files in place (the user may
      // still want to read them in Finder / Spotlight), just stop syncing.
      startKnowledgeMirrorWatcher() // restart, observes new disabled state
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('spotlight:set-path', async (_event, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { success: false, error: 'Path must be a non-empty string' }
    }
    if (!isAllowedMirrorPath(path)) {
      return {
        success: false,
        error: 'Mirror path must be under ~/Documents or ~/Desktop'
      }
    }
    try {
      const db = getDb()
      db.insert(appSettings)
        .values({ key: 'spotlightMirrorPath', value: path, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: path, updatedAt: new Date() }
        })
        .run()
      // Restart watcher with the new path. If currently enabled, also
      // run a backfill so the user sees the move atomically.
      const cfg = readConfig()
      if (cfg.enabled) {
        const result = reconcileMirror(KNOWLEDGE_DIR, cfg.path)
        lastBackfillAt = Date.now()
        startKnowledgeMirrorWatcher()
        return { success: true, result }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'spotlight:backfill-now',
    async (): Promise<
      { success: true; result: BackfillResult } | { success: false; error: string }
    > => {
      try {
        const cfg = readConfig()
        if (!isAllowedMirrorPath(cfg.path)) {
          return {
            success: false,
            error: 'Mirror path must be under ~/Documents or ~/Desktop'
          }
        }
        const result = reconcileMirror(KNOWLEDGE_DIR, cfg.path)
        lastBackfillAt = Date.now()
        return { success: true, result }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    }
  )
}

// Exported for tests.
export const _testHooks = {
  resetForTests(): void {
    lastError = null
    lastBackfillAt = null
    if (mirrorWatcher) {
      void mirrorWatcher.close()
      mirrorWatcher = null
    }
  }
}
