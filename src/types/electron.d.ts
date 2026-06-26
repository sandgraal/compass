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

  interface LinearIssue {
    id: number
    externalId: string
    identifier: string
    title: string
    url: string
    state: string
    stateType: string
    priority: number
    team: string | null
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

  interface MorningBrief {
    date: string
    greeting: string
    calendar: {
      count: number
      events: Array<{ title: string; startAt: string | null; allDay: boolean }>
    }
    tasks: {
      dueCount: number
      items: Array<{ id: number; title: string; category: string | null }>
    }
    payments: {
      count: number
      items: Array<{
        id: number
        name: string
        paymentDueDate: string
        daysRemaining: number
        minPayment: number
      }>
    }
    inbox: {
      count: number
      items: Array<{ id: number; subject: string; from: string }>
    }
    lowCash: {
      enabled: boolean
      threshold: number
      count: number
      soonest: {
        accountId: number
        accountName: string
        date: string
        balance: number
        daysRemaining: number
      } | null
    }
    priceHikes: {
      enabled: boolean
      count: number
      items: Array<{
        merchant: string
        cadence: string
        recentMedian: number
        historicalMedian: number
        delta: number
        pct: number
      }>
    }
    summary: string
  }

  interface WeeklyReview {
    weekStart: string
    weekEnd: string
    totalTasks: number
    completedTasks: number
    completionPct: number
    prevCompletionPct: number | null
    deltaPct: number | null
    perDay: Array<{ date: string; total: number; done: number }>
    carryOver: {
      count: number
      items: Array<{ id: number; title: string; listDate: string; category: string | null }>
    }
  }

  interface MonthlyWeek {
    weekStart: string
    weekEnd: string
    totalTasks: number
    completedTasks: number
    completionPct: number
  }

  interface MonthlyRollup {
    month: string
    monthStart: string
    monthEnd: string
    totalTasks: number
    completedTasks: number
    completionPct: number
    prevCompletionPct: number | null
    deltaPct: number | null
    weeks: MonthlyWeek[]
    bestWeek: { weekStart: string; completionPct: number } | null
  }

  interface Habit {
    id: number
    name: string
    icon: string | null
    color: string | null
    active: boolean | null
    createdAt: Date | null
  }

  interface ClaudeProposal {
    id: number
    proposalId: string
    type: 'task' | 'note' | 'txn_tag' | 'habit_check' | string
    payload: Record<string, unknown>
    source: string
    status: 'pending' | 'approved' | 'rejected' | 'failed' | string
    createdAt: number | null
    resolvedAt: number | null
    error: string | null
    resultRef: string | null
  }

  // --- Contacts (Phase 9 — "The Storehouse") ---
  interface ContactPhone {
    type?: string
    value: string
    pref?: boolean
  }
  interface ContactEmail {
    type?: string
    value: string
    pref?: boolean
  }
  interface ContactAddress {
    type?: string
    street?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
    pref?: boolean
  }
  interface ContactRecord {
    id: number
    externalId: string
    displayName: string
    givenName: string | null
    familyName: string | null
    middleName: string | null
    prefix: string | null
    suffix: string | null
    org: string | null
    jobTitle: string | null
    phones: ContactPhone[]
    emails: ContactEmail[]
    addresses: ContactAddress[]
    birthday: string | null
    url: string | null
    relationship: string | null
    notes: string | null
    photo: string | null
    source: string
    createdAt: number | null
    updatedAt: number | null
  }
  interface ContactInput {
    externalId?: string
    displayName: string
    givenName?: string | null
    familyName?: string | null
    middleName?: string | null
    prefix?: string | null
    suffix?: string | null
    org?: string | null
    jobTitle?: string | null
    phones?: ContactPhone[]
    emails?: ContactEmail[]
    addresses?: ContactAddress[]
    birthday?: string | null
    url?: string | null
    relationship?: string | null
    notes?: string | null
    photo?: string | null
    source?: string
  }
  type ImportResult = {
    success: boolean
    imported?: number
    updated?: number
    canceled?: boolean
    error?: string
  }
  type ExportResult = {
    success: boolean
    path?: string
    count?: number
    canceled?: boolean
    error?: string
  }

  // --- Subscriptions (Phase 9.3 — "The Storehouse") ---
  interface SubscriptionRecord {
    id: number
    externalId: string
    name: string
    cost: number
    cadence: string
    category: string | null
    status: string
    nextRenewal: string | null
    paymentAccount: string | null
    cancelUrl: string | null
    notes: string | null
    source: string
    annualCost: number
    createdAt: number | null
    updatedAt: number | null
  }
  interface SubscriptionInput {
    name: string
    cost?: number
    cadence?: string
    category?: string | null
    status?: string
    nextRenewal?: string | null
    paymentAccount?: string | null
    cancelUrl?: string | null
    notes?: string | null
  }
  interface DetectedSubscription {
    merchant: string
    account: string
    category: string
    cadence: string
    medianAmount: number
    annualCost: number
    status: string
    lastSeen: string
    priceHike: boolean
    priceHikePct: number
    tracked: boolean
  }
  interface DetectedSubscriptions {
    totalActiveAnnual: number
    active: DetectedSubscription[]
    zombies: DetectedSubscription[]
  }

  // --- Household & Assets (Phase 9.5 — "The Storehouse") ---
  interface AssetRecord {
    id: number
    externalId: string
    type: string
    name: string
    value: number | null
    provider: string | null
    reference: string | null
    renewalDate: string | null
    status: string
    notes: string | null
    createdAt: number | null
    updatedAt: number | null
  }
  interface AssetInput {
    type?: string
    name: string
    value?: number | null
    provider?: string | null
    reference?: string | null
    renewalDate?: string | null
    status?: string
    notes?: string | null
  }

  // --- Storehouse overview (Phase 9.6) ---
  interface TimelineRecord {
    id: number
    source: string
    type: string
    occurredAt: number | null
    title: string
    body: string | null
    payload: string | null
    provenance: string | null
    ingestedAt: number | null
  }

  interface Person {
    name: string
    key: string
    count: number
    sources: string[]
    firstSeen: number | null
    lastSeen: number | null
    contactId: number | null
  }

  interface TimelineSearchHit {
    id: number
    source: string
    type: string
    occurredAt: number | null
    title: string
    body: string | null
    /** bm25 `snippet()` with [matched] terms bracketed — for highlight in the list. */
    titleSnippet: string
    bodySnippet: string
    /** bm25 score (more negative = better); rows arrive already sorted best-first. */
    rank: number
  }

  interface RecordsImportResult {
    success: boolean
    canceled?: boolean
    error?: string
    imported: number
    duplicates: number
    snapshots: number
    perFile: Array<{
      file: string
      recognizer: string | null
      imported: number
      duplicates: number
    }>
    unrecognized: string[]
  }

  interface SnapshotFactRecord {
    id: number
    source: string
    category: string
    label: string | null
    value: string
    position: number
  }

  interface StorehouseSummary {
    contacts: { count: number }
    subscriptions: { activeCount: number; annualTotal: number }
    assets: {
      count: number
      totalValue: number
      byType: Array<{ type: string; count: number; value: number }>
    }
    records: { count: number }
    upcomingRenewals: Array<{
      source: 'subscription' | 'asset'
      name: string
      date: string
      daysUntil: number
    }>
  }

  interface Window {
    api: {
      auth: {
        connectGoogle(): Promise<{ success?: boolean; error?: string }>
        setGoogleCredentials(
          clientId: string,
          clientSecret: string
        ): Promise<{ success?: boolean; error?: string }>
        hasGoogleCredentials(): Promise<{ configured: boolean }>
        clearGoogleCredentials(): Promise<{ success: boolean }>
        connectGitHub(): Promise<{ success?: boolean; error?: string }>
        connectGitHubWithPAT(
          token: string
        ): Promise<{ success?: boolean; login?: string; error?: string }>
        connectNotion(
          token: string
        ): Promise<{ success?: boolean; workspace?: string | null; error?: string }>
        connectLinear(
          token: string
        ): Promise<{ success?: boolean; name?: string | null; error?: string }>
        connectTodoist(token: string): Promise<{ success?: boolean; error?: string }>
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
        testKey(provider: 'anthropic' | 'openai'): Promise<{ success: boolean; error?: string }>
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
        agent(payload: {
          question: string
          history?: Array<{ role: 'user' | 'assistant'; content: string }>
        }): Promise<
          | {
              success: true
              answer: string
              model: string
              provider: 'anthropic' | 'openai'
              toolCalls: Array<{ name: string; ok: boolean }>
              proposalIds: string[]
              inputTokens?: number
              outputTokens?: number
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
      obsidian: {
        getStatus(): Promise<{
          configured: boolean
          vaultPath: string | null
          looksLikeVault: boolean
          error: string | null
        }>
        setVaultPath(
          path: string
        ): Promise<{ success: boolean; looksLikeVault?: boolean; error?: string }>
        clear(): Promise<{ success: boolean }>
      }
      insights: {
        get(): Promise<{
          generatedAt: string
          insights: Array<{
            kind: 'spending-anomaly' | 'uncategorized-spend' | 'habit-slippage' | 'stale-notes'
            severity: 'info' | 'warn'
            title: string
            detail: string
            route: string
          }>
        }>
      }
      plaid: {
        getStatus(): Promise<{
          configured: boolean
          hasConfig: boolean
          env: 'sandbox' | 'production' | null
          clientId: string | null
          hasSecret: boolean
          linkedItemIds: string[]
        }>
        setConfig(clientId: string, env: 'sandbox' | 'production'): Promise<{ ok: true }>
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
        listItems(): Promise<
          Array<{
            id: number
            itemId: string
            institutionId: string
            institutionName: string
            lastSyncedAt: number | null
            errorCode: string | null
          }>
        >
      }
      simplefin: {
        getStatus(): Promise<{ connectionIds: string[] }>
        claimToken(setupToken: string): Promise<{
          ok: true
          connectionId: string
          orgName: string
          added: number
          accountsUpserted: number
          accountsLinked: number
        }>
        listConnections(): Promise<
          Array<{
            id: number
            connectionId: string
            orgName: string
            orgDomain: string | null
            lastSyncedAt: number | null
            errorCode: string | null
          }>
        >
        disconnect(connectionId: string): Promise<{ ok: true }>
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
      contacts: {
        list(opts?: { search?: string }): Promise<ContactRecord[]>
        get(id: number): Promise<ContactRecord | null>
        create(input: ContactInput): Promise<{ success: boolean; id: number }>
        update(id: number, updates: ContactInput): Promise<{ success: boolean }>
        delete(id: number): Promise<{ success: boolean }>
        importVcard(): Promise<ImportResult>
        importCsv(): Promise<ImportResult>
        importLinkedin(): Promise<ImportResult>
        importFacebook(): Promise<ImportResult>
        importGvoice(): Promise<ImportResult>
        exportVcard(ids?: number[]): Promise<ExportResult>
        exportCsv(ids?: number[]): Promise<ExportResult>
      }
      storehouse: {
        summary(): Promise<StorehouseSummary>
      }
      records: {
        list(opts?: {
          source?: string
          type?: string
          q?: string
          limit?: number
          offset?: number
        }): Promise<TimelineRecord[]>
        search(opts: {
          q: string
          source?: string
          type?: string
          from?: number | null
          to?: number | null
          limit?: number
          offset?: number
          mode?: 'keyword' | 'semantic'
        }): Promise<TimelineSearchHit[]>
        rebuildSemantic(): Promise<{
          success: boolean
          error?: string
          embedded?: number
          total?: number
          durationMs?: number
          errors?: Array<{ id: number; message: string }>
        }>
        semanticStatus(): Promise<{
          available: boolean
          builtAt: number | null
          count: number
          model: string | null
          building: boolean
        }>
        onThisDay(opts?: { limit?: number }): Promise<TimelineRecord[]>
        stats(): Promise<{
          total: number
          sources: number
          earliest: number | null
          latest: number | null
        }>
        facets(): Promise<{ sources: string[]; types: string[] }>
        importFiles(): Promise<RecordsImportResult>
        importPaths(paths: string[]): Promise<RecordsImportResult>
        pathsForFiles(files: File[]): string[]
      }
      people: {
        list(): Promise<Person[]>
      }
      snapshot: {
        list(opts?: { source?: string; category?: string }): Promise<SnapshotFactRecord[]>
      }
      cred: {
        list(): Promise<{ id: string; name: string; status: 'beta' | 'stable' }[]>
        run(portalId: string): Promise<{
          ok: boolean
          cancelled?: boolean
          imported?: number
          duplicates?: number
          error?: string
        }>
        cancel(): Promise<{ ok: boolean }>
      }
      assets: {
        list(opts?: { type?: string }): Promise<AssetRecord[]>
        create(input: AssetInput): Promise<{ success: boolean; id: number }>
        update(id: number, updates: AssetInput): Promise<{ success: boolean }>
        delete(id: number): Promise<{ success: boolean }>
        exportCsv(): Promise<ExportResult>
      }
      subscriptions: {
        list(): Promise<SubscriptionRecord[]>
        getDetected(): Promise<DetectedSubscriptions>
        create(input: SubscriptionInput): Promise<{ success: boolean; id: number }>
        update(id: number, updates: SubscriptionInput): Promise<{ success: boolean }>
        delete(id: number): Promise<{ success: boolean }>
        trackDetected(detected: {
          merchant: string
          account: string
          category?: string | null
          cadence?: string
          medianAmount?: number
        }): Promise<{ success: boolean; id: number; alreadyTracked?: boolean }>
        exportCsv(): Promise<ExportResult>
      }
      exporter: {
        calendarIcs(): Promise<ExportResult>
        transactionsCsv(): Promise<ExportResult>
        knowledgeFolder(): Promise<ExportResult>
        all(): Promise<{
          success: boolean
          path?: string
          files?: string[]
          knowledgeCount?: number
          canceled?: boolean
          error?: string
        }>
      }
      claude: {
        listProposals(status?: string): Promise<ClaudeProposal[]>
        approveProposal(
          id: number
        ): Promise<{ success: boolean; resultRef?: string; error?: string }>
        rejectProposal(id: number): Promise<{ success: boolean; error?: string }>
        clearResolved(): Promise<{ success: boolean; cleared: number }>
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
      morningBrief: {
        get(): Promise<MorningBrief>
      }
      weeklyReview: {
        get(weekStart: string): Promise<WeeklyReview>
        carryOver(
          weekStart: string,
          toDate?: string
        ): Promise<{ success: boolean; carried?: number; error?: string }>
      }
      monthlyRollup: {
        get(month: string): Promise<MonthlyRollup>
      }
      github: {
        getItems(state?: string): Promise<GitHubItem[]>
      }
      linear: {
        getItems(): Promise<LinearIssue[]>
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
        openReleasePage(tag: string): Promise<void>
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
            // Phase 4.6 Plaid linkage. Populated for accounts created via
            // Plaid Link; null for manual / CSV-only accounts. Surfaces the
            // "linked · <institution>" badge in the Accounts tab.
            plaidItemId?: number | null
            plaidAccountId?: string | null
            mask?: string | null
            // Phase 4.7 SimpleFIN linkage. Populated for accounts owned by a
            // SimpleFIN connection; null for manual / CSV / Plaid accounts.
            simplefinConnectionId?: number | null
            simplefinAccountId?: string | null
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
        mergeAccounts(
          sourceId: number,
          targetId: number
        ): Promise<{ success: boolean; reassigned: number }>
        dedupeTransactions(opts?: {
          apply?: boolean
        }): Promise<{ applied: false; removable: number } | { applied: true; removed: number }>
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
