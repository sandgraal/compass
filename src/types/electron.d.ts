// Typed window.api interface — mirrors electron/preload.ts

declare global {
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

  interface IntegrationStatus {
    id: number
    service: string
    connectedAt: Date | null
    lastSyncedAt: Date | null
    status: string
    scopes: string | null
    errorMessage: string | null
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
        triggerSync(service: string): Promise<{ success?: boolean; error?: string; recordsUpdated?: number }>
        triggerAllSync(): Promise<Array<{ success?: boolean; error?: string; service: string }>>
        getSyncStatus(): Promise<IntegrationStatus[]>
        getLog(): Promise<Array<{ id: number; service: string; syncedAt: Date; recordsUpdated: number; error: string | null }>>
        onSyncUpdate(cb: (data: unknown) => void): () => void
      }
      knowledge: {
        listFiles(): Promise<KnowledgeFile[]>
        readFile(path: string): Promise<string | null>
        writeFile(path: string, content: string): Promise<{ success: boolean }>
        createFile(path: string, title: string): Promise<{ success: boolean }>
        deleteFile(path: string): Promise<{ success: boolean }>
        search(query: string): Promise<Array<KnowledgeFile & { snippet: string }>>
        onFileChanged(cb: (path: string) => void): () => void
      }
      vault: {
        getCategories(): Promise<VaultCategory[]>
        getEntries(category: string): Promise<VaultEntry[]>
        addEntry(category: string, entry: Record<string, unknown>): Promise<VaultEntry>
        updateEntry(category: string, id: string, entry: Record<string, unknown>): Promise<VaultEntry>
        deleteEntry(category: string, id: string): Promise<{ success: boolean }>
        setContentProtection(enabled: boolean): void
        import1Password(): Promise<{ success: boolean; imported?: number; canceled?: boolean; error?: string }>
      }
      habits: {
        list(includeInactive?: boolean): Promise<Habit[]>
        create(habit: { name: string; icon?: string; color?: string }): Promise<{ success: boolean; id: number }>
        update(id: number, updates: { name?: string; icon?: string; color?: string; active?: boolean }): Promise<{ success: boolean }>
        delete(id: number): Promise<{ success: boolean }>
        getEntries(month: string): Promise<Record<number, Record<string, boolean>>>
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
        getAll(): Promise<Record<string, string>>
        openDataDir(): Promise<{ success: boolean }>
        wipeKnowledge(): Promise<{ success: boolean; error?: string }>
        wipeVault(): Promise<{ success: boolean; error?: string }>
        exportData(): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
      }
      theme: {
        getNativeTheme(): Promise<'dark' | 'light'>
        onThemeChange(cb: (theme: string) => void): () => void
      }
      finance: {
        ingestFolder(folder?: string): Promise<{ filesProcessed: number; newTransactions: number; duplicatesDropped: number; perFile: Array<{ file: string; bank: string; parsed: number; new: number }> }>
        getTransactions(opts?: { month?: string; category?: string; accountId?: number; limit?: number }): Promise<Array<{ id: number; hash: string; date: string; amount: number; description: string; accountId: number | null; category: string | null; subcategory: string | null; notes: string | null; sourceFile: string | null }>>
        updateTransaction(id: number, updates: { category?: string; subcategory?: string; notes?: string; accountId?: number }): Promise<{ success: boolean }>
        deleteTransaction(id: number): Promise<{ success: boolean }>
        getAccounts(): Promise<Array<{ id: number; name: string; type: string; isDebt: boolean | null; balance: number | null; apr: number | null; minPayment: number | null; creditLimit: number | null }>>
        upsertAccount(account: { id?: number; name: string; type: string; isDebt?: boolean; balance?: number; apr?: number; minPayment?: number; creditLimit?: number }): Promise<{ success: boolean; id: number }>
        deleteAccount(id: number): Promise<{ success: boolean }>
        getDebtSummary(): Promise<{ debts: Array<{ id: number; name: string; balance: number | null; apr: number | null; minPayment: number | null }>; projection: Array<{ month: number; balance: number }> }>
        getBudgetStatus(month?: string): Promise<{ lines: Array<{ category: string; subcategory?: string; monthlyAmount: number; actual: number; variance: number; pct: number }>; totals: { budgeted: number; actual: number } }>
        setBudget(line: { category: string; subcategory?: string; monthlyAmount: number }): Promise<{ success: boolean }>
        getRules(): Promise<Array<{ id: number; pattern: string; category: string; subcategory: string | null; priority: number | null }>>
        saveRule(rule: { id?: number; pattern: string; category: string; subcategory?: string; priority?: number }): Promise<{ success: boolean }>
        deleteRule(id: number): Promise<{ success: boolean }>
        getInboxPath(): Promise<string>
      }
    }
  }
}

export {}
