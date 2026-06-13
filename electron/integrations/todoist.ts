/**
 * Todoist integration — Phase 7 Track B ("task sync"). Read-only, one-way:
 * imports the user's actionable Todoist tasks (overdue or due today) straight
 * into today's daily checklist as `source='todoist'` items, so they show up in
 * the user's real task list (Daily page) rather than a separate surface.
 *
 * Auth is a paste-once personal API token (no OAuth app), encrypted via the
 * standard `saveToken` path — same trust posture as the GitHub PAT. Todoist
 * personal tokens go in the `Authorization` header as a Bearer token.
 *
 * Sync semantics (deliberately simple + one-way):
 *   - Pull active tasks from the REST API (only non-completed tasks are
 *     returned), keep those due on/before today (overdue + due today). Future
 *     and no-due tasks are backlog, not today's agenda, so they're excluded.
 *   - Upsert onto TODAY's daily list keyed by `source_id`; on re-sync the
 *     title/due/priority refresh but the local `checked`/`status` is PRESERVED
 *     (checking an imported task in Compass sticks; the next sync won't undo it).
 *   - Prune today's `source='todoist'` items whose task is no longer in the
 *     pull (completed/deleted in Todoist, or no longer due) so the list stays
 *     current.
 *
 * The response → row transform (`normalizeTodoistTasks`) is pure; `syncTodoist`
 * owns the fetch + checklist/bookkeeping writes.
 */

import { and, eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { checklistItems, integrations, syncEvents } from '../db/schema'
import { loadToken } from '../ipc/auth'
import { localYmd } from '../lib/dates'

export const TODOIST_API = 'https://api.todoist.com/rest/v2'

// Todoist priority is 1 (normal) … 4 (urgent) in the API — inverted from the
// UI's P1..P4. We keep the raw API value; the checklist doesn't rank by it.
export interface TodoistTask {
  id: string
  content: string
  description?: string | null
  priority?: number | null
  due?: { date?: string | null } | null
  url?: string | null
  is_completed?: boolean
}

export interface TodoistTaskRow {
  sourceId: string
  title: string
  /** ISO 'YYYY-MM-DD' due date (always present — non-due tasks are filtered out). */
  dueDate: string
  url: string | null
}

/**
 * Pure: REST task list → actionable rows (overdue or due on/before `today`),
 * dropping completed tasks and anything missing id/content/due-date. `today`
 * is injected so the date comparison is testable.
 */
export function normalizeTodoistTasks(tasks: TodoistTask[], today: string): TodoistTaskRow[] {
  const rows: TodoistTaskRow[] = []
  for (const t of tasks) {
    if (!t?.id || !t.content || t.is_completed) continue
    const due = t.due?.date
    // Due dates can be 'YYYY-MM-DD' or a full datetime ('YYYY-MM-DDTHH:mm:ss').
    // Compare on the date portion only.
    if (!due) continue
    const dueDate = due.slice(0, 10)
    if (dueDate > today) continue // future task — backlog, not today's agenda
    rows.push({
      sourceId: t.id,
      title: t.content,
      dueDate,
      url: t.url ?? null
    })
  }
  return rows
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Import actionable Todoist tasks into today's daily checklist. Preserves the
 * local checked/status of any task already imported (keyed by source_id), and
 * prunes today's todoist items no longer returned. Same insert-on-conflict
 * integration-row + sync_events bookkeeping as the other integrations.
 */
export async function syncTodoist(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('todoist') as { access_token?: string } | null
  if (!tokens?.access_token) {
    return { service: 'todoist', success: false, error: 'Not connected' }
  }
  const db = getDb()
  const today = localYmd()

  try {
    const resp = await fetch(`${TODOIST_API}/tasks`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Todoist rejected the API token. Reconnect with a fresh token.')
    }
    if (!resp.ok) throw new Error(`Todoist API responded with HTTP ${resp.status}.`)
    const tasks = (await resp.json()) as TodoistTask[]
    const rows = normalizeTodoistTasks(Array.isArray(tasks) ? tasks : [], today)

    // Snapshot today's existing todoist items so we can preserve local
    // completion across the re-import and prune the ones that fell off.
    const existing = db
      .select({
        sourceId: checklistItems.sourceId,
        checked: checklistItems.checked,
        status: checklistItems.status
      })
      .from(checklistItems)
      .where(
        and(
          eq(checklistItems.listType, 'daily'),
          eq(checklistItems.listDate, today),
          eq(checklistItems.source, 'todoist')
        )
      )
      .all()
    const priorById = new Map(existing.map((e) => [e.sourceId, e]))
    const fresh = new Set(rows.map((r) => r.sourceId))

    let imported = 0
    let updated = 0
    rows.forEach((row, i) => {
      const prior = priorById.get(row.sourceId)
      if (prior) {
        // Update display fields only — never clobber the user's local state.
        db.update(checklistItems)
          .set({ title: row.title, dueDate: row.dueDate })
          .where(
            and(
              eq(checklistItems.listType, 'daily'),
              eq(checklistItems.listDate, today),
              eq(checklistItems.source, 'todoist'),
              eq(checklistItems.sourceId, row.sourceId)
            )
          )
          .run()
        updated++
      } else {
        db.insert(checklistItems)
          .values({
            listType: 'daily',
            listDate: today,
            title: row.title,
            category: 'personal',
            sortOrder: 500 + i, // after manual items (which start at 0)
            source: 'todoist',
            sourceId: row.sourceId,
            dueDate: row.dueDate,
            createdAt: new Date()
          })
          .run()
        imported++
      }
    })

    // Prune today's todoist items that are no longer actionable in Todoist.
    let removed = 0
    for (const e of existing) {
      if (e.sourceId && !fresh.has(e.sourceId)) {
        db.delete(checklistItems)
          .where(
            and(
              eq(checklistItems.listType, 'daily'),
              eq(checklistItems.listDate, today),
              eq(checklistItems.source, 'todoist'),
              eq(checklistItems.sourceId, e.sourceId)
            )
          )
          .run()
        removed++
      }
    }
    // Count refreshed rows too, so the telemetry reflects all DB writes
    // (matches Linear/other integrations rather than under-reporting).
    const recordsUpdated = imported + updated + removed

    db.insert(integrations)
      .values({
        service: 'todoist',
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
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'todoist'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'todoist',
      status: 'done',
      recordsUpdated
    })
    return { service: 'todoist', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'todoist', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'todoist'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'todoist',
      status: 'error',
      error: message
    })
    return { service: 'todoist', success: false, error: message }
  }
}
