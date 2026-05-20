import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { BrowserWindow, type IpcMain, Notification } from 'electron'
import { getDb } from '../db/client'
import {
  appSettings,
  calendarEvents,
  driveFiles,
  githubItems,
  gmailActions,
  integrations,
  knowledgeSuggestions,
  syncEvents
} from '../db/schema'
import { readAppleCalendars } from '../integrations/apple-calendar'
import { syncAllPlaid } from '../integrations/plaid/sync'
import {
  updateCalendarKnowledge,
  updateDriveKnowledge,
  updateGitHubKnowledge,
  updateGmailKnowledge
} from '../knowledge/extractor'
import { DEFAULT_OLLAMA_MODEL, detectOllama, runOllamaPrompt } from '../knowledge/ollama'
import {
  type CalendarInputEvent,
  type GitHubInputItem,
  type GmailInputMessage,
  type OllamaSyncContext,
  extractContactsFromCalendar,
  extractContactsFromGithub,
  extractContactsFromGmail,
  extractFactsViaOllama,
  extractOrgsFromGmail
} from '../knowledge/suggestions'
import { readKnowledgeFile } from '../knowledge/writer'
import { KNOWLEDGE_DIR } from '../paths'
import { getValidGoogleToken, loadToken } from './auth'

type SyncResult = {
  service: string
  success: boolean
  recordsUpdated?: number
  error?: string
}

type SyncResultInternal = SyncResult & {
  githubSuggestionInputs?: GitHubInputItem[]
}

const SUPPORTED_SYNC_SERVICES = new Set(['google', 'github', 'apple-calendar'])

function normalizeSupportedSyncService(service: unknown): string | null {
  if (typeof service !== 'string') return null

  const normalized = service.trim()
  if (normalized.length === 0 || !SUPPORTED_SYNC_SERVICES.has(normalized)) {
    return null
  }

  return normalized
}

function getIntegrationId(db: ReturnType<typeof getDb>, service: string): number | null {
  const row = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, service))
    .get()
  return row?.id ?? null
}

function normalizeSemanticToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function firstCellFromMarkdownRow(content: string): string | null {
  const match = content.match(/^\|\s*([^|]+?)\s*\|/)
  if (!match) return null
  const normalized = normalizeSemanticToken(match[1])
  return normalized === '' ? null : normalized
}

function candidateSemanticKey(candidate: {
  targetPath: string
  kind: string
  proposedContent: string
}): string | null {
  if (candidate.kind === 'contact' || candidate.kind === 'employer') {
    const firstCell = firstCellFromMarkdownRow(candidate.proposedContent)
    if (!firstCell) return null
    return `${candidate.kind}|${candidate.targetPath}|${firstCell}`
  }
  return null
}

function isOllamaSource(source: string): boolean {
  return source.startsWith('ollama:')
}

/**
 * Run all pattern-based suggestion extractors against the latest synced data and
 * persist new candidates to `knowledge_suggestions`. Idempotent: skips any
 * duplicate `(targetPath + proposedContent)` and stable Ollama source keys.
 *
 * If the user has enabled Ollama suggestions AND Ollama is running locally,
 * also runs the AI-augmented extractor — wrapped in its own try/catch so an
 * Ollama failure can never block or fail the sync flow.
 */
export async function runSuggestionExtractors(
  githubInputsOverride?: GitHubInputItem[]
): Promise<void> {
  try {
    const db = getDb()

    // Load existing knowledge files for deduplication
    const relationshipsContent = readKnowledgeFile(KNOWLEDGE_DIR, 'profile/relationships.md')
    const employersContent = readKnowledgeFile(KNOWLEDGE_DIR, 'work/employers.md')

    // Load recently synced data
    const gmailRows = db.select().from(gmailActions).all()
    // Build input shapes expected by extractors
    const gmailInputs: GmailInputMessage[] = gmailRows.map((r) => ({
      id: String(r.id),
      threadId: r.threadId,
      subject: r.subject,
      from: r.fromAddress,
      snippet: r.snippet ?? undefined,
      date: r.receivedAt ? r.receivedAt.toISOString() : undefined
    }))

    const githubInputs: GitHubInputItem[] =
      githubInputsOverride ??
      db
        .select()
        .from(githubItems)
        .all()
        .map((r) => ({
          id: r.id,
          html_url: r.url,
          type: r.type as 'issue' | 'pr',
          repo: r.repo,
          title: r.title,
          assignee: null,
          user: null,
          labels: r.labels ? (JSON.parse(r.labels) as string[]).map((n) => ({ name: n })) : []
        }))

    const calendarCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const calendarInputs: CalendarInputEvent[] = db
      .select({
        externalId: calendarEvents.externalId,
        title: calendarEvents.title,
        description: calendarEvents.description,
        startAt: calendarEvents.startAt
      })
      .from(calendarEvents)
      .where(
        and(
          isNotNull(calendarEvents.description),
          or(isNull(calendarEvents.startAt), gte(calendarEvents.startAt, calendarCutoff))
        )
      )
      .all()

    const regexCandidates = [
      ...extractContactsFromGmail(gmailInputs, relationshipsContent),
      ...extractOrgsFromGmail(gmailInputs, employersContent),
      ...extractContactsFromGithub(githubInputs, relationshipsContent),
      ...extractContactsFromCalendar(calendarInputs, relationshipsContent)
    ]
    const candidates = [...regexCandidates]

    // ── Optional: Ollama AI augmentation ──────────────────────────────────────
    // Only runs when the user has opted in. Failures are logged and ignored.
    try {
      const ollamaEnabledRow = db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, 'ollamaSuggestionsEnabled'))
        .get()
      const ollamaEnabled = ollamaEnabledRow?.value === 'true'

      if (ollamaEnabled) {
        const ollamaModelRow = db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, 'ollamaModel'))
          .get()
        const model = ollamaModelRow?.value ?? DEFAULT_OLLAMA_MODEL

        const ollamaCtx: OllamaSyncContext = {
          gmailMessages: gmailInputs,
          githubItems: githubInputs,
          existingRelationships: relationshipsContent,
          existingEmployers: employersContent,
          model
        }

        const ollamaCandidates = await extractFactsViaOllama(ollamaCtx, {
          detectOllama,
          runOllamaPrompt
        })
        const regexSemanticKeys = new Set(
          regexCandidates.map(candidateSemanticKey).filter((k): k is string => Boolean(k))
        )
        const filteredOllamaCandidates = ollamaCandidates.filter((candidate) => {
          const semanticKey = candidateSemanticKey(candidate)
          if (!semanticKey) return true
          return !regexSemanticKeys.has(semanticKey)
        })
        candidates.push(...filteredOllamaCandidates)
      }
    } catch (ollamaErr) {
      // Ollama is best-effort — never propagate errors into the sync flow
      console.warn('[ollama] extractor error:', (ollamaErr as Error).message)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Load existing suggestions to avoid duplicates
    const existingSuggestions = db
      .select({
        source: knowledgeSuggestions.source,
        sourceId: knowledgeSuggestions.sourceId,
        targetPath: knowledgeSuggestions.targetPath,
        proposedContent: knowledgeSuggestions.proposedContent
      })
      .from(knowledgeSuggestions)
      .all()

    const existingKeys = new Set(
      existingSuggestions.map((s) => `${s.targetPath}|${s.proposedContent}`)
    )
    const existingOllamaStableKeys = new Set(
      existingSuggestions
        .filter((s) => isOllamaSource(s.source) && typeof s.sourceId === 'string' && s.sourceId)
        .map((s) => `${s.source}|${s.sourceId}`)
    )

    const now = new Date()
    for (const candidate of candidates) {
      if (
        isOllamaSource(candidate.source) &&
        typeof candidate.sourceId === 'string' &&
        candidate.sourceId
      ) {
        const stableKey = `${candidate.source}|${candidate.sourceId}`
        if (existingOllamaStableKeys.has(stableKey)) continue
        existingOllamaStableKeys.add(stableKey)
      }

      const key = `${candidate.targetPath}|${candidate.proposedContent}`
      if (existingKeys.has(key)) continue

      db.insert(knowledgeSuggestions)
        .values({
          proposedAt: now,
          source: candidate.source,
          sourceId: candidate.sourceId,
          targetPath: candidate.targetPath,
          kind: candidate.kind,
          proposedContent: candidate.proposedContent,
          context: candidate.context,
          status: 'pending'
        })
        .run()

      existingKeys.add(key) // prevent dupes within this same run
    }
  } catch (err) {
    // Suggestion extraction is best-effort — never let it break a sync
    console.warn('[suggestions] extractor error:', (err as Error).message)
  }
}

function maybeSendNotification(service: string, recordsUpdated: number, error?: string): void {
  // Skip if nothing happened and no error
  if (recordsUpdated === 0 && !error) return

  if (!Notification.isSupported()) return

  try {
    const db = getDb()
    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'notificationsEnabled'))
      .get()
    const enabled = row ? row.value !== 'false' : true // default is 'true' per DEFAULTS
    if (!enabled) return

    const serviceLabel = service === 'google' ? 'Google' : 'GitHub'
    const title = `Compass — ${serviceLabel} synced`
    const body = error ? `Sync failed: ${error.slice(0, 80)}` : `${recordsUpdated} records updated`

    new Notification({ title, body }).show()
  } catch {
    // Best-effort only: never let notification failures affect sync results.
  }
}

/**
 * Apple Calendar (iCal) local read. No tokens, no network — we walk
 * `~/Library/Calendars` directly and upsert the next 14 days of events
 * into `calendar_events` with `source: 'apple'`. The renderer surfaces
 * them through the same Dashboard / Daily / Weekly UI that already
 * consumes Google calendar rows, so this is purely an ingest path.
 */
export async function syncAppleCalendar(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const db = getDb()
  let integrationId: number | null = null
  let recordsUpdated = 0

  try {
    const events = readAppleCalendars()
    for (const ev of events) {
      // Apple-side UIDs are stable per event; namespace them so they
      // never collide with Google's `id` values in the same column.
      const externalId = `apple:${ev.uid}`
      db.insert(calendarEvents)
        .values({
          source: 'apple',
          externalId,
          title: ev.title || '(No title)',
          startAt: ev.startAt,
          endAt: ev.endAt,
          allDay: ev.allDay,
          location: ev.location,
          description: ev.description,
          htmlLink: null,
          syncedAt: new Date()
        })
        .onConflictDoUpdate({
          target: calendarEvents.externalId,
          set: {
            title: ev.title || '(No title)',
            startAt: ev.startAt,
            endAt: ev.endAt,
            allDay: ev.allDay,
            location: ev.location,
            description: ev.description,
            syncedAt: new Date()
          }
        })
        .run()
      recordsUpdated++
    }

    // Update the integration row + log a sync event so the UI shows
    // last-synced / counts like every other service.
    db.insert(integrations)
      .values({
        service: 'apple-calendar',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()

    integrationId = getIntegrationId(db, 'apple-calendar')
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated, errors: null })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'apple-calendar',
      status: 'done',
      recordsUpdated
    })
    maybeSendNotification('apple-calendar', recordsUpdated)
    return { service: 'apple-calendar', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.update(integrations)
      .set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, 'apple-calendar'))
      .run()
    integrationId = getIntegrationId(db, 'apple-calendar')
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'apple-calendar',
      status: 'error',
      error: message
    })
    return { service: 'apple-calendar', success: false, error: message }
  }
}

export async function syncGoogle(
  mainWindow?: BrowserWindow | null,
  runExtractors = true
): Promise<SyncResult> {
  const tokens = loadToken('google') as { access_token?: string; refresh_token?: string } | null
  if (!tokens?.access_token) return { service: 'google', success: false, error: 'Not connected' }

  const db = getDb()
  const integrationId = getIntegrationId(db, 'google')
  let recordsUpdated = 0

  try {
    // Always get a valid (auto-refreshed) token — handles the 1-hour expiry silently
    const accessToken = await getValidGoogleToken()
    const headers = { Authorization: `Bearer ${accessToken}` }

    // ---- Calendar ----
    const now = new Date()
    const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    const calResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${twoWeeksOut.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`,
      { headers }
    )

    if (calResp.ok) {
      const calData = (await calResp.json()) as { items?: CalendarEvent[] }
      const events = calData.items || []
      for (const ev of events) {
        db.insert(calendarEvents)
          .values({
            source: 'google',
            externalId: ev.id,
            title: ev.summary || '(No title)',
            startAt: ev.start?.dateTime
              ? new Date(ev.start.dateTime)
              : ev.start?.date
                ? new Date(ev.start.date)
                : null,
            endAt: ev.end?.dateTime ? new Date(ev.end.dateTime) : null,
            allDay: !!ev.start?.date,
            location: ev.location,
            description: ev.description,
            htmlLink: ev.htmlLink,
            syncedAt: new Date()
          })
          .onConflictDoUpdate({
            target: calendarEvents.externalId,
            set: { title: ev.summary || '(No title)', syncedAt: new Date() }
          })
          .run()
        recordsUpdated++
      }
      await updateCalendarKnowledge(events)
    }

    // ---- Gmail ----
    const gmailResp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=20',
      { headers }
    )

    if (gmailResp.ok) {
      const gmailData = (await gmailResp.json()) as { messages?: { id: string }[] }
      const messages = gmailData.messages || []
      const actions: GmailMessage[] = []

      for (const msg of messages.slice(0, 10)) {
        const msgResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers }
        )
        if (!msgResp.ok) continue
        const msgData = (await msgResp.json()) as GmailMessageData
        const subject =
          msgData.payload?.headers?.find((h: { name: string }) => h.name === 'Subject')?.value ||
          '(No subject)'
        const from =
          msgData.payload?.headers?.find((h: { name: string }) => h.name === 'From')?.value || ''
        const date = msgData.payload?.headers?.find(
          (h: { name: string }) => h.name === 'Date'
        )?.value

        const action: GmailMessage = {
          id: msg.id,
          threadId: msgData.threadId,
          subject,
          from,
          snippet: msgData.snippet,
          date
        }
        actions.push(action)

        db.insert(gmailActions)
          .values({
            threadId: msgData.threadId,
            subject,
            fromAddress: from,
            snippet: msgData.snippet,
            receivedAt: date ? new Date(date) : new Date(),
            syncedAt: new Date()
          })
          .onConflictDoUpdate({
            target: gmailActions.threadId,
            set: { subject, syncedAt: new Date() }
          })
          .run()
        recordsUpdated++
      }
      await updateGmailKnowledge(actions)
    }

    // ---- Drive ----
    const driveResp = await fetch(
      'https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime desc&pageSize=30&fields=files(id,name,mimeType,webViewLink,modifiedTime)',
      { headers }
    )

    if (driveResp.ok) {
      const driveData = (await driveResp.json()) as { files?: DriveFile[] }
      const files = driveData.files || []
      for (const f of files) {
        db.insert(driveFiles)
          .values({
            externalId: f.id,
            name: f.name,
            mimeType: f.mimeType,
            url: f.webViewLink,
            lastModified: f.modifiedTime ? new Date(f.modifiedTime) : null,
            syncedAt: new Date()
          })
          .onConflictDoUpdate({
            target: driveFiles.externalId,
            set: {
              name: f.name,
              lastModified: f.modifiedTime ? new Date(f.modifiedTime) : null,
              syncedAt: new Date()
            }
          })
          .run()
        recordsUpdated++
      }
      await updateDriveKnowledge(files)
    }

    db.update(integrations)
      .set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, 'google'))
      .run()

    if (integrationId !== null) {
      db.insert(syncEvents)
        .values({
          integrationId,
          syncedAt: new Date(),
          recordsUpdated
        })
        .run()
    }

    mainWindow?.webContents.send('sync:update', {
      service: 'google',
      status: 'success',
      recordsUpdated
    })
    // Run pattern-based suggestion extractors after a successful Google sync
    if (runExtractors) {
      await runSuggestionExtractors()
    }

    maybeSendNotification('google', recordsUpdated)
    return { service: 'google', success: true, recordsUpdated }
  } catch (err) {
    const message = (err as Error).message
    db.update(integrations)
      .set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, 'google'))
      .run()
    if (integrationId !== null) {
      db.insert(syncEvents)
        .values({
          integrationId,
          syncedAt: new Date(),
          recordsUpdated: 0,
          errors: message
        })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'google',
      status: 'error',
      error: message
    })
    maybeSendNotification('google', 0, message)
    return { service: 'google', success: false, error: message }
  }
}

export async function syncGitHub(
  mainWindow?: BrowserWindow | null,
  runExtractors = true
): Promise<SyncResultInternal> {
  const tokens = loadToken('github') as { access_token?: string } | null
  if (!tokens?.access_token) return { service: 'github', success: false, error: 'Not connected' }

  const db = getDb()
  const integrationId = getIntegrationId(db, 'github')
  let recordsUpdated = 0
  let githubSuggestionInputs: GitHubInputItem[] = []

  try {
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/vnd.github.v3+json'
    }

    // Assigned issues
    const issuesResp = await fetch(
      'https://api.github.com/issues?filter=assigned&state=open&per_page=50',
      { headers }
    )

    if (issuesResp.ok) {
      const issues = (await issuesResp.json()) as GitHubIssue[]
      githubSuggestionInputs = issues.map((issue) => ({
        id: issue.id,
        html_url: issue.html_url,
        type: issue.pull_request ? 'pr' : 'issue',
        repo: issue.repository?.full_name || issue.html_url.split('/').slice(3, 5).join('/'),
        title: issue.title,
        assignee: issue.assignee ? { login: issue.assignee.login } : null,
        user: issue.user ? { login: issue.user.login } : null,
        labels: issue.labels?.map((l) => ({ name: l.name })) ?? []
      }))
      const items: GitHubIssue[] = []
      for (const issue of issues) {
        const isPR = !!issue.pull_request
        db.insert(githubItems)
          .values({
            type: isPR ? 'pr' : 'issue',
            repo: issue.repository?.full_name || issue.html_url.split('/').slice(3, 5).join('/'),
            externalId: String(issue.id),
            title: issue.title,
            url: issue.html_url,
            state: issue.state,
            body: issue.body?.slice(0, 500),
            labels: JSON.stringify(issue.labels?.map((l: { name: string }) => l.name) || []),
            syncedAt: new Date()
          })
          .onConflictDoUpdate({
            target: githubItems.externalId,
            set: { title: issue.title, state: issue.state, syncedAt: new Date() }
          })
          .run()
        recordsUpdated++
        items.push(issue)
      }
      await updateGitHubKnowledge(items)
    }

    db.update(integrations)
      .set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, 'github'))
      .run()

    if (integrationId !== null) {
      db.insert(syncEvents)
        .values({
          integrationId,
          syncedAt: new Date(),
          recordsUpdated
        })
        .run()
    }

    mainWindow?.webContents.send('sync:update', {
      service: 'github',
      status: 'success',
      recordsUpdated
    })
    // Run pattern-based suggestion extractors after a successful GitHub sync
    if (runExtractors) {
      await runSuggestionExtractors(githubSuggestionInputs)
    }

    maybeSendNotification('github', recordsUpdated)
    return { service: 'github', success: true, recordsUpdated, githubSuggestionInputs }
  } catch (err) {
    const message = (err as Error).message
    db.update(integrations)
      .set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, 'github'))
      .run()
    if (integrationId !== null) {
      db.insert(syncEvents)
        .values({
          integrationId,
          syncedAt: new Date(),
          recordsUpdated: 0,
          errors: message
        })
        .run()
    }
    maybeSendNotification('github', 0, message)
    return { service: 'github', success: false, error: message }
  }
}

export function registerSyncHandlers(ipcMain: IpcMain): void {
  const toPublicSyncResult = (result: SyncResultInternal): SyncResult => {
    const { service, success, recordsUpdated, error } = result
    return { service, success, recordsUpdated, error }
  }

  ipcMain.handle('sync:trigger', async (_event, service: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (service === 'google') return syncGoogle(win)
    if (service === 'github') return toPublicSyncResult(await syncGitHub(win))
    if (service === 'apple-calendar') return syncAppleCalendar(win)
    if (service === 'plaid') {
      const results = await syncAllPlaid()
      // Aggregate across every connected Item: `success` is true ONLY when
      // every Item finished without an error — strict semantics, so the
      // toast says "Plaid synced" only when every institution actually did.
      // Individual Item errors are still concatenated into `error` so the
      // UI can surface which ones failed even when most succeeded.
      const totalRecords = results.reduce((n, r) => n + r.added + r.modified + r.removed, 0)
      const errors = results
        .filter((r) => r.errorMessage)
        .map((r) => `${r.itemId}: ${r.errorMessage}`)
      return {
        service: 'plaid',
        success: errors.length === 0,
        recordsUpdated: totalRecords,
        error: errors.length > 0 ? errors.join('; ') : undefined
      }
    }
    return { error: 'Unknown service' }
  })

  ipcMain.handle('sync:trigger-all', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const [googleResult, githubResult, appleResult] = await Promise.all([
      syncGoogle(win, false),
      syncGitHub(win, false),
      syncAppleCalendar(win)
    ])
    if (googleResult.success || githubResult.success) {
      await runSuggestionExtractors(githubResult.githubSuggestionInputs ?? [])
    }
    return [
      toPublicSyncResult(googleResult),
      toPublicSyncResult(githubResult),
      toPublicSyncResult(appleResult)
    ]
  })

  ipcMain.handle('sync:set-interval', async (_event, service: string, minutes: number) => {
    const normalizedService = normalizeSupportedSyncService(service)
    if (!normalizedService) {
      return { success: false, error: 'Invalid service' }
    }
    const parsed = Number(minutes)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1440) {
      return { success: false, error: 'Invalid interval' }
    }
    const normalized = Math.floor(parsed)

    const db = getDb()
    const existing = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, normalizedService))
      .get()

    if (existing) {
      db.update(integrations)
        .set({ syncIntervalMinutes: normalized })
        .where(eq(integrations.service, normalizedService))
        .run()
    } else {
      db.insert(integrations)
        .values({
          service: normalizedService,
          status: 'disconnected',
          syncIntervalMinutes: normalized
        })
        .run()
    }

    // Lazy-load cron module to avoid an import cycle (cron.ts imports syncGoogle/syncGitHub from here).
    const { restartCronJobs } = await import('../cron')
    restartCronJobs()
    return { success: true, service: normalizedService, minutes: normalized }
  })

  ipcMain.handle('sync:get-status', () => {
    const db = getDb()
    return db.select().from(integrations).all()
  })

  ipcMain.handle('sync:get-log', () => {
    const db = getDb()
    const events = db.select().from(syncEvents).orderBy(desc(syncEvents.syncedAt)).limit(20).all()
    const integrationRows = db.select().from(integrations).all()
    const integrationMap: Record<number, string> = {}
    for (const i of integrationRows) integrationMap[i.id] = i.service

    return events.map((e) => ({
      id: e.id,
      service: e.integrationId ? (integrationMap[e.integrationId] ?? 'unknown') : 'unknown',
      syncedAt: e.syncedAt,
      recordsUpdated: e.recordsUpdated ?? 0,
      error: e.errors ?? null
    }))
  })

  // Calendar events query.
  //
  // Returns events from every supported source (currently `google` +
  // `apple`). Earlier versions hard-coded the filter to `google` only,
  // which meant Apple Calendar rows synced into `calendar_events` were
  // silently invisible to the Dashboard / Daily / Weekly views. The
  // `inArray` constraint keeps the boundary explicit — adding a new
  // source means flipping a switch here rather than every dashboard
  // page seeing every-third-party row by default.
  ipcMain.handle('calendar:get-events', (_event, start: string, end: string) => {
    const db = getDb()
    const startMs = new Date(start).getTime()
    const endMs = new Date(end).getTime()
    return db
      .select()
      .from(calendarEvents)
      .where(inArray(calendarEvents.source, ['google', 'apple']))
      .all()
      .filter((e) => e.startAt && e.startAt.getTime() >= startMs && e.startAt.getTime() <= endMs)
  })

  // GitHub items query
  ipcMain.handle('github:get-items', (_event, state?: string) => {
    const db = getDb()
    const rows = db.select().from(githubItems).all()
    return state ? rows.filter((r) => r.state === state) : rows
  })

  // Gmail actions query
  ipcMain.handle('gmail:get-actions', (_event, done?: boolean) => {
    const db = getDb()
    const rows = db.select().from(gmailActions).all()
    return done !== undefined ? rows.filter((r) => r.done === done) : rows
  })

  ipcMain.handle('gmail:mark-done', (_event, id: number) => {
    const db = getDb()
    db.update(gmailActions).set({ done: true }).where(eq(gmailActions.id, id)).run()
    return { success: true }
  })
}

// Type helpers
interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  location?: string
  description?: string
  htmlLink?: string
}

interface GmailMessage {
  id: string
  threadId: string
  subject: string
  from: string
  snippet?: string
  date?: string
}

interface GmailMessageData {
  threadId: string
  snippet?: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
  }
}

interface DriveFile {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
  modifiedTime?: string
}

interface GitHubIssue {
  id: number
  title: string
  html_url: string
  state: string
  body?: string
  labels?: Array<{ name: string }>
  repository?: { full_name: string }
  assignee?: { login: string } | null
  user?: { login: string } | null
  pull_request?: object
}
