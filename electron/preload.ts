import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'
import type { UpdaterStatusPayload } from './ipc/updater'

function isUpdaterStatusPayload(data: unknown): data is UpdaterStatusPayload {
  if (!data || typeof data !== 'object' || !('phase' in data)) return false
  const payload = data as Record<string, unknown>

  switch (payload.phase) {
    case 'checking':
    case 'not-available':
      return true
    case 'available':
      return typeof payload.version === 'string' && typeof payload.releaseDate === 'string'
    case 'downloading':
      return (
        typeof payload.percent === 'number' &&
        typeof payload.bytesPerSecond === 'number' &&
        typeof payload.total === 'number'
      )
    case 'downloaded':
      return typeof payload.version === 'string'
    case 'error':
      return typeof payload.message === 'string'
    default:
      return false
  }
}

// Typed API exposed to the renderer via contextBridge
// The renderer has ZERO direct access to Node.js or Electron internals
const api = {
  // --- Auth ---
  auth: {
    connectGoogle: () => ipcRenderer.invoke('auth:connect-google'),
    connectGitHub: () => ipcRenderer.invoke('auth:connect-github'),
    connectGitHubWithPAT: (token: string) => ipcRenderer.invoke('auth:connect-github-pat', token),
    disconnect: (service: string) => ipcRenderer.invoke('auth:disconnect', service),
    getStatus: () => ipcRenderer.invoke('auth:get-status'),
    getRedirectUris: () => ipcRenderer.invoke('auth:get-redirect-uris')
  },

  // --- Sync ---
  sync: {
    triggerSync: (service: string) => ipcRenderer.invoke('sync:trigger', service),
    triggerAllSync: () => ipcRenderer.invoke('sync:trigger-all'),
    getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
    getLog: () => ipcRenderer.invoke('sync:get-log'),
    setInterval: (service: string, minutes: number) =>
      ipcRenderer.invoke('sync:set-interval', service, minutes),
    onSyncUpdate: (cb: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('sync:update', listener)
      return () => ipcRenderer.removeListener('sync:update', listener)
    }
  },

  // --- Knowledge Base ---
  knowledge: {
    listFiles: () => ipcRenderer.invoke('knowledge:list-files'),
    readFile: (relativePath: string) => ipcRenderer.invoke('knowledge:read-file', relativePath),
    writeFile: (relativePath: string, content: string) =>
      ipcRenderer.invoke('knowledge:write-file', relativePath, content),
    createFile: (relativePath: string, title: string) =>
      ipcRenderer.invoke('knowledge:create-file', relativePath, title),
    deleteFile: (relativePath: string) => ipcRenderer.invoke('knowledge:delete-file', relativePath),
    search: (query: string) => ipcRenderer.invoke('knowledge:search', query),
    getPrev: (path: string) => ipcRenderer.invoke('knowledge:get-prev', path),
    onFileChanged: (cb: (path: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => cb(path)
      ipcRenderer.on('knowledge:file-changed', listener)
      return () => ipcRenderer.removeListener('knowledge:file-changed', listener)
    },
    listSuggestions: (targetPath?: string) =>
      ipcRenderer.invoke('knowledge:list-suggestions', targetPath),
    acceptSuggestion: (id: number) => ipcRenderer.invoke('knowledge:accept-suggestion', id),
    dismissSuggestion: (id: number) => ipcRenderer.invoke('knowledge:dismiss-suggestion', id),
    getBacklinks: (path: string) => ipcRenderer.invoke('knowledge:get-backlinks', path),
    // Tier 2 #6 — semantic search via local Ollama embeddings
    getEmbeddingStatus: () => ipcRenderer.invoke('knowledge:get-embedding-status'),
    rebuildEmbeddings: () => ipcRenderer.invoke('knowledge:rebuild-embeddings'),
    semanticSearch: (query: string) => ipcRenderer.invoke('knowledge:semantic-search', query)
  },

  // --- Global search (May 2026 Tier 1 #3) ---
  search: {
    global: (query: string) => ipcRenderer.invoke('search:global', query)
  },

  // --- Ask Compass (May 2026 Tier 2 #7 — BYO LLM key) ---
  assistant: {
    getStatus: () => ipcRenderer.invoke('assistant:get-status'),
    setKey: (provider: 'anthropic' | 'openai', key: string) =>
      ipcRenderer.invoke('assistant:set-key', provider, key),
    clearKey: (provider?: 'anthropic' | 'openai') =>
      ipcRenderer.invoke('assistant:clear-key', provider),
    setActiveProvider: (provider: 'anthropic' | 'openai') =>
      ipcRenderer.invoke('assistant:set-active-provider', provider),
    setModel: (provider: 'anthropic' | 'openai', model: string) =>
      ipcRenderer.invoke('assistant:set-model', provider, model),
    ask: (payload: {
      question: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }) => ipcRenderer.invoke('assistant:ask', payload),
    cancel: () => ipcRenderer.invoke('assistant:cancel')
  },

  // --- Encrypted backup / restore (May 2026 Tier 1 #2) ---
  backup: {
    create: (passphrase: string) => ipcRenderer.invoke('backup:create', passphrase),
    restore: (passphrase: string) => ipcRenderer.invoke('backup:restore', passphrase)
  },

  // --- Spotlight-friendly knowledge mirror (Phase 5.14) ---
  spotlight: {
    getStatus: () => ipcRenderer.invoke('spotlight:get-status'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('spotlight:set-enabled', enabled),
    setPath: (path: string) => ipcRenderer.invoke('spotlight:set-path', path),
    backfillNow: () => ipcRenderer.invoke('spotlight:backfill-now')
  },

  // --- Plaid (Phase 4.6 — bank Link flow) ---
  plaid: {
    getStatus: () => ipcRenderer.invoke('plaid:get-status'),
    setSecret: (env: 'sandbox' | 'production', secret: string) =>
      ipcRenderer.invoke('plaid:set-secret', env, secret),
    startLink: () => ipcRenderer.invoke('plaid:start-link'),
    disconnect: (itemId: string) => ipcRenderer.invoke('plaid:disconnect', itemId)
  },

  // --- Vault (Sensitive Data) ---
  vault: {
    getCategories: () => ipcRenderer.invoke('vault:get-categories'),
    getEntries: (category: string) => ipcRenderer.invoke('vault:get-entries', category),
    addEntry: (category: string, entry: unknown) =>
      ipcRenderer.invoke('vault:add-entry', category, entry),
    updateEntry: (category: string, id: string, entry: unknown) =>
      ipcRenderer.invoke('vault:update-entry', category, id, entry),
    deleteEntry: (category: string, id: string) =>
      ipcRenderer.invoke('vault:delete-entry', category, id),
    setContentProtection: (enabled: boolean) =>
      ipcRenderer.send('vault:set-content-protection', enabled),
    import1Password: () => ipcRenderer.invoke('vault:import-1password-csv')
  },

  // --- Checklist ---
  checklist: {
    getItems: (listType: string, date: string) =>
      ipcRenderer.invoke('checklist:get-items', listType, date),
    addItem: (item: unknown) => ipcRenderer.invoke('checklist:add-item', item),
    updateItem: (id: number, updates: unknown) =>
      ipcRenderer.invoke('checklist:update-item', id, updates),
    deleteItem: (id: number) => ipcRenderer.invoke('checklist:delete-item', id),
    rollOver: (fromDate: string, toDate: string) =>
      ipcRenderer.invoke('checklist:roll-over', fromDate, toDate),
    getTemplate: (listType: string) => ipcRenderer.invoke('checklist:get-template', listType),
    saveTemplate: (listType: string, content: string) =>
      ipcRenderer.invoke('checklist:save-template', listType, content)
  },

  // --- Calendar Events ---
  calendar: {
    getEvents: (start: string, end: string) => ipcRenderer.invoke('calendar:get-events', start, end)
  },

  // --- GitHub Items ---
  github: {
    getItems: (state?: string) => ipcRenderer.invoke('github:get-items', state)
  },

  // --- Gmail Actions ---
  gmail: {
    getActions: (done?: boolean) => ipcRenderer.invoke('gmail:get-actions', done),
    markDone: (id: number) => ipcRenderer.invoke('gmail:mark-done', id)
  },

  // --- Settings ---
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    openDataDir: () => ipcRenderer.invoke('settings:open-data-dir'),
    wipeKnowledge: () => ipcRenderer.invoke('settings:wipe-knowledge'),
    wipeVault: () => ipcRenderer.invoke('settings:wipe-vault'),
    exportData: () => ipcRenderer.invoke('settings:export-data'),
    setQuickCaptureShortcut: (accelerator: string) =>
      ipcRenderer.invoke('settings:set-quick-capture-shortcut', accelerator),
    detectOllama: (options?: { forceRefresh?: boolean }) =>
      ipcRenderer.invoke('settings:detect-ollama', options)
  },

  // --- Habits ---
  habits: {
    list: (includeInactive?: boolean) => ipcRenderer.invoke('habits:list', includeInactive),
    create: (habit: { name: string; icon?: string; color?: string }) =>
      ipcRenderer.invoke('habits:create', habit),
    update: (
      id: number,
      updates: { name?: string; icon?: string; color?: string; active?: boolean }
    ) => ipcRenderer.invoke('habits:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('habits:delete', id),
    getEntries: (month: string) => ipcRenderer.invoke('habits:get-entries', month),
    getAllEntries: () => ipcRenderer.invoke('habits:get-all-entries'),
    toggle: (habitId: number, date: string) => ipcRenderer.invoke('habits:toggle', habitId, date)
  },

  // --- Finance ---
  finance: {
    ingestFolder: (folder?: string) => ipcRenderer.invoke('finance:ingest-folder', folder),
    getTransactions: (opts?: {
      month?: string
      category?: string
      accountId?: number
      limit?: number
    }) => ipcRenderer.invoke('finance:get-transactions', opts),
    updateTransaction: (
      id: number,
      updates: {
        category?: string
        subcategory?: string
        notes?: string
        accountId?: number | null
      }
    ) => ipcRenderer.invoke('finance:update-transaction', id, updates),
    deleteTransaction: (id: number) => ipcRenderer.invoke('finance:delete-transaction', id),
    getAccounts: () => ipcRenderer.invoke('finance:get-accounts'),
    upsertAccount: (account: {
      id?: number
      name: string
      type: string
      isDebt?: boolean
      balance?: number
      apr?: number
      minPayment?: number
      creditLimit?: number
    }) => ipcRenderer.invoke('finance:upsert-account', account),
    deleteAccount: (id: number) => ipcRenderer.invoke('finance:delete-account', id),
    getDebtSummary: () => ipcRenderer.invoke('finance:get-debt-summary'),
    getUpcomingPayments: (daysAhead?: number) =>
      ipcRenderer.invoke('finance:get-upcoming-payments', daysAhead),
    getBudgetStatus: (month?: string) => ipcRenderer.invoke('finance:get-budget-status', month),
    setBudget: (line: { category: string; subcategory?: string; monthlyAmount: number }) =>
      ipcRenderer.invoke('finance:set-budget', line),
    getRules: () => ipcRenderer.invoke('finance:get-rules'),
    saveRule: (rule: {
      id?: number
      pattern: string
      category: string
      subcategory?: string
      priority?: number
    }) => ipcRenderer.invoke('finance:save-rule', rule),
    deleteRule: (id: number) => ipcRenderer.invoke('finance:delete-rule', id),
    reapplyRules: () => ipcRenderer.invoke('finance:reapply-rules'),
    getSubscriptions: () => ipcRenderer.invoke('finance:get-subscriptions'),
    getGeoSummary: (opts?: { since?: string }) =>
      ipcRenderer.invoke('finance:get-geo-summary', opts),
    getTaxSummary: (opts?: { year?: number }) =>
      ipcRenderer.invoke('finance:get-tax-summary', opts),
    setTransactionTaxTag: (id: number, taxTag: string) =>
      ipcRenderer.invoke('finance:set-transaction-tax-tag', id, taxTag),
    exportTaxPack: (opts?: { year?: number }) =>
      ipcRenderer.invoke('finance:export-tax-pack', opts),

    // Net worth (Phase 4.4)
    getNetWorthSnapshot: () => ipcRenderer.invoke('finance:get-net-worth-snapshot'),
    getNetWorthTrajectory: (opts?: { sinceDays?: number; untilMs?: number }) =>
      ipcRenderer.invoke('finance:get-net-worth-trajectory', opts),
    captureSnapshot: () => ipcRenderer.invoke('finance:capture-snapshot'),
    setAccountBalance: (accountId: number, balance: number) =>
      ipcRenderer.invoke('finance:set-account-balance', accountId, balance),

    // Cash-flow forecast (Phase 4.5)
    getForecast: (opts?: { windowDays?: number; lowCashThreshold?: number }) =>
      ipcRenderer.invoke('finance:get-forecast', opts),
    setForecastOverride: (override: {
      accountId: number
      date: string
      label: string
      kind: 'skip' | 'shift' | 'override'
      amount?: number | null
      shiftToDate?: string | null
    }) => ipcRenderer.invoke('finance:set-forecast-override', override),
    deleteForecastOverride: (accountId: number, date: string, label: string) =>
      ipcRenderer.invoke('finance:delete-forecast-override', accountId, date, label),

    getInboxPath: () => ipcRenderer.invoke('finance:get-inbox-path'),

    // Watched folder (source-of-truth, e.g. ~/Documents/Money)
    getWatchFolder: () => ipcRenderer.invoke('finance:get-watch-folder'),
    setWatchFolder: (folder: string | null) =>
      ipcRenderer.invoke('finance:set-watch-folder', folder),
    pickWatchFolder: () => ipcRenderer.invoke('finance:pick-watch-folder'),
    ingestWatchedNow: () => ipcRenderer.invoke('finance:ingest-watched-now'),
    stopWatching: () => ipcRenderer.invoke('finance:stop-watching'),
    onIngestComplete: (cb: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('finance-watcher:ingest-complete', listener)
      return () => ipcRenderer.removeListener('finance-watcher:ingest-complete', listener)
    },
    onIngestError: (cb: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('finance-watcher:ingest-error', listener)
      return () => ipcRenderer.removeListener('finance-watcher:ingest-error', listener)
    },
    onRulesReapplied: (cb: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('finance:rules-reapplied', listener)
      return () => ipcRenderer.removeListener('finance:rules-reapplied', listener)
    }
  },

  // --- Auto-updater ---
  updater: {
    getVersion: () => ipcRenderer.invoke('updater:get-version'),
    check: () => ipcRenderer.invoke('updater:check'),
    // send (not invoke) — quitAndInstall never returns, so there's no reply to await
    installAndRestart: () => ipcRenderer.send('updater:install-and-restart'),
    openReleasePage: (tag: string) => ipcRenderer.invoke('updater:open-release-page', tag),
    onStatus: (cb: (data: UpdaterStatusPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
        if (isUpdaterStatusPayload(data)) cb(data)
      }
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    }
  },

  // --- compass:// URL scheme events (May 2026 Tier 3 #11) ---
  // The main process pushes these when a URL like `compass://open/<page>`
  // or `compass://search?q=…` arrives. Capture events stay in main —
  // the renderer just gets a notification.
  urlScheme: {
    onCaptured: (cb: (data: { title: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { title: string }): void =>
        cb(data)
      ipcRenderer.on('compass-url:captured', listener)
      return () => ipcRenderer.removeListener('compass-url:captured', listener)
    },
    onOpen: (cb: (data: { page: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { page: string }): void => cb(data)
      ipcRenderer.on('compass-url:open', listener)
      return () => ipcRenderer.removeListener('compass-url:open', listener)
    },
    onSearch: (cb: (data: { query: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { query: string }): void =>
        cb(data)
      ipcRenderer.on('compass-url:search', listener)
      return () => ipcRenderer.removeListener('compass-url:search', listener)
    }
  },

  // --- Theme ---
  theme: {
    getNativeTheme: () => ipcRenderer.invoke('get-native-theme'),
    onThemeChange: (cb: (theme: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, theme: string) => cb(theme)
      ipcRenderer.on('native-theme-changed', listener)
      return () => ipcRenderer.removeListener('native-theme-changed', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
