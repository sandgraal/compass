import 'dotenv/config'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron'
import { startCronJobs } from './cron'
import { initDb } from './db/client'
import { registerAuthHandlers } from './ipc/auth'
import { registerFinanceHandlers } from './ipc/finance'
import { registerHabitsHandlers } from './ipc/habits'
import { registerKnowledgeHandlers } from './ipc/knowledge'
import { registerSettingsHandlers } from './ipc/settings'
import { registerSyncHandlers } from './ipc/sync'
import { registerVaultHandlers } from './ipc/vault'
import { initMenuBar } from './menu-bar'
import { APP_DATA_DIR, DATA_DIR, KNOWLEDGE_DIR, VAULT_DIR } from './paths'

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
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://gmail.googleapis.com https://api.github.com https://oauth2.googleapis.com https://github.com https://accounts.google.com; frame-src 'none'; object-src 'none'"
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

  registerAuthHandlers(ipcMain)
  registerSyncHandlers(ipcMain)
  registerKnowledgeHandlers(ipcMain)
  registerVaultHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerFinanceHandlers(ipcMain)
  registerHabitsHandlers(ipcMain)

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
  initMenuBar(__dirname)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
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
