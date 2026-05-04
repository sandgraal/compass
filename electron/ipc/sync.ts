import { IpcMain, BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { integrations, syncEvents, calendarEvents, githubItems, gmailActions, driveFiles } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { loadToken } from './auth'
import { updateCalendarKnowledge, updateGitHubKnowledge, updateGmailKnowledge, updateDriveKnowledge } from '../knowledge/extractor'

type SyncResult = {
  service: string
  success: boolean
  recordsUpdated?: number
  error?: string
}

export async function syncGoogle(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('google') as { access_token?: string; refresh_token?: string } | null
  if (!tokens?.access_token) return { service: 'google', success: false, error: 'Not connected' }

  const db = getDb()
  let recordsUpdated = 0

  try {
    const headers = { Authorization: `Bearer ${tokens.access_token}` }

    // ---- Calendar ----
    const now = new Date()
    const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    const calResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${twoWeeksOut.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`,
      { headers }
    )

    if (calResp.ok) {
      const calData = await calResp.json() as { items?: CalendarEvent[] }
      const events = calData.items || []
      for (const ev of events) {
        db.insert(calendarEvents).values({
          source: 'google',
          externalId: ev.id,
          title: ev.summary || '(No title)',
          startAt: ev.start?.dateTime ? new Date(ev.start.dateTime) : ev.start?.date ? new Date(ev.start.date) : null,
          endAt: ev.end?.dateTime ? new Date(ev.end.dateTime) : null,
          allDay: !!ev.start?.date,
          location: ev.location,
          description: ev.description,
          htmlLink: ev.htmlLink,
          syncedAt: new Date()
        }).onConflictDoUpdate({
          target: calendarEvents.externalId,
          set: { title: ev.summary || '(No title)', syncedAt: new Date() }
        }).run()
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
      const gmailData = await gmailResp.json() as { messages?: { id: string }[] }
      const messages = gmailData.messages || []
      const actions: GmailMessage[] = []

      for (const msg of messages.slice(0, 10)) {
        const msgResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers }
        )
        if (!msgResp.ok) continue
        const msgData = await msgResp.json() as GmailMessageData
        const subject = msgData.payload?.headers?.find((h: { name: string }) => h.name === 'Subject')?.value || '(No subject)'
        const from = msgData.payload?.headers?.find((h: { name: string }) => h.name === 'From')?.value || ''
        const date = msgData.payload?.headers?.find((h: { name: string }) => h.name === 'Date')?.value

        const action: GmailMessage = { id: msg.id, threadId: msgData.threadId, subject, from, snippet: msgData.snippet, date }
        actions.push(action)

        db.insert(gmailActions).values({
          threadId: msgData.threadId,
          subject,
          fromAddress: from,
          snippet: msgData.snippet,
          receivedAt: date ? new Date(date) : new Date(),
          syncedAt: new Date()
        }).onConflictDoUpdate({
          target: gmailActions.threadId,
          set: { subject, syncedAt: new Date() }
        }).run()
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
      const driveData = await driveResp.json() as { files?: DriveFile[] }
      const files = driveData.files || []
      for (const f of files) {
        db.insert(driveFiles).values({
          externalId: f.id,
          name: f.name,
          mimeType: f.mimeType,
          url: f.webViewLink,
          lastModified: f.modifiedTime ? new Date(f.modifiedTime) : null,
          syncedAt: new Date()
        }).onConflictDoUpdate({
          target: driveFiles.externalId,
          set: { name: f.name, lastModified: f.modifiedTime ? new Date(f.modifiedTime) : null, syncedAt: new Date() }
        }).run()
        recordsUpdated++
      }
      await updateDriveKnowledge(files)
    }

    db.update(integrations)
      .set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, 'google'))
      .run()

    db.insert(syncEvents).values({
      integrationId: 1,
      syncedAt: new Date(),
      recordsUpdated
    }).run()

    mainWindow?.webContents.send('sync:update', { service: 'google', status: 'success', recordsUpdated })
    return { service: 'google', success: true, recordsUpdated }

  } catch (err) {
    const message = (err as Error).message
    db.update(integrations)
      .set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, 'google'))
      .run()
    mainWindow?.webContents.send('sync:update', { service: 'google', status: 'error', error: message })
    return { service: 'google', success: false, error: message }
  }
}

export async function syncGitHub(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('github') as { access_token?: string } | null
  if (!tokens?.access_token) return { service: 'github', success: false, error: 'Not connected' }

  const db = getDb()
  let recordsUpdated = 0

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
      const issues = await issuesResp.json() as GitHubIssue[]
      const items: GitHubIssue[] = []
      for (const issue of issues) {
        const isPR = !!issue.pull_request
        db.insert(githubItems).values({
          type: isPR ? 'pr' : 'issue',
          repo: issue.repository?.full_name || issue.html_url.split('/').slice(3, 5).join('/'),
          externalId: String(issue.id),
          title: issue.title,
          url: issue.html_url,
          state: issue.state,
          body: issue.body?.slice(0, 500),
          labels: JSON.stringify(issue.labels?.map((l: { name: string }) => l.name) || []),
          syncedAt: new Date()
        }).onConflictDoUpdate({
          target: githubItems.externalId,
          set: { title: issue.title, state: issue.state, syncedAt: new Date() }
        }).run()
        recordsUpdated++
        items.push(issue)
      }
      await updateGitHubKnowledge(items)
    }

    db.update(integrations)
      .set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, 'github'))
      .run()

    mainWindow?.webContents.send('sync:update', { service: 'github', status: 'success', recordsUpdated })
    return { service: 'github', success: true, recordsUpdated }

  } catch (err) {
    const message = (err as Error).message
    db.update(integrations)
      .set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, 'github'))
      .run()
    return { service: 'github', success: false, error: message }
  }
}

export function registerSyncHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('sync:trigger', async (_event, service: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (service === 'google') return syncGoogle(win)
    if (service === 'github') return syncGitHub(win)
    return { error: 'Unknown service' }
  })

  ipcMain.handle('sync:trigger-all', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const results = await Promise.all([syncGoogle(win), syncGitHub(win)])
    return results
  })

  ipcMain.handle('sync:get-status', () => {
    const db = getDb()
    return db.select().from(integrations).all()
  })

  // Calendar events query
  ipcMain.handle('calendar:get-events', (_event, start: string, end: string) => {
    const db = getDb()
    const startMs = new Date(start).getTime()
    const endMs = new Date(end).getTime()
    return db.select().from(calendarEvents)
      .where(and(
        eq(calendarEvents.source, 'google')
      ))
      .all()
      .filter(e => e.startAt && e.startAt.getTime() >= startMs && e.startAt.getTime() <= endMs)
  })

  // GitHub items query
  ipcMain.handle('github:get-items', (_event, state?: string) => {
    const db = getDb()
    const rows = db.select().from(githubItems).all()
    return state ? rows.filter(r => r.state === state) : rows
  })

  // Gmail actions query
  ipcMain.handle('gmail:get-actions', (_event, done?: boolean) => {
    const db = getDb()
    const rows = db.select().from(gmailActions).all()
    return done !== undefined ? rows.filter(r => r.done === done) : rows
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
  pull_request?: object
}
