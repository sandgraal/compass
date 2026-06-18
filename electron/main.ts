import 'dotenv/config'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron'
import { startCronJobs } from './cron'
import { initDb } from './db/client'
import { registerAssetsHandlers } from './ipc/assets'
import { registerAssistantHandlers } from './ipc/assistant'
import { registerAuthHandlers } from './ipc/auth'
import { registerBackupHandlers } from './ipc/backup'
import { registerClaudeHandlers } from './ipc/claude'
import { registerContactsHandlers } from './ipc/contacts'
import { registerCredHandlers } from './ipc/cred'
import { registerExportHandlers } from './ipc/export'
import { registerFinanceHandlers } from './ipc/finance'
import { registerHabitsHandlers } from './ipc/habits'
import { registerInsightsHandlers } from './ipc/insights'
import { registerKnowledgeHandlers } from './ipc/knowledge'
import { registerMonthlyRollupHandlers } from './ipc/monthly-rollup'
import { registerMorningBriefHandlers } from './ipc/morning-brief'
import { registerObsidianHandlers } from './ipc/obsidian'
import { registerPlaidHandlers } from './ipc/plaid'
import { registerQuickCaptureHandlers } from './ipc/quick-capture'
import { registerRecordsHandlers } from './ipc/records'
import { registerSearchHandlers } from './ipc/search'
import { registerSettingsHandlers } from './ipc/settings'
import { registerSimplefinHandlers } from './ipc/simplefin'
import { registerSpotlightHandlers, startKnowledgeMirrorWatcher } from './ipc/spotlight'
import { registerStorehouseHandlers } from './ipc/storehouse'
import { registerSubscriptionsHandlers } from './ipc/subscriptions'
import { registerSyncHandlers } from './ipc/sync'
import { initAutoUpdater, registerUpdaterHandlers, scheduleUpdateChecks } from './ipc/updater'
import { registerVaultHandlers } from './ipc/vault'
import { registerWeeklyReviewHandlers } from './ipc/weekly-review'
import { initMenuBar } from './menu-bar'
import { APP_DATA_DIR, DATA_DIR, KNOWLEDGE_DIR, VAULT_DIR } from './paths'
import { registerCompassUrlScheme } from './url-scheme'

export { APP_DATA_DIR, DATA_DIR, VAULT_DIR, KNOWLEDGE_DIR }

function ensureDirectories(): void {
  for (const dir of [
    DATA_DIR,
    VAULT_DIR,
    KNOWLEDGE_DIR,
    join(KNOWLEDGE_DIR, 'profile'),
    join(KNOWLEDGE_DIR, 'work'),
    join(KNOWLEDGE_DIR, 'calendar'),
    join(KNOWLEDGE_DIR, 'inbox'),
    join(KNOWLEDGE_DIR, 'drive'),
    join(KNOWLEDGE_DIR, 'templates')
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

let mainWindow: BrowserWindow | null = null

// Register the `compass://` URL scheme BEFORE app.whenReady — the
// `open-url` event on macOS can fire as soon as the app launches, and
// `requestSingleInstanceLock()` has to run early to deduplicate
// second-instance launches on Windows/Linux.
const urlScheme = registerCompassUrlScheme(() => mainWindow)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // CSP: no eval, no remote resources loaded directly
      allowRunningInsecureContent: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    console.log('[main] ready-to-show — showing window')
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] did-fail-load:', errorCode, errorDescription)
  })

  // Open external links in system browser, not in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // CSP: only enforce in production (dev server needs ws:// for HMR + eval for source maps)
  if (!is.dev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://gmail.googleapis.com https://api.github.com https://oauth2.googleapis.com https://github.com https://accounts.google.com https://bridge.simplefin.org https://beta-bridge.simplefin.org; frame-src 'none'; object-src 'none'"
          ]
        }
      })
    })
  }

  // Dev: load vite dev server; Prod: load built index.html
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.compass.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    ensureDirectories()
    console.log('[main] directories ensured')
    await initDb()
    console.log('[main] db initialized')
    await seedKnowledgeBase()
    console.log('[main] knowledge base seeded')
  } catch (err) {
    console.error('[main] startup error:', err)
  }

  registerAssistantHandlers(ipcMain)
  registerAuthHandlers(ipcMain)
  registerSyncHandlers(ipcMain)
  registerKnowledgeHandlers(ipcMain)
  registerVaultHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerFinanceHandlers(ipcMain)
  registerHabitsHandlers(ipcMain)
  registerContactsHandlers(ipcMain)
  registerExportHandlers(ipcMain)
  registerSubscriptionsHandlers(ipcMain)
  registerAssetsHandlers(ipcMain)
  registerStorehouseHandlers(ipcMain)
  registerRecordsHandlers(ipcMain)
  registerCredHandlers(ipcMain)
  registerClaudeHandlers(ipcMain)
  registerUpdaterHandlers(ipcMain)
  registerBackupHandlers(ipcMain)
  registerSearchHandlers(ipcMain)
  registerSpotlightHandlers(ipcMain)
  registerPlaidHandlers(ipcMain)
  registerSimplefinHandlers(ipcMain)
  registerMorningBriefHandlers(ipcMain)
  registerWeeklyReviewHandlers(ipcMain)
  registerMonthlyRollupHandlers(ipcMain)
  registerQuickCaptureHandlers(ipcMain)
  registerObsidianHandlers(ipcMain)
  registerInsightsHandlers(ipcMain)

  // Toggle content protection when navigating to/from vault
  ipcMain.on('vault:set-content-protection', (_event, enabled: boolean) => {
    mainWindow?.setContentProtection(enabled)
  })

  // Theme sync with system
  ipcMain.handle('get-native-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send(
      'native-theme-changed',
      nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    )
  })

  const startOrRefreshFinanceWatcher = async (): Promise<void> => {
    // Start or refresh the finance folder watcher (defaults to ~/Documents/Money)
    try {
      const { getMoneyFolder } = await import('./ipc/finance')
      const { startFinanceWatcher } = await import('./integrations/finance-watcher')
      void startFinanceWatcher(getMoneyFolder(), mainWindow)
    } catch (err) {
      console.error('[main] finance watcher failed to start:', err)
    }
  }

  createWindow()
  startCronJobs()
  await startOrRefreshFinanceWatcher()
  // Spotlight mirror — no-op when the setting is disabled. Safe to call
  // unconditionally; it reads its own enabled flag from app_settings.
  // Fire-and-forget at startup; the resolve happens in the background
  // and any error is captured in the IPC's `lastError`.
  void startKnowledgeMirrorWatcher()
  initMenuBar(__dirname)
  // Drain any compass:// URLs that arrived before the window existed.
  urlScheme.pump()

  if (!is.dev) {
    initAutoUpdater()
    scheduleUpdateChecks()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      if (!is.dev) initAutoUpdater()
      void startOrRefreshFinanceWatcher()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function seedKnowledgeBase(): Promise<void> {
  const { seedKnowledgeFiles } = await import('./knowledge/writer')
  await seedKnowledgeFiles(KNOWLEDGE_DIR)
}
