/**
 * Folder watcher for user-owned finance documents (e.g. ~/Documents/Money).
 *
 * Uses chokidar to detect new/changed CSVs and XLSX files in a watched
 * directory and re-ingests them via `ingestFinanceFiles`. Files are NOT
 * moved or modified — dedupe by transaction hash makes re-processing safe.
 *
 * On startup, runs an initial scan of all eligible files in the directory
 * so users who dropped files in before launching the app still see them
 * processed.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import chokidar from 'chokidar'
import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { Notification } from 'electron'
import { getDb } from '../db/client'
import * as schema from '../db/schema'
import { seedVaultFromDetectedAccounts } from '../ipc/vault'
import { type DetectedAccount, ingestFinanceFiles } from './finance'

const SUPPORTED_EXTS = ['.csv', '.xlsx']

let watcher: ReturnType<typeof chokidar.watch> | null = null
let mainWindow: BrowserWindow | null = null
let watchedFolder: string | null = null
let pendingFiles = new Set<string>()
let debounceTimer: NodeJS.Timeout | null = null
const DEBOUNCE_MS = 1500

/**
 * Notify the renderer of a watcher event so the Finance page can refresh.
 */
function emit(event: string, payload: unknown): void {
  mainWindow?.webContents.send(`finance-watcher:${event}`, payload)
}

/**
 * Process the queued files (debounced) and emit the result.
 */
async function flushQueue(): Promise<void> {
  if (pendingFiles.size === 0) return
  const files = Array.from(pendingFiles)
  pendingFiles = new Set()

  const db = getDb()
  const rules = db
    .select()
    .from(schema.categorizationRules)
    .orderBy(schema.categorizationRules.priority)
    .all()
  const ruleArgs = rules.map((r) => ({
    pattern: r.pattern,
    category: r.category,
    subcategory: r.subcategory
  }))

  try {
    const { result, detectedAccounts } = await ingestFinanceFiles(db, files, ruleArgs)

    // Seed stub Vault entries for any newly-detected accounts (idempotent)
    const vaultSeeded = seedVaultFromDetectedAccounts(detectedAccounts)

    // Notify the renderer to refresh
    emit('ingest-complete', { result, detectedAccounts, vaultSeeded })

    // Show a system notification if anything actually changed
    if (result.newTransactions > 0 || detectedAccounts.length > 0) {
      const notifEnabled =
        db
          .select()
          .from(schema.appSettings)
          .where(eq(schema.appSettings.key, 'notificationsEnabled'))
          .get()?.value !== 'false'
      if (notifEnabled && Notification.isSupported()) {
        const parts: string[] = []
        if (result.newTransactions > 0) parts.push(`${result.newTransactions} new transactions`)
        if (detectedAccounts.length > 0) {
          const names = detectedAccounts.map((a) => a.name).join(', ')
          parts.push(`new account${detectedAccounts.length > 1 ? 's' : ''}: ${names}`)
        }
        new Notification({
          title: 'Compass — finance documents updated',
          body: parts.join(' · ')
        }).show()
      }
    }
  } catch (err) {
    console.error('[finance-watcher] ingest failed:', err)
    emit('ingest-error', { error: (err as Error).message })
  }
}

function queueFile(path: string): void {
  if (!SUPPORTED_EXTS.some((ext) => path.toLowerCase().endsWith(ext))) return
  pendingFiles.add(path)
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    flushQueue().catch((err) => console.error('[finance-watcher] flush error:', err))
  }, DEBOUNCE_MS)
}

/**
 * Scan an existing directory for all supported files and queue them.
 * Called once when the watcher starts so previously-dropped files are
 * processed without requiring the user to re-save.
 */
function initialScan(folder: string): void {
  if (!existsSync(folder)) return
  try {
    for (const entry of readdirSync(folder)) {
      const full = join(folder, entry)
      try {
        if (statSync(full).isFile()) queueFile(full)
      } catch {
        /* skip unreadable entries */
      }
    }
  } catch (err) {
    console.error('[finance-watcher] initial scan failed:', err)
  }
}

/**
 * Start (or restart) watching the given folder. Closes the previous
 * watcher if any. Pass null to stop watching entirely.
 */
export async function startFinanceWatcher(
  folder: string | null,
  win?: BrowserWindow | null
): Promise<void> {
  if (win) mainWindow = win
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  watchedFolder = null
  if (!folder || !existsSync(folder)) {
    console.log('[finance-watcher] not watching (folder missing or unset):', folder)
    return
  }
  watchedFolder = folder

  console.log('[finance-watcher] watching', folder)
  initialScan(folder)

  watcher = chokidar.watch(folder, {
    ignoreInitial: true, // initial files handled by initialScan above
    depth: 0, // top-level only
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  watcher.on('add', (path) => {
    console.log('[finance-watcher] add:', path)
    queueFile(path)
  })
  watcher.on('change', (path) => {
    console.log('[finance-watcher] change:', path)
    queueFile(path)
  })
  watcher.on('error', (err) => {
    console.error('[finance-watcher] error:', err)
  })
}

export function getWatchedFolder(): string | null {
  return watchedFolder
}

export async function stopFinanceWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingFiles.clear()
  watchedFolder = null
}

/**
 * Manually trigger an ingest of the watched folder right now (skips debounce).
 * Used by the "Process now" button in the UI.
 */
export async function ingestWatchedFolderNow(): Promise<{
  result: import('./finance').IngestResult
  detectedAccounts: (DetectedAccount & { dbId: number })[]
}> {
  if (!watchedFolder || !existsSync(watchedFolder)) {
    return {
      result: { filesProcessed: 0, newTransactions: 0, duplicatesDropped: 0, perFile: [] },
      detectedAccounts: []
    }
  }

  const files: string[] = []
  for (const entry of readdirSync(watchedFolder)) {
    const full = join(watchedFolder, entry)
    try {
      if (
        statSync(full).isFile() &&
        SUPPORTED_EXTS.some((ext) => entry.toLowerCase().endsWith(ext))
      ) {
        files.push(full)
      }
    } catch {
      /* skip */
    }
  }

  const db = getDb()
  const rules = db
    .select()
    .from(schema.categorizationRules)
    .orderBy(schema.categorizationRules.priority)
    .all()
  const ruleArgs = rules.map((r) => ({
    pattern: r.pattern,
    category: r.category,
    subcategory: r.subcategory
  }))
  const out = await ingestFinanceFiles(db, files, ruleArgs)
  const vaultSeeded = seedVaultFromDetectedAccounts(out.detectedAccounts)
  const payload = { ...out, vaultSeeded }
  emit('ingest-complete', payload)
  return payload
}
