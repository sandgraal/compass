import 'dotenv/config'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron'
import { startCronJobs } from './cron'
import { getDb, getRawSqlite, initDb } from './db/client'
import { runVaultLifeMigrationIfNeeded } from './integrations/vault-life-migration'
import { registerArcadiaHandlers } from './ipc/arcadia'
import { registerArgyleHandlers } from './ipc/argyle'
import { registerAssetsHandlers } from './ipc/assets'
import { registerAssistantHandlers } from './ipc/assistant'
import { registerAuthHandlers } from './ipc/auth'
import { registerBackupHandlers } from './ipc/backup'
import { registerCanopyHandlers } from './ipc/canopy'
import { registerClaudeHandlers } from './ipc/claude'
import { registerContactEnrichHandlers } from './ipc/contact-enrich'
import { registerContactsHandlers } from './ipc/contacts'
import { registerCredHandlers } from './ipc/cred'
import { registerCurationHandlers } from './ipc/curation'
import { registerDataRightsHandlers } from './ipc/data-rights'
import { registerDeviceSyncHandlers } from './ipc/device-sync'
import { registerDocumentsHandlers } from './ipc/documents'
import { registerEntitiesHandlers } from './ipc/entities'
import { registerExportHandlers } from './ipc/export'
import { registerFinanceHandlers } from './ipc/finance'
import { registerHabitsHandlers } from './ipc/habits'
import { registerHealthHandlers } from './ipc/health'
import { registerInsightsHandlers } from './ipc/insights'
import { registerDiscoveryHandlers } from './ipc/insights-discovery'
import { registerInsightLifecycleHandlers } from './ipc/insights-lifecycle'
import { registerKnotHandlers } from './ipc/knot'
import { registerKnowledgeHandlers } from './ipc/knowledge'
import { registerLifeRecordsHandlers } from './ipc/life-records'
import { registerLocationHandlers } from './ipc/location'
import { registerMedicalHandlers } from './ipc/medical'
import { registerMerchantsHandlers } from './ipc/merchants'
import { registerMonthlyRollupHandlers } from './ipc/monthly-rollup'
import { registerMorningBriefHandlers } from './ipc/morning-brief'
import { registerNylasHandlers } from './ipc/nylas'
import { registerObsidianHandlers } from './ipc/obsidian'
import { registerOverviewHandlers } from './ipc/overview'
import { registerPeopleHandlers } from './ipc/people'
import { registerPlacesHandlers } from './ipc/places'
import { registerPlaidHandlers } from './ipc/plaid'
import { registerQuickCaptureHandlers } from './ipc/quick-capture'
import {
  registerRecordsHandlers,
  runGenericTelemetryPurgeIfNeeded,
  runNetflixRefileIfNeeded,
  runRecordsReclassifyIfNeeded
} from './ipc/records'
import { registerRelayHandlers } from './ipc/relay'
import { registerSearchHandlers } from './ipc/search'
import { registerSettingsHandlers } from './ipc/settings'
import { registerSimplefinHandlers } from './ipc/simplefin'
import { registerSnaptradeHandlers } from './ipc/snaptrade'
import { registerSpotlightHandlers, startKnowledgeMirrorWatcher } from './ipc/spotlight'
import { registerStorehouseHandlers } from './ipc/storehouse'
import {
  registerStorehouseSyncHandlers,
  runSpineExpansionBackfillIfNeeded
} from './ipc/storehouse-sync'
import { registerSubscriptionsHandlers } from './ipc/subscriptions'
import { registerSyncHandlers } from './ipc/sync'
import { registerTerraHandlers } from './ipc/terra'
import { initAutoUpdater, registerUpdaterHandlers, scheduleUpdateChecks } from './ipc/updater'
import { registerVaultHandlers } from './ipc/vault'
import { registerWeeklyReviewHandlers } from './ipc/weekly-review'
import { ensureDerivedEntities } from './lib/entities-projection'
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
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://gmail.googleapis.com https://api.github.com https://oauth2.googleapis.com https://github.com https://accounts.google.com https://bridge.simplefin.org https://beta-bridge.simplefin.org https://open.er-api.com https://api.ouraring.com https://api.tryterra.co https://api.usecanopy.com https://relay.compass.app; frame-src 'none'; object-src 'none'"
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
    // Backfill the derived-entity cross-reference cache once for DBs whose
    // records predate it (deferred + best-effort so it never blocks startup).
    setImmediate(() => {
      // One-shot: re-derive 'generic' rows whose export family now has a real
      // recognizer (Amazon full export — Prime Video / Kindle / Music / Alexa;
      // device geolocation moves OFF the records spine). Before the entity
      // backfill so the cache is built over the corrected sources.
      try {
        const res = runRecordsReclassifyIfNeeded()
        if (res.ran) {
          console.log(
            `[main] generic records reclassified (${res.moved ?? 0} re-sourced, ${res.located ?? 0} → location_points)`
          )
        }
      } catch (err) {
        console.error('[main] generic reclassify failed:', err)
      }
      // One-shot (user-approved): purge the remaining 'generic' telemetry rows.
      // Must follow the reclassify above — the gate refuses to run before it.
      try {
        const res = runGenericTelemetryPurgeIfNeeded()
        if (res.ran) console.log(`[main] generic telemetry purged (${res.deleted ?? 0} rows)`)
      } catch (err) {
        console.error('[main] generic telemetry purge failed:', err)
      }
      // One-shot: re-file rows the over-greedy Netflix recognizer misclaimed
      // (Prime Video sessions, saved-place lists, bookmarks, notes).
      try {
        const res = runNetflixRefileIfNeeded()
        if (res.ran) {
          console.log(
            `[main] netflix refile (${res.moved ?? 0} re-sourced, ${res.facts ?? 0} → snapshot facts)`
          )
        }
      } catch (err) {
        console.error('[main] netflix refile failed:', err)
      }
      // One-shot spine expansion (data-access policy): project the domains
      // that predate their projectors (habits, tasks, medical, travel,
      // paystubs, utility bills, goals, comps, facts) onto `records`.
      try {
        const res = runSpineExpansionBackfillIfNeeded(getRawSqlite())
        if (res.ran) console.log(`[main] spine expansion backfill (${res.imported} records)`)
      } catch (err) {
        console.error('[main] spine expansion backfill failed:', err)
      }
      // One-shot vault split: move the old vault document categories into the
      // plaintext life_records table (needs safeStorage + DB — can't be a
      // drizzle migration). A failure leaves the gate unset → retried next boot.
      try {
        const res = runVaultLifeMigrationIfNeeded(getRawSqlite())
        if (res.ran && res.categoriesProcessed > 0) {
          console.log(
            `[main] vault → life records migration (${res.migrated} records, ${res.secretsKept} secret fields kept in vault)`
          )
        }
      } catch (err) {
        console.error('[main] vault life-records migration failed (will retry next boot):', err)
      }
      try {
        const { built, count } = ensureDerivedEntities(getDb())
        if (built) console.log(`[main] derived-entity cache built (${count} entities)`)
      } catch (err) {
        console.error('[main] derived-entity backfill failed:', err)
      }
    })
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
  registerLifeRecordsHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerFinanceHandlers(ipcMain)
  registerHabitsHandlers(ipcMain)
  registerHealthHandlers(ipcMain)
  registerMedicalHandlers(ipcMain)
  registerTerraHandlers(ipcMain)
  registerRelayHandlers(ipcMain)
  registerCanopyHandlers(ipcMain)
  registerArgyleHandlers(ipcMain)
  registerSnaptradeHandlers(ipcMain)
  registerArcadiaHandlers(ipcMain)
  registerNylasHandlers(ipcMain)
  registerKnotHandlers(ipcMain)
  registerContactsHandlers(ipcMain)
  registerContactEnrichHandlers(ipcMain)
  registerCurationHandlers(ipcMain)
  registerExportHandlers(ipcMain)
  registerSubscriptionsHandlers(ipcMain)
  registerAssetsHandlers(ipcMain)
  registerStorehouseHandlers(ipcMain)
  registerStorehouseSyncHandlers(ipcMain)
  registerRecordsHandlers(ipcMain)
  registerDocumentsHandlers(ipcMain)
  registerDataRightsHandlers(ipcMain)
  registerPeopleHandlers(ipcMain)
  registerEntitiesHandlers(ipcMain)
  registerPlacesHandlers(ipcMain)
  registerMerchantsHandlers(ipcMain)
  registerLocationHandlers(ipcMain)
  registerOverviewHandlers(ipcMain)
  registerCredHandlers(ipcMain)
  registerClaudeHandlers(ipcMain)
  registerUpdaterHandlers(ipcMain)
  registerBackupHandlers(ipcMain)
  registerDeviceSyncHandlers(ipcMain)
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
  registerDiscoveryHandlers(ipcMain)
  registerInsightLifecycleHandlers(ipcMain)

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
