import type { BrowserWindow, IpcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdaterStatusPayload =
  | { phase: 'checking' }
  | { phase: 'available'; version: string; releaseDate: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number; bytesPerSecond: number; total: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

let getTargetWindow: (() => BrowserWindow | null) | null = null
let updaterInitialized = false
let scheduledCheckTimeout: ReturnType<typeof setTimeout> | null = null
let scheduledCheckInterval: ReturnType<typeof setInterval> | null = null

function currentWindow(): BrowserWindow | null {
  const win = getTargetWindow?.() ?? null
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return win
}

function push(payload: UpdaterStatusPayload): void {
  currentWindow()?.webContents.send('updater:status', payload)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    push({ phase: 'error', message: getErrorMessage(err) })
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  getTargetWindow = getWindow
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  if (updaterInitialized) return
  updaterInitialized = true

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

export function scheduleUpdateChecks(): void {
  if (scheduledCheckTimeout || scheduledCheckInterval) return

  // Initial check 3 s after launch — avoids blocking startup
  scheduledCheckTimeout = setTimeout(() => {
    void checkForUpdates()
  }, 3_000)

  // Periodic check every 4 hours
  scheduledCheckInterval = setInterval(
    () => {
      void checkForUpdates()
    },
    4 * 60 * 60 * 1_000
  )
}

export function registerUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('updater:install-and-restart', () => {
    autoUpdater.quitAndInstall(false, true)
  })
}
