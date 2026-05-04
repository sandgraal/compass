import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAuthHandlers } from './ipc/auth'
import { registerSyncHandlers } from './ipc/sync'
import { registerKnowledgeHandlers } from './ipc/knowledge'
import { registerVaultHandlers } from './ipc/vault'
import { registerSettingsHandlers } from './ipc/settings'
import { initDb } from './db/client'
import { startCronJobs } from './cron'

// Resolve the app data directory
export const APP_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Compass')
export const DATA_DIR = join(APP_DATA_DIR, '.data')
export const VAULT_DIR = join(APP_DATA_DIR, '.vault')
export const KNOWLEDGE_DIR = join(APP_DATA_DIR, 'knowledge-base')

function ensureDirectories(): void {
  for (const dir of [DATA_DIR, VAULT_DIR, KNOWLEDGE_DIR,
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
    mainWindow?.show()
  })

  // Open external links in system browser, not in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev: load vite dev server; Prod: load built index.html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.compass.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ensureDirectories()
  await initDb()
  await seedKnowledgeBase()

  registerAuthHandlers(ipcMain)
  registerSyncHandlers(ipcMain)
  registerKnowledgeHandlers(ipcMain)
  registerVaultHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)

  // Theme sync with system
  ipcMain.handle('get-native-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('native-theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })

  createWindow()
  startCronJobs()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function seedKnowledgeBase(): Promise<void> {
  const { seedKnowledgeFiles } = await import('./knowledge/writer')
  await seedKnowledgeFiles(KNOWLEDGE_DIR)
}
