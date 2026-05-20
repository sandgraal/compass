import { BrowserWindow, type IpcMain, app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdaterStatusPayload =
  | { phase: 'checking' }
  | { phase: 'available'; version: string; releaseDate: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number; bytesPerSecond: number; total: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

/**
 * Send a status event to the main window, guarding against destroyed windows.
 * Excludes always-on-top windows (e.g. the quick-capture popover, OAuth flows)
 * so the event always reaches the correct renderer.
 */
function push(payload: UpdaterStatusPayload): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isAlwaysOnTop())
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('updater:status', payload)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Module-level flag — prevents duplicate listener registration if initAutoUpdater is called
// more than once (e.g. on macOS window re-creation).
let listenersRegistered = false

/**
 * Configure autoUpdater and wire all events to the renderer.
 * Safe to call multiple times — listeners are only registered once.
 * Call in production only (!is.dev).
 */
export function initAutoUpdater(): void {
  autoUpdater.logger = null // suppress file-based log noise
  // Don't auto-download. CI publishes unsigned macOS builds (no Apple Developer
  // certs in CSC_LINK / CSC_KEY_PASSWORD), and Squirrel.Mac silently refuses to
  // install unsigned updates — `quitAndInstall()` returns without doing anything,
  // leaving the app in a download-loop. Until we either sign the build or stand
  // up a signing pipeline, the banner just announces the new version and links
  // to the GitHub release; the user installs the .dmg manually.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  if (listenersRegistered) return
  listenersRegistered = true

  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    push({
      phase: 'available',
      version: info.version,
      releaseDate: info.releaseDate ? String(info.releaseDate) : ''
    })
  )

  autoUpdater.on('update-not-available', () => push({ phase: 'not-available' }))

  autoUpdater.on('download-progress', (progress) =>
    push({
      phase: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total
    })
  )

  autoUpdater.on('update-downloaded', (info) =>
    push({ phase: 'downloaded', version: info.version })
  )

  autoUpdater.on('error', (err) => push({ phase: 'error', message: getErrorMessage(err) }))
}

/**
 * Schedule automatic background update checks.
 * Call AFTER initAutoUpdater(), in production only.
 */
export function scheduleUpdateChecks(): void {
  // Initial check 3 s after launch — avoids blocking startup
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      push({ phase: 'error', message: getErrorMessage(err) })
    })
  }, 3_000)

  // Re-check every 4 hours
  setInterval(
    () => {
      void autoUpdater.checkForUpdates().catch((err) => {
        push({ phase: 'error', message: getErrorMessage(err) })
      })
    },
    4 * 60 * 60 * 1_000
  )
}

export function registerUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('updater:get-version', () => app.getVersion())

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Open the GitHub release page for a given tag in the user's default browser.
  // Used by the UpdateBanner now that auto-install is disabled (see
  // initAutoUpdater for the unsigned-builds rationale). Validates the tag
  // shape so a compromised renderer can't aim shell.openExternal at arbitrary URLs.
  ipcMain.handle('updater:open-release-page', (_event, tag: string) => {
    if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(tag)) {
      throw new Error(`Invalid release tag: ${String(tag)}`)
    }
    const normalized = tag.startsWith('v') ? tag : `v${tag}`
    return shell.openExternal(`https://github.com/sandgraal/compass/releases/tag/${normalized}`)
  })

  // Fire-and-forget: quitAndInstall never returns, so use send not invoke.
  // Kept for compatibility with installed older builds that still call it,
  // and in case CI starts signing macOS builds in the future. With
  // autoDownload=false this only fires if a user manually triggers the
  // legacy "Restart to Install" button on an old build.
  ipcMain.on('updater:install-and-restart', () => {
    autoUpdater.quitAndInstall(false, true)
  })
}
