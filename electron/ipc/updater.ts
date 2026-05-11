import type { BrowserWindow, IpcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdaterStatusPayload =
  | { phase: 'checking' }
  | { phase: 'available'; version: string; releaseDate: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number; bytesPerSecond: number; total: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

function push(win: BrowserWindow, payload: UpdaterStatusPayload): void {
  win.webContents.send('updater:status', payload)
}

export function initAutoUpdater(win: BrowserWindow): void {
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => push(win, { phase: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    push(win, {
      phase: 'available',
      version: info.version,
      releaseDate: info.releaseDate ? String(info.releaseDate) : ''
    })
  )

  autoUpdater.on('update-not-available', () => push(win, { phase: 'not-available' }))

  autoUpdater.on('download-progress', (progress) =>
    push(win, {
      phase: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total
    })
  )

  autoUpdater.on('update-downloaded', (info) =>
    push(win, { phase: 'downloaded', version: info.version })
  )

  autoUpdater.on('error', (err) => push(win, { phase: 'error', message: err.message }))
}

export function scheduleUpdateChecks(win: BrowserWindow): void {
  // Initial check 3 s after launch — avoids blocking startup
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      push(win, { phase: 'error', message: String(err) })
    })
  }, 3_000)

  // Periodic check every 4 hours
  setInterval(
    () => {
      void autoUpdater.checkForUpdates().catch((err) => {
        push(win, { phase: 'error', message: String(err) })
      })
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
