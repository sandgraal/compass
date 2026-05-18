// Typed window.api interface — mirrors electron/preload.ts

declare global {
  type AppSettings = Record<string, string> & { appVersion: string }

  type UpdaterStatusPayload =
    | { phase: 'checking' }
    | { phase: 'available'; version: string; releaseDate: string }
    | { phase: 'not-available' }
    | { phase: 'downloading'; percent: number; bytesPerSecond: number; total: number }
    | { phase: 'downloaded'; version: string }
    | { phase: 'error'; message: string }

  interface VaultEntry {
    id: string
    createdAt: number
    updatedAt: number
    [key: string]: unknown
  }

  interface VaultCategory {
    id: string
    label: string
    icon: string
    description: string
  }

  interface KnowledgeFile {
    path: string
    title: string
    category: string
    lastModified: number
    wordCount: number
    autoUpdated: boolean
    snippet?: string
  }

  interface KnowledgeSuggestion {
    id: number
    proposedAt: Date
    source: 'gmail' | 'github' | 'calendar' | 'ollama:gmail' | 'ollama:github'
    sourceId: string | null
    targetPath: string
    kind: 'contact' | 'employer' | 'date' | 'note'
    proposedContent: string
    context: string | null
    status: 'pending' | 'accepted' | 'dismissed'
    reviewedAt: Date | null
  }

  interface OllamaStatus {
    available: boolean
    baseUrl?: string
    models?: string[]
  }

  type GlobalSearchHit =
    | {
        kind: 'knowledge'
        path: string
        title: string
        snippet: string
        score: number
      }
    | {
        kind: 'vault'
        category: string
        id: string
        title: string
        score: number
      }
    | {
        kind: 'task'
        id: number
        title: string
        listType: string
        listDate: string
        done: boolean
        score: number
      }
    | {
        kind: 'transaction'
        id: number
        date: string
        amount: number
        description: string
        score: number
      }

  interface BacklinkRow {
    path: string
    title: string
    snippet: string
  }

  interface IntegrationStatus {
    id: number
    service: string
    connectedAt: Date | null
    lastSyncedAt: Date | null
    status: string
    scopes: string | null
    errorMessage: string | null
    syncIntervalMinutes: number
  }

  interface RedirectUris {
    google: string
    github: string
  }

  interface CalendarEvent {
    id: number
    source: string
    externalId: string
    title: string
    startAt: Date | null
    endAt: Date | null
    allDay: boolean | null
    location: string | null
    description: string | null
    htmlLink: string | null
  }

  interface GitHubItem {
    id: number
    type: string
    repo: string
    externalId: string
    title: string
    url: string
    state: string
    body: string | null
    labels: string | null
    dueDate: string | null
  }

  interface GmailAction {
    id: number
    threadId: string
    subject: string
    fromAddress: string
    actionSummary: string | null
    snippet: string | null
    receivedAt: Date | null
    done: boolean | null
  }

  interface ChecklistItem {
    id: number
    listType: string
    listDate: string
    title: string
    body: string | null
    checked: boolean | null
    status: string | null
    category: string | null
    sortOrder: number | null
    source: string | null
    sourceId: string | null
    createdAt: Date
  }

  interface Habit {
    id: number
    name: string
    icon: string | null
    color: string | null
    active: boolean | null
    createdAt: Date | null
  }

  interface Window {
    api: {
      auth: {
        connectGoogle(): Promise<{ success?: boolean; error?: string }>
        connectGitHub(): Promise<{ success?: boolean; error?: string }>
        disconnect(service: string): Promise<{ success: boolean }>
        getStatus(): Promise<IntegrationStatus[]>
        getRedirectUris(): Promise<RedirectUris>
      }
      sync: {
        triggerSync(
          service: string
        ): Promise<{ success?: boolean; error?: string; recordsUpdated?: number }>
        triggerAllSync(): Promise<Array<{ success?: boolean; error?: string; service: string }>>
        getSyncStatus(): Promise<IntegrationStatus[]>
        getLog(): Promise<
          Array<{
            id: number
            service: string
            syncedAt: Date
            recordsUpdated: number
            error: string | null
          }>
        >
        setInterval(
          service: string,
          minutes: number
        ): Promise<{ success: boolean; service?: string; minutes?: number; error?: string }>
        onSyncUpdate(cb: (data: unknown) => void): () => void
      }
      knowledge: {
        listFiles(): Promise<KnowledgeFile[]>
        readFile(path: string): Promise<string | null>
        writeFile(path: string, content: string): Promise<{ success: boolean }>
        createFile(path: string, title: string): Promise<{ success: boolean }>
        deleteFile(path: string): Promise<{ success: boolean }>
        search(query: string): Promise<Array<KnowledgeFile & { snippet: string }>>
        getPrev(path: string): Promise<string | null>
        onFileChanged(cb: (path: string) => void): () => void
        listSuggestions(targetPath?: string): Promise<KnowledgeSuggestion[]>
        acceptSuggestion(id: number): Promise<{ success: boolean }>
        dismissSuggestion(id: number): Promise<{ success: boolean }>
        getBacklinks(path: string): Promise<BacklinkRow[]>
        getEmbeddingStatus(): Promise<{
          builtAt: number | null
          model: string | null
          fileCount: number
          chunkCount: number
          building: boolean
        }>
        rebuildEmbeddings(): Promise<{
          success: boolean
          builtFiles?: number
          skippedFiles?: number
          totalChunks?: number
          durationMs?: number
          errors?: Array<{ path: string; message: string }>
          error?: string
        }>
        semanticSearch(query: string): Promise<{
          hits: Array<{
            path: string
            title: string
            chunkIndex: number
            snippet: string
            score: number
          }>
          reason?: 'invalid-query' | 'query-too-long' | 'index-missing' | 'ollama-error'
          error?: string
        }>
      }
      search: {
        global(query: string): Promise<{
          hits: GlobalSearchHit[]
          counts?: { knowledge: number; vault: number; tasks: number; transactions: number }
        }>
      }
      assistant: {
        getStatus(): Promise<{
          configuredProviders: Array<'anthropic' | 'openai'>
          activeProvider: 'anthropic' | 'openai' | null
          masks: Partial<Record<'anthropic' | 'openai', string>>
          models: Partial<Record<'anthropic' | 'openai', string>>
          lastClearedAt: number | null
        }>
        setKey(
          provider: 'anthropic' | 'openai',
          key: string
        ): Promise<{ success: boolean; error?: string }>
        clearKey(provider?: 'anthropic' | 'openai'): Promise<{ success: boolean; error?: string }>
        setActiveProvider(
          provider: 'anthropic' | 'openai'
        ): Promise<{ success: boolean; error?: string }>
        setModel(
          provider: 'anthropic' | 'openai',
          model: string
        ): Promise<{ success: boolean; error?: string }>
        ask(payload: {
          question: string
          history?: Array<{ role: 'user' | 'assistant'; content: string }>
        }): Promise<
          | {
              success: true
              answer: string
              model: string
              provider: 'anthropic' | 'openai'
              inputTokens?: number
              outputTokens?: number
              citations: Array<{
                n: number
                path: string
                title: string
                snippet: string
                score: number
              }>
            }
          | { success: false; error?: string; cancelled?: boolean }
        >
        cancel(): Promise<{ success: boolean; error?: string }>
      }
      backup: {
        create(passphrase: string): Promise<{
          success: boolean
          path?: string
          size?: number
          stats?: { tables: number; knowledgeFiles: number; vaultFiles: number }
          canceled?: boolean
          error?: string
        }>
        restore(passphrase: string): Promise<{
          success: boolean
          path?: string
          exportedAt?: string
          appVersion?: string
          stats?: { vaultFiles: number; knowledgeFiles: number; rows: number }
          canceled?: boolean
          error?: string
        }>
      }
      spotlight: {
        getStatus(): Promise<{
          enabled: boolean
          path: string
          defaultPath: string
          pathAllowed: boolean
          mirrorExists: boolean
          lastError: string | null
          lastBackfillAt: number | null
        }>
        setEnabled(enabled: boolean): Promise<{
          success: boolean
          error?: string
          result?: {
            copied: number
            skipped: number
            removed: number
            errors: Array<{ path: string; message: string }>
          }
        }>
        setPath(path: string): Promise<{
          success: boolean
          error?: string
          result?: {
            copied: number
            skipped: number
            removed: number
            errors: Array<{ path: string; message: string }>
          }
        }>
        backfillNow(): Promise<
          | {
              success: true
              result: {
                copied: number
                skipped: number
                removed: number
                errors: Array<{ path: string; message: string }>
              }
            }
          | { success: false; error: string }
        >
      }
      plaid: {
        getStatus(): Promise<{
          configured: boolean
          env: 'sandbox' | 'production' | null
          hasSecret: boolean
          linkedItemIds: string[]
        }>
        setSecret(env: 'sandbox' | 'production', secret: string): Promise<{ ok: true }>
        startLink(): Promise<
          | {
              ok: true
              result: {
                itemId: string
                institutionId: string | null
                institutionName: string | null
                accounts: {
                  id: string
                  name: string
                  mask: string | null
                  subtype: string | null
                }[]
              }
            }
          | { ok: false; cancelled: true }
          | { ok: false; cancelled: false; errorCode: string | null; errorMessage: string | null }
        >
        disconnect(itemId: string): Promise<{ ok: true }>
      }
      vault: {
        getCategories(): Promise<VaultCategory[]>
        getEntries(category: string): Promise<VaultEntry[]>
        addEntry(category: string, entry: Record<string, unknown>): Promise<VaultEntry>
        updateEntry(
          category: string,
          id: string,
          entry: Record<string, unknown>
        ): Promise<VaultEntry>
        deleteEntry(category: string, id: string): Promise<{ success: boolean }>
        setContentProtection(enabled: boolean): void
        import1Password(): Promise<{
          success: boolean
          imported?: number
          canceled?: boolean
          error?: string
        }>
      }
      habits: {
        list(includeInactive?: boolean): Promise<Habit[]>
        create(habit: { name: string; icon?: string; color?: string }): Promise<{
          success: boolean
          id: number
        }>
        update(
          id: number,
          updates: { name?: string; icon?: string; color?: string; active?: boolean }
        ): Promise<{ success: boolean }>
        delete(id: number): Promise<{ success: boolean }>
        getEntries(month: string): Promise<Record<number, Record<string, boolean>>>
        getAllEntries(): Promise<Record<number, Record<string, boolean>>>
        toggle(habitId: number, date: string): Promise<{ success: boolean; completed: boolean }>
      }
      checklist: {
        getItems(listType: string, date: string): Promise<ChecklistItem[]>
        addItem(item: Record<string, unknown>): Promise<ChecklistItem>
        updateItem(id: number, updates: Record<string, unknown>): Promise<{ success: boolean }>
        deleteItem(id: number): Promise<{ success: boolean }>
        rollOver(fromDate: string, toDate: string): Promise<{ rolledOver: number }>
        getTemplate(listType: string): Promise<string>
        saveTemplate(listType: string, content: string): Promise<{ success: boolean }>
      }
      calendar: {
        getEvents(start: string, end: string): Promise<CalendarEvent[]>
      }
      github: {
        getItems(state?: string): Promise<GitHubItem[]>
      }
      gmail: {
        getActions(done?: boolean): Promise<GmailAction[]>
        markDone(id: number): Promise<{ success: boolean }>
      }
      settings: {
        get(key: string): Promise<string | null>
        set(key: string, value: unknown): Promise<{ success: boolean }>
        getAll(): Promise<AppSettings>
        openDataDir(): Promise<{ success: boolean }>
        wipeKnowledge(): Promise<{ success: boolean; error?: string }>
        wipeVault(): Promise<{ success: boolean; error?: string }>
        exportData(): Promise<{
          success: boolean
          path?: string
          canceled?: boolean
          error?: string
        }>
        setQuickCaptureShortcut(accelerator: string): Promise<{ success: boolean; error?: string }>
        detectOllama(options?: { forceRefresh?: boolean }): Promise<OllamaStatus>
      }
      updater: {
        getVersion(): Promise<string>
        check(): Promise<{ success: boolean; error?: string }>
        installAndRestart(): void // fire-and-forget (send, not invoke)
        onStatus(cb: (data: UpdaterStatusPayload) => void): () => void
      }
      theme: {
        getNativeTheme(): Promise<'dark' | 'light'>
        onThemeChange(cb: (theme: string) => void): () => void
      }
      urlScheme: {
        onCaptured(cb: (data: { title: string }) => void): () => void
        onOpen(cb: (data: { page: string }) => void): () => void
        onSearch(cb: (data: { query: string }) => void): () => void
      }
      finance: {
        ingestFolder(folder?: string): Promise<{
          filesProcessed: number
          newTransactions: number
          duplicatesDropped: number
          perFile: Array<{ file: string; bank: string; parsed: number; new: number }>
        }>
        getTransactions(opts?: {
          month?: string
          category?: string
          accountId?: number
          limit?: number
        }): Promise<
          Array<{
            id: number
            hash: string
            date: string
            amount: number
            description: string
            accountId: number | null
            category: string | null
            subcategory: string | null
            notes: string | null
            sourceFile: string | null
          }>
        >
        updateTransaction(
          id: number,
          updates: {
            category?: string
            subcategory?: string
            notes?: string
            accountId?: number | null
          }
        ): Promise<{ success: boolean }>
        deleteTransaction(id: number): Promise<{ success: boolean }>
        getAccounts(): Promise<
          Array<{
            id: number
            name: string
            type: string
            isDebt: boolean | null
            balance: number | null
            apr: number | null
            minPayment: number | null
            creditLimit: number | null
            institution?: string
            paymentDueDate?: string | null
            lastStatementSyncedAt?: number | Date | null
          }>
        >
        upsertAccount(account: {
          id?: number
          name: string
          type: string
          isDebt?: boolean
          balance?: number
          apr?: number
          minPayment?: number
          creditLimit?: number
        }): Promise<{ success: boolean; id: number }>
        deleteAccount(id: number): Promise<{ success: boolean }>
        getDebtSummary(): Promise<{
          debts: Array<{
            id: number
            name: string
            balance: number | null
            apr: number | null
            minPayment: number | null
          }>
          projection: Array<{ month: number; balance: number }>
        }>
        getUpcomingPayments(daysAhead?: number): Promise<
          Array<{
            id: number
            name: string
            institution: string
            paymentDueDate: string
            minPayment: number
            balance: number
            daysRemaining: number
          }>
        >
        getBudgetStatus(month?: string): Promise<{
          lines: Array<{
            category: string
            subcategory?: string
            monthlyAmount: number
            actual: number
            variance: number
            pct: number
          }>
          totals: { budgeted: number; actual: number }
        }>
        setBudget(line: {
          category: string
          subcategory?: string
          monthlyAmount: number
        }): Promise<{ success: boolean }>
        getRules(): Promise<
          Array<{
            id: number
            pattern: string
            category: string
            subcategory: string | null
            priority: number | null
          }>
        >
        saveRule(rule: {
          id?: number
          pattern: string
          category: string
          subcategory?: string
          priority?: number
        }): Promise<{ success: boolean }>
        deleteRule(id: number): Promise<{ success: boolean }>
        reapplyRules(): Promise<{ updated: number; scanned: number }>
        getSubscriptions(): Promise<{
          totalActiveAnnual: number
          active: Array<{
            merchant: string
            account: string
            category: string
            subcategory: string
            cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semi-annual' | 'yearly'
            medianAmount: number
            minAmount: number
            maxAmount: number
            annualCost: number
            firstSeen: string
            lastSeen: string
            daysSinceLast: number
            nCharges: number
            status: 'active' | 'zombie' | 'expired'
            priceBump: boolean
            priceHike: boolean
            priceHikeDelta: number
            priceHikePct: number
            recentMedian: number
            historicalMedian: number
          }>
          zombies: Array<{
            merchant: string
            account: string
            cadence: string
            annualCost: number
            lastSeen: string
          }>
          expired: Array<{ merchant: string }>
          duplicates: Array<{ merchant: string; accounts: string[]; combinedAnnual: number }>
        }>
        getGeoSummary(opts?: { since?: string }): Promise<{
          geo: Array<{ name: string; amount: number; count: number }>
          purpose: Array<{ name: string; amount: number }>
          crCapex: number
          since: string | null
        }>
        getTaxSummary(opts?: { year?: number }): Promise<{
          year: number
          tags: Array<{ taxTag: string; count: number; total: number }>
        }>
        setTransactionTaxTag(
          id: number,
          taxTag: string
        ): Promise<{ success: boolean; error?: string }>
        exportTaxPack(opts?: { year?: number }): Promise<{
          success: boolean
          year?: number
          dir?: string
          files?: Array<{ tag: string; file: string; count: number; total: number }>
          manifest?: string
          canceled?: boolean
          error?: string
        }>

        // Net worth (Phase 4.4)
        getNetWorthSnapshot(): Promise<{
          assets: number
          liabilities: number
          net: number
          byAccount: Array<{
            accountId: number
            name: string
            assetClass: string
            isDebt: boolean
            balance: number
            capturedAt: number | null
          }>
          deltas: { d30: number | null; d90: number | null; d365: number | null }
        }>
        getNetWorthTrajectory(opts?: { sinceDays?: number; untilMs?: number }): Promise<
          Array<{
            accountId: number
            accountName: string
            assetClass: string
            isDebt: boolean
            date: string
            balance: number
          }>
        >
        captureSnapshot(): Promise<{ written: number; skipped: number }>
        setAccountBalance(
          accountId: number,
          balance: number
        ): Promise<{ success: boolean; error?: string }>

        // Cash-flow forecast (Phase 4.5)
        getForecast(opts?: { windowDays?: number; lowCashThreshold?: number }): Promise<{
          events: Array<{
            date: string
            accountId: number | null
            amount: number
            label: string
            source: 'subscription' | 'income' | 'debt' | 'calendar' | 'override'
            confidence: 'high' | 'medium' | 'low'
            originalDate?: string
            skipped?: boolean
          }>
          trajectory: Array<{ date: string; accountId: number; balance: number }>
          lowDates: Array<{ accountId: number; date: string; balance: number }>
        }>
        setForecastOverride(override: {
          accountId: number
          date: string
          label: string
          kind: 'skip' | 'shift' | 'override'
          amount?: number | null
          shiftToDate?: string | null
        }): Promise<{ success: boolean; error?: string }>
        deleteForecastOverride(
          accountId: number,
          date: string,
          label: string
        ): Promise<{ success: boolean; error?: string; removed?: number }>

        getInboxPath(): Promise<string>

        // Watched folder
        getWatchFolder(): Promise<{ path: string; isWatching: boolean; exists: boolean }>
        setWatchFolder(folder: string | null): Promise<{ success: boolean; path: string }>
        pickWatchFolder(): Promise<{ canceled: boolean; path?: string }>
        ingestWatchedNow(): Promise<{
          result: {
            filesProcessed: number
            newTransactions: number
            duplicatesDropped: number
            perFile: Array<{ file: string; bank: string; parsed: number; new: number }>
          }
          detectedAccounts: Array<{
            name: string
            type: string
            institution: string
            lastFour?: string
            isDebt: boolean
            sourceFile: string
            dbId: number
          }>
          vaultSeeded: number
        }>
        stopWatching(): Promise<{ success: boolean }>
        onIngestComplete(cb: (data: unknown) => void): () => void
        onIngestError(cb: (data: unknown) => void): () => void
        onRulesReapplied(cb: (data: unknown) => void): () => void
      }
    }
  }
}

export {}
