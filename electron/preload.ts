import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AssetInput } from './ipc/assets'
import type { ContactInput } from './ipc/contacts'
import type { SubscriptionInput } from './ipc/subscriptions'
import type { UpdaterStatusPayload } from './ipc/updater'

type SubscriptionDraft = SubscriptionInput
type DetectedSubscriptionInput = {
  merchant: string
  account: string
  category?: string | null
  cadence?: string
  medianAmount?: number
}

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
    setGoogleCredentials: (clientId: string, clientSecret: string) =>
      ipcRenderer.invoke('auth:set-google-credentials', clientId, clientSecret),
    hasGoogleCredentials: () => ipcRenderer.invoke('auth:has-google-credentials'),
    clearGoogleCredentials: () => ipcRenderer.invoke('auth:clear-google-credentials'),
    connectGitHub: () => ipcRenderer.invoke('auth:connect-github'),
    connectGitHubWithPAT: (token: string) => ipcRenderer.invoke('auth:connect-github-pat', token),
    connectNotion: (token: string) => ipcRenderer.invoke('auth:connect-notion', token),
    connectLinear: (token: string) => ipcRenderer.invoke('auth:connect-linear', token),
    connectTodoist: (token: string) => ipcRenderer.invoke('auth:connect-todoist', token),
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
    testKey: (provider: 'anthropic' | 'openai') =>
      ipcRenderer.invoke('assistant:test-key', provider),
    ask: (payload: {
      question: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }) => ipcRenderer.invoke('assistant:ask', payload),
    agent: (payload: {
      question: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }) => ipcRenderer.invoke('assistant:agent', payload),
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

  // --- Obsidian vault bridge (Phase 7 Track B) ---
  obsidian: {
    getStatus: () => ipcRenderer.invoke('obsidian:get-status'),
    setVaultPath: (path: string) => ipcRenderer.invoke('obsidian:set-vault-path', path),
    clear: () => ipcRenderer.invoke('obsidian:clear')
  },

  // --- Proactive insights (Phase 7 Track E) ---
  insights: {
    get: () => ipcRenderer.invoke('insights:get')
  },

  // --- Plaid (Phase 4.6 — bank Link flow) ---
  plaid: {
    getStatus: () => ipcRenderer.invoke('plaid:get-status'),
    setConfig: (clientId: string, env: 'sandbox' | 'production') =>
      ipcRenderer.invoke('plaid:set-config', clientId, env),
    setSecret: (env: 'sandbox' | 'production', secret: string) =>
      ipcRenderer.invoke('plaid:set-secret', env, secret),
    startLink: () => ipcRenderer.invoke('plaid:start-link'),
    disconnect: (itemId: string) => ipcRenderer.invoke('plaid:disconnect', itemId),
    listItems: () => ipcRenderer.invoke('plaid:list-items')
  },

  // --- SimpleFIN (Phase 4.7 — user-owned bank sync) ---
  simplefin: {
    getStatus: () => ipcRenderer.invoke('simplefin:get-status'),
    claimToken: (setupToken: string) => ipcRenderer.invoke('simplefin:claim-token', setupToken),
    listConnections: () => ipcRenderer.invoke('simplefin:list-connections'),
    disconnect: (connectionId: string) => ipcRenderer.invoke('simplefin:disconnect', connectionId)
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

  // --- Morning Brief digest ---
  morningBrief: {
    get: () => ipcRenderer.invoke('morning-brief:get')
  },

  // --- Weekly review ritual ---
  weeklyReview: {
    get: (weekStart: string) => ipcRenderer.invoke('weekly-review:get', weekStart),
    carryOver: (weekStart: string, toDate?: string) =>
      ipcRenderer.invoke('weekly-review:carry-over', weekStart, toDate)
  },

  // --- Monthly rollup ---
  monthlyRollup: {
    get: (month: string) => ipcRenderer.invoke('monthly-rollup:get', month)
  },

  // --- GitHub Items ---
  linear: {
    getItems: () => ipcRenderer.invoke('linear:get-items')
  },

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

  // --- Contacts (Phase 9 — "The Storehouse") ---
  contacts: {
    list: (opts?: { search?: string }) => ipcRenderer.invoke('contacts:list', opts),
    get: (id: number) => ipcRenderer.invoke('contacts:get', id),
    create: (input: ContactInput) => ipcRenderer.invoke('contacts:create', input),
    update: (id: number, updates: ContactInput) =>
      ipcRenderer.invoke('contacts:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('contacts:delete', id),
    importVcard: () => ipcRenderer.invoke('contacts:import-vcard'),
    importCsv: () => ipcRenderer.invoke('contacts:import-csv'),
    importLinkedin: () => ipcRenderer.invoke('contacts:import-linkedin'),
    importFacebook: () => ipcRenderer.invoke('contacts:import-facebook'),
    importGvoice: () => ipcRenderer.invoke('contacts:import-gvoice'),
    exportVcard: (ids?: number[]) => ipcRenderer.invoke('contacts:export-vcard', { ids }),
    exportCsv: (ids?: number[]) => ipcRenderer.invoke('contacts:export-csv', { ids })
  },

  // --- Storehouse overview (Phase 9.6 — "see ALL my info in one place") ---
  storehouse: {
    summary: () => ipcRenderer.invoke('storehouse:summary')
  },

  // --- Records / Timeline (Phase 10.1 — the Drop Zone) ---
  records: {
    list: (opts?: {
      source?: string
      type?: string
      q?: string
      limit?: number
      offset?: number
      includeFirehose?: boolean
    }) => ipcRenderer.invoke('records:list', opts),
    search: (opts: {
      q: string
      source?: string
      type?: string
      from?: number | null
      to?: number | null
      limit?: number
      offset?: number
      mode?: 'keyword' | 'semantic'
    }) => ipcRenderer.invoke('records:search', opts),
    rebuildSemantic: () => ipcRenderer.invoke('records:rebuild-semantic'),
    semanticStatus: () => ipcRenderer.invoke('records:semantic-status'),
    onThisDay: (opts?: { limit?: number }) => ipcRenderer.invoke('records:on-this-day', opts),
    stats: () => ipcRenderer.invoke('records:stats'),
    facets: () => ipcRenderer.invoke('records:facets'),
    importFiles: () => ipcRenderer.invoke('records:import'),
    importPaths: (paths: string[]) => ipcRenderer.invoke('records:import-paths', paths),
    pathsForFiles: (files: File[]) => files.map((f) => webUtils.getPathForFile(f))
  },
  people: {
    list: () => ipcRenderer.invoke('people:list')
  },
  entities: {
    list: (opts: { kind: string; q?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('entities:list', opts),
    promote: (req: { kind: string; key: string }) => ipcRenderer.invoke('entities:promote', req),
    refresh: () => ipcRenderer.invoke('entities:refresh')
  },
  snapshot: {
    list: (opts?: { source?: string; category?: string }) =>
      ipcRenderer.invoke('snapshot:list', opts)
  },
  cred: {
    list: () => ipcRenderer.invoke('cred:list'),
    run: (portalId: string) => ipcRenderer.invoke('cred:run', portalId),
    cancel: () => ipcRenderer.invoke('cred:cancel')
  },

  // --- Household & Assets (Phase 9.5 — owned, editable, exportable) ---
  assets: {
    list: (opts?: { type?: string }) => ipcRenderer.invoke('assets:list', opts),
    create: (input: AssetInput) => ipcRenderer.invoke('assets:create', input),
    update: (id: number, updates: AssetInput) => ipcRenderer.invoke('assets:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('assets:delete', id),
    exportCsv: () => ipcRenderer.invoke('assets:export-csv')
  },

  // --- Subscriptions (Phase 9.3 — owned, editable, exportable) ---
  subscriptions: {
    list: () => ipcRenderer.invoke('subscriptions:list'),
    getDetected: () => ipcRenderer.invoke('subscriptions:get-detected'),
    create: (input: SubscriptionDraft) => ipcRenderer.invoke('subscriptions:create', input),
    update: (id: number, updates: SubscriptionDraft) =>
      ipcRenderer.invoke('subscriptions:update', id, updates),
    delete: (id: number) => ipcRenderer.invoke('subscriptions:delete', id),
    trackDetected: (detected: DetectedSubscriptionInput) =>
      ipcRenderer.invoke('subscriptions:track-detected', detected),
    exportCsv: () => ipcRenderer.invoke('subscriptions:export-csv')
  },

  // --- Universal Export Center (portable, plaintext, re-importable) ---
  exporter: {
    calendarIcs: () => ipcRenderer.invoke('calendar:export-ics'),
    transactionsCsv: () => ipcRenderer.invoke('finance:export-transactions-csv'),
    knowledgeFolder: () => ipcRenderer.invoke('knowledge:export-folder'),
    all: () => ipcRenderer.invoke('export:export-all')
  },

  // --- Claude Inbox (proposals from the MCP, awaiting human approval) ---
  claude: {
    listProposals: (status?: string) => ipcRenderer.invoke('claude:list-proposals', status),
    approveProposal: (id: number) => ipcRenderer.invoke('claude:approve-proposal', id),
    rejectProposal: (id: number) => ipcRenderer.invoke('claude:reject-proposal', id),
    clearResolved: () => ipcRenderer.invoke('claude:clear-resolved')
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
      currency?: string
      apr?: number
      minPayment?: number
      creditLimit?: number
    }) => ipcRenderer.invoke('finance:upsert-account', account),
    deleteAccount: (id: number) => ipcRenderer.invoke('finance:delete-account', id),
    mergeAccounts: (sourceId: number, targetId: number) =>
      ipcRenderer.invoke('finance:merge-accounts', sourceId, targetId),
    dedupeTransactions: (opts?: { apply?: boolean }) =>
      ipcRenderer.invoke('finance:dedupe-transactions', opts),
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

    // Multi-currency (Phase 11.1)
    getCurrencySettings: () => ipcRenderer.invoke('finance:get-currency-settings'),
    setBaseCurrency: (code: string) => ipcRenderer.invoke('finance:set-base-currency', code),
    setAccountCurrency: (accountId: number, code: string) =>
      ipcRenderer.invoke('finance:set-account-currency', accountId, code),
    getFxRates: () => ipcRenderer.invoke('finance:get-fx-rates'),
    getFxGainLoss: (year?: number) => ipcRenderer.invoke('finance:get-fx-gain-loss', year),
    importHoldings: () => ipcRenderer.invoke('finance:import-holdings'),
    getHoldings: () => ipcRenderer.invoke('finance:get-holdings'),
    setFxRate: (input: { date: string; base: string; quote: string; rate: number }) =>
      ipcRenderer.invoke('finance:set-fx-rate', input),
    refreshFxRates: () => ipcRenderer.invoke('finance:refresh-fx-rates'),

    // CR property / Airbnb P&L (Phase 11.3)
    getPropertyPnl: () => ipcRenderer.invoke('finance:get-property-pnl'),
    setPropertyConfig: (input: {
      placedInService?: string | null
      landValue?: number
      recoveryYears?: number
      basisOverride?: number | null
    }) => ipcRenderer.invoke('finance:set-property-config', input),

    // Foreign-account & expat-tax surface (Phase 11.2)
    getExpatTaxSummary: () => ipcRenderer.invoke('finance:get-expat-tax-summary'),
    setAccountForeign: (accountId: number, isForeign: boolean) =>
      ipcRenderer.invoke('finance:set-account-foreign', accountId, isForeign),
    setFatcaThreshold: (value: number) => ipcRenderer.invoke('finance:set-fatca-threshold', value),

    // Long-horizon retirement projection (Phase 11.4)
    getRetirementProjection: () => ipcRenderer.invoke('finance:get-retirement-projection'),
    setRetirementConfig: (input: Record<string, number | null>) =>
      ipcRenderer.invoke('finance:set-retirement-config', input),

    // Days-in-country & residency (Phase 11.5)
    getResidencySummary: () => ipcRenderer.invoke('finance:get-residency-summary'),
    addTravelSegment: (seg: {
      country: string
      startDate: string
      endDate: string
      notes?: string | null
    }) => ipcRenderer.invoke('finance:add-travel-segment', seg),
    deleteTravelSegment: (id: number) => ipcRenderer.invoke('finance:delete-travel-segment', id),
    setResidencyConfig: (input: Record<string, string | number | null>) =>
      ipcRenderer.invoke('finance:set-residency-config', input),

    // Financial goals & milestones (Phase 11.6)
    getGoalsSummary: () => ipcRenderer.invoke('finance:get-goals-summary'),
    addGoal: (input: Record<string, string | number | null>) =>
      ipcRenderer.invoke('finance:add-goal', input),
    updateGoal: (id: number, input: Record<string, string | number | null>) =>
      ipcRenderer.invoke('finance:update-goal', id, input),
    deleteGoal: (id: number) => ipcRenderer.invoke('finance:delete-goal', id),

    // Estate & insurance readiness (Phase 11.7)
    getEstateReadiness: () => ipcRenderer.invoke('finance:get-estate-readiness'),
    setEstateItem: (key: string, patch: { present?: boolean; notes?: string }) =>
      ipcRenderer.invoke('finance:set-estate-item', key, patch),

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
  // Non-isolated fallback (dev only). `window` (DOM lib) has no typing for our
  // injected globals, so widen it locally rather than suppressing the errors.
  const w = window as typeof window & { electron: typeof electronAPI; api: typeof api }
  w.electron = electronAPI
  w.api = api
}
