/**
 * Apple Reminders integration — Phase 7 Track B ("task sync"), local-first
 * variant. Sibling of the Things 3 reader, but Reminders is the hard case:
 * unlike Things (a readable SQLite DB), Apple Calendar (readable .ics files),
 * or iMessage (readable chat.db), **Reminders has no user-parseable on-disk
 * store** — `~/Library/Reminders/` is TCC-locked opaque Core Data. So the
 * file-parse pattern the other local integrations use does not apply; we have
 * to go through EventKit's public surface.
 *
 * Read seam (`readReminders`): two mechanisms can fill it, and we deliberately
 * keep the raw read behind one function so either can win.
 *   (A) **JXA / osascript bridge (implemented here).** Spawn
 *       `osascript -l JavaScript` to enumerate incomplete reminders and emit
 *       JSON. No native compilation — the fastest path to a working prototype,
 *       and the first non-better-sqlite3 process spawn in the app runtime.
 *   (B) **Native EventKit N-API addon (future).** A compiled Swift/ObjC addon
 *       calling `EKEventStore.requestFullAccessToReminders`. More robust, native
 *       Reminders TCC — but a net-new native-build toolchain. Slots in by
 *       replacing `readReminders`; `normalizeReminders`/`syncAppleReminders`
 *       don't change.
 *
 * TCC / signing note: BOTH mechanisms need a macOS permission grant, and the
 * grant only fires reliably in a **signed + hardened-runtime + notarized**
 * build (entitlements + `NS…UsageDescription` — see `resources/entitlements.mac.plist`
 * and Track 4 of the spike plan). That's why the registry entry ships
 * `connected: false` for now: the wiring and read are real and unit-tested, but
 * the feature can't be proven for end users until notarization is configured.
 *
 * Sync semantics mirror the Things importer exactly (one-way, deliberately
 * simple):
 *   - Keep incomplete reminders whose due date is on/before today (overdue or
 *     due today). Future and un-dated reminders are backlog, not today's agenda.
 *   - Upsert onto TODAY's daily list keyed by `source_id` (the EventKit item
 *     id); on re-sync the title/due refresh but the local `checked`/`status` is
 *     PRESERVED.
 *   - Prune today's `source='apple-reminders'` items no longer returned.
 *
 * Opt-in: like Things, the opt-in signal is the integration row.
 * `sync:trigger('apple-reminders')` flips the row to `connected`;
 * `syncAppleReminders` self-gates when the row is `disconnected` so a cron tick
 * can't re-import after a disconnect.
 */

import { execFile } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { checklistItems, integrations, syncEvents } from '../db/schema'
import { localYmd } from '../lib/dates'

/** One incomplete reminder as read from EventKit (via the JXA bridge). Dates are
 * already formatted to a LOCAL 'YYYY-MM-DD' by the reader so the normalize step
 * stays a pure string comparison, matching the Things reader's contract. */
export interface ReminderRow {
  /** EventKit calendarItem identifier — stable across syncs. */
  id: string
  title: string | null
  completed: boolean
  /** Due date decoded to local 'YYYY-MM-DD', or null if the reminder has none. */
  dueDate: string | null
  /** Owning list name (context only; not used by the importer). */
  list: string | null
}

/**
 * JavaScript-for-Automation script: enumerate every Reminders list, take its
 * incomplete reminders, and emit a JSON array of `ReminderRow`. Each field
 * access is guarded — a single malformed reminder must not abort the whole
 * read. Due dates are formatted to a LOCAL ymd here (getFullYear/Month/Date are
 * local) so the TS side never has to reason about time zones — same local-day
 * semantics as the Things bit-packed dates.
 */
const REMINDERS_JXA = `
function ymd(d) {
  if (!d) return null
  var y = d.getFullYear()
  var m = ('0' + (d.getMonth() + 1)).slice(-2)
  var day = ('0' + d.getDate()).slice(-2)
  return y + '-' + m + '-' + day
}
var app = Application('Reminders')
var out = []
var lists = app.lists()
for (var i = 0; i < lists.length; i++) {
  var listName = null
  try { listName = lists[i].name() } catch (e) {}
  var rem = []
  try { rem = lists[i].reminders.whose({ completed: false })() } catch (e) { rem = [] }
  for (var j = 0; j < rem.length; j++) {
    var r = rem[j]
    var id = null, title = null, due = null
    try { id = r.id() } catch (e) {}
    try { title = r.name() } catch (e) {}
    try { due = ymd(r.dueDate()) } catch (e) {}
    if (id) out.push({ id: id, title: title, completed: false, dueDate: due, list: listName })
  }
}
JSON.stringify(out)
`.trim()

/** Bound on the JSON the bridge may return — a runaway Reminders store must not
 * exhaust memory buffering osascript output. */
const MAX_JXA_OUTPUT_BYTES = 32 * 1024 * 1024
const JXA_TIMEOUT_MS = 30_000

/**
 * Read incomplete reminders via the JXA/osascript bridge (READ-ONLY). macOS
 * only — mirrors the Things "not found" story with a clear, user-facing error
 * off-platform or when Automation/Reminders access is denied (the spawn throws,
 * which the caller surfaces on the integration row). `run` is injectable so
 * tests never shell out.
 */
export async function readReminders(
  run: (script: string) => string | Promise<string> = defaultOsascriptRun
): Promise<ReminderRow[]> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Apple Reminders is macOS-only and requires Reminders access in System Settings › Privacy & Security.'
    )
  }
  const raw = await run(REMINDERS_JXA)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Reminders bridge returned malformed output')
  }
  if (!Array.isArray(parsed)) throw new Error('Reminders bridge did not return a list')
  return parsed
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      title: typeof r.title === 'string' ? r.title : null,
      completed: r.completed === true,
      dueDate: typeof r.dueDate === 'string' ? r.dueDate : null,
      list: typeof r.list === 'string' ? r.list : null
    }))
}

/** Default read: spawn `osascript -l JavaScript`. Separated so the reader is
 * pure over its `run` seam and tests inject a fake instead of shelling out. */
function defaultOsascriptRun(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { encoding: 'utf8', timeout: JXA_TIMEOUT_MS, maxBuffer: MAX_JXA_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) reject(new Error(`Reminders access failed: ${err.message}`))
        else resolve(stdout)
      }
    )
  })
}

export interface ReminderTaskRow {
  sourceId: string
  title: string
  /** Effective due date; always present and on/before `today`. */
  dueDate: string
}

/**
 * Pure: reminder rows → actionable checklist rows (overdue or due on/before
 * `today`), dropping completed, untitled, and un-dated/future reminders. `today`
 * is injected so the date comparison is testable. Same shape + filtering rule as
 * `normalizeThingsTasks`.
 */
export function normalizeReminders(rows: ReminderRow[], today: string): ReminderTaskRow[] {
  const out: ReminderTaskRow[] = []
  for (const r of rows) {
    if (!r?.id || !r.title) continue
    if (r.completed) continue
    const dueDate = r.dueDate
    if (!dueDate) continue
    if (dueDate > today) continue // future — backlog, not today's agenda
    out.push({ sourceId: r.id, title: r.title, dueDate })
  }
  return out
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Import actionable Apple Reminders into today's daily checklist. Preserves the
 * local checked/status of any reminder already imported (keyed by source_id) and
 * prunes today's apple-reminders items no longer returned. Same insert-on-conflict
 * integration-row + sync_events bookkeeping as the other integrations.
 *
 * `opts.reader` is injectable for tests; in production it's the JXA bridge.
 */
export async function syncAppleReminders(
  mainWindow?: BrowserWindow | null,
  opts?: { reader?: () => ReminderRow[] | Promise<ReminderRow[]> }
): Promise<SyncResult> {
  const db = getDb()
  const today = localYmd()

  // Opt-in self-gate: a `disconnected` row means the user turned Reminders off.
  // Cron calls syncAppleReminders directly, so without this an interval tick
  // would silently re-import after a disconnect. `sync:trigger('apple-reminders')`
  // flips the row back to connected before calling us, so reconnect still works.
  const current = db
    .select({ status: integrations.status })
    .from(integrations)
    .where(eq(integrations.service, 'apple-reminders'))
    .get()
  if (current?.status === 'disconnected') {
    return { service: 'apple-reminders', success: false, error: 'Not connected' }
  }

  try {
    const read = opts?.reader ?? (() => readReminders())
    const rows = normalizeReminders(await read(), today)

    // Snapshot today's existing apple-reminders items so we can preserve local
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
          eq(checklistItems.source, 'apple-reminders')
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
              eq(checklistItems.source, 'apple-reminders'),
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
            source: 'apple-reminders',
            sourceId: row.sourceId,
            dueDate: row.dueDate,
            createdAt: new Date()
          })
          .run()
        imported++
      }
    })

    // Prune today's apple-reminders items no longer returned by Reminders.
    let removed = 0
    for (const e of existing) {
      if (e.sourceId && !fresh.has(e.sourceId)) {
        db.delete(checklistItems)
          .where(
            and(
              eq(checklistItems.listType, 'daily'),
              eq(checklistItems.listDate, today),
              eq(checklistItems.source, 'apple-reminders'),
              eq(checklistItems.sourceId, e.sourceId)
            )
          )
          .run()
        removed++
      }
    }
    const recordsUpdated = imported + updated + removed

    db.insert(integrations)
      .values({
        service: 'apple-reminders',
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
      .where(eq(integrations.service, 'apple-reminders'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'apple-reminders',
      status: 'done',
      recordsUpdated
    })
    return { service: 'apple-reminders', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Upsert (not a plain UPDATE): like Things, Reminders has no token flow that
    // pre-creates the row, so a first-ever failure must still create an error
    // row to surface on the card.
    db.insert(integrations)
      .values({ service: 'apple-reminders', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'apple-reminders'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'apple-reminders',
      status: 'error',
      error: message
    })
    return { service: 'apple-reminders', success: false, error: message }
  }
}
