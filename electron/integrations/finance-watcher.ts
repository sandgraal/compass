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
import { type Dirent, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import chokidar from 'chokidar'
import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { Notification } from 'electron'
import { getDb } from '../db/client'
import * as schema from '../db/schema'
import { seedVaultFromDetectedAccounts } from '../ipc/vault'
import { type DetectedAccount, ingestFinanceFiles } from './finance'

// PDF support added Phase-4 follow-up: many banks (USAA, AMEX, Chase, BofA,
// Citi) deliver statements as PDF only. Extraction is handled by
// `finance-pdf.ts`, dispatched lazily from `parseFinanceFile`.
const SUPPORTED_EXTS = ['.csv', '.xlsx', '.pdf']

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
    const { result, detectedAccounts } = await ingestFinanceFiles(
      db,
      files,
      ruleArgs,
      watchedFolder ?? undefined
    )

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
 * Recursively scan a directory (up to MAX_SCAN_DEPTH levels) for
 * supported finance files and queue them. Called once when the watcher
 * starts so previously-dropped files are processed without requiring
 * the user to re-save.
 *
 * Note: deeper than MAX_SCAN_DEPTH is intentionally not watched —
 * performance guardrail for large directory trees.
 */
const MAX_SCAN_DEPTH = 3

function walkFilesWithDepthLimit(
  rootFolder: string,
  maxDepth: number,
  onFile: (path: string) => void
): void {
  const walk = (currentFolder: string, depth: number): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(currentFolder, { withFileTypes: true, encoding: 'utf8' })
    } catch (err) {
      console.warn('[finance-watcher] readdir failed; skipping folder', currentFolder, err)
      return
    }

    for (const entry of entries) {
      const fullPath = join(currentFolder, entry.name)
      if (entry.isFile()) {
        onFile(fullPath)
        continue
      }
      if (entry.isDirectory() && depth < maxDepth) {
        walk(fullPath, depth + 1)
      }
    }
  }

  walk(rootFolder, 0)
}

function initialScan(folder: string): void {
  if (!existsSync(folder)) return
  try {
    walkFilesWithDepthLimit(folder, MAX_SCAN_DEPTH, (path) => {
      if (!SUPPORTED_EXTS.some((ext) => path.toLowerCase().endsWith(ext))) return
      queueFile(path)
    })
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
    depth: MAX_SCAN_DEPTH, // keep watcher depth aligned with the initial scan depth cap
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
  try {
    walkFilesWithDepthLimit(watchedFolder, MAX_SCAN_DEPTH, (path) => {
      if (!SUPPORTED_EXTS.some((ext) => path.toLowerCase().endsWith(ext))) return
      files.push(path)
    })
  } catch (err) {
    console.warn('[finance-watcher] scan failed (folder disappeared between check and scan?)', err)
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
  const out = await ingestFinanceFiles(db, files, ruleArgs, watchedFolder ?? undefined)
  const vaultSeeded = seedVaultFromDetectedAccounts(out.detectedAccounts)
  const payload = { ...out, vaultSeeded }
  emit('ingest-complete', payload)
  return payload
}
