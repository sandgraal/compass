/**
 * Things 3 integration — Phase 7 Track B ("task sync"), local-first variant.
 *
 * Things 3 keeps its data in a local SQLite database inside the app's macOS
 * group container — there is no cloud API and no token. We open that database
 * READ-ONLY and import the user's actionable to-dos (overdue or due/scheduled
 * for today) straight into today's daily checklist as `source='things'` items,
 * so they show up in the real Daily task list rather than a separate surface.
 * This mirrors the Todoist importer's checklist semantics, but the source is a
 * local file (like the Apple Calendar reader) rather than a network call.
 *
 * Sync semantics (deliberately simple + one-way):
 *   - Read open to-dos from `TMTask`, keep those whose effective date
 *     (deadline, else scheduled `startDate`) is on/before today. Future and
 *     un-dated tasks are backlog, not today's agenda, so they're excluded —
 *     same rule as the Todoist importer.
 *   - Upsert onto TODAY's daily list keyed by `source_id` (the Things uuid);
 *     on re-sync the title/due refresh but the local `checked`/`status` is
 *     PRESERVED (checking an imported task in Compass sticks).
 *   - Prune today's `source='things'` items whose task is no longer actionable
 *     so the list stays current.
 *
 * Opt-in: Things is local + tokenless, so its "opt-in" signal is the
 * integration row. `sync:trigger('things')` (Connect / manual refresh) flips
 * the row to `connected`; `syncThings` self-gates when the row is
 * `disconnected` so the daily cron tick can't re-import after the user
 * disconnects (the scheduled task outlives the row for the session).
 *
 * Date decoding: Things 3 stores `startDate`/`deadline` as a bit-packed
 * integer (NOT a Core Data timestamp): year in bits 16+, month in bits 12-15,
 * day in bits 7-11. `decodeThingsDate` unpacks it; verified against the
 * documented example 132464128 → 2021-03-28.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { checklistItems, integrations, syncEvents } from '../db/schema'
import { localYmd } from '../lib/dates'

/** The macOS group container that holds the Things 3 database. The team-id
 * prefix can vary, so we match on the suffix. */
const THINGS_CONTAINER_SUFFIX = '.com.culturedcode.ThingsMac'
const THINGS_DB_LEAF = join('Things Database.thingsdatabase', 'main.sqlite')

function defaultGroupContainersDir(): string {
  return join(homedir(), 'Library', 'Group Containers')
}

/**
 * Locate the Things 3 SQLite database, or null if Things isn't installed.
 * The DB lives at either
 *   <group-container>/Things Database.thingsdatabase/main.sqlite
 * or, on newer builds, nested under a `ThingsData-*` subfolder. `root` is
 * injectable for tests.
 */
export function resolveThingsDbPath(root: string = defaultGroupContainersDir()): string | null {
  let containers: string[]
  try {
    if (!existsSync(root)) return null
    containers = readdirSync(root)
  } catch (err) {
    console.warn('[things] failed to list group containers', root, err)
    return null
  }
  const container = containers.find((name) => name.endsWith(THINGS_CONTAINER_SUFFIX))
  if (!container) return null
  const containerPath = join(root, container)

  // Direct layout first.
  const direct = join(containerPath, THINGS_DB_LEAF)
  if (existsSync(direct)) return direct

  // Nested `ThingsData-*` layout (newer versions).
  let subdirs: string[]
  try {
    subdirs = readdirSync(containerPath)
  } catch (err) {
    console.warn('[things] failed to list Things container', containerPath, err)
    return null
  }
  for (const sub of subdirs) {
    if (!sub.startsWith('ThingsData')) continue
    const candidate = join(containerPath, sub, THINGS_DB_LEAF)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Unpack a Things 3 bit-packed date integer into an ISO 'YYYY-MM-DD' string.
 * Returns null for null/0/garbage. Verified: 132464128 → '2021-03-28'.
 */
export function decodeThingsDate(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const year = (value >> 16) & 0x7ff
  const month = (value >> 12) & 0x0f
  const day = (value >> 7) & 0x1f
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/** A decoded open to-do row read from the Things database. */
export interface ThingsRow {
  uuid: string
  title: string | null
  status: number
  type: number
  trashed: number
  /** Scheduled "when" date, decoded to 'YYYY-MM-DD' (or null). */
  startDate: string | null
  /** Deadline / due date, decoded to 'YYYY-MM-DD' (or null). */
  deadline: string | null
}

/**
 * Read open to-dos from a Things 3 database file (READ-ONLY). Filters to
 * actionable rows (`type=0` to-dos, `status=0` incomplete, not trashed) in
 * SQL; date decoding happens here so `normalizeThingsTasks` stays pure over
 * plain strings. `dbPath` is required (resolved by the caller).
 */
export function readThingsTasks(dbPath: string): ThingsRow[] {
  // `fileMustExist` so a wrong path throws a clear error rather than creating
  // an empty DB. Read-only — we never write to the user's Things database.
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const raw = sqlite
      .prepare(
        `SELECT uuid, title, status, type, trashed, startDate, deadline
         FROM TMTask
         WHERE type = 0 AND status = 0 AND trashed = 0`
      )
      .all() as Array<{
      uuid: string
      title: string | null
      status: number
      type: number
      trashed: number
      startDate: number | null
      deadline: number | null
    }>
    return raw.map((r) => ({
      uuid: r.uuid,
      title: r.title,
      status: r.status,
      type: r.type,
      trashed: r.trashed,
      startDate: decodeThingsDate(r.startDate),
      deadline: decodeThingsDate(r.deadline)
    }))
  } finally {
    sqlite.close()
  }
}

export interface ThingsTaskRow {
  sourceId: string
  title: string
  /** Effective date: deadline if set, else the scheduled startDate. Always
   * present and on/before `today` (un-dated + future tasks are filtered out). */
  dueDate: string
}

/**
 * Pure: decoded Things rows → actionable checklist rows (overdue or due/
 * scheduled on or before `today`), dropping completed/canceled/trashed,
 * non-to-do, untitled, and un-dated/future tasks. `today` is injected so the
 * date comparison is testable.
 */
export function normalizeThingsTasks(rows: ThingsRow[], today: string): ThingsTaskRow[] {
  const out: ThingsTaskRow[] = []
  for (const r of rows) {
    if (!r?.uuid || !r.title) continue
    if (r.status !== 0 || r.type !== 0 || r.trashed) continue
    // Deadline is the strongest "do it by" signal; fall back to the scheduled
    // date so a task the user dropped into Today (startDate=today, no deadline)
    // still surfaces.
    const dueDate = r.deadline ?? r.startDate
    if (!dueDate) continue
    if (dueDate > today) continue // future — backlog, not today's agenda
    out.push({ sourceId: r.uuid, title: r.title, dueDate })
  }
  return out
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Import actionable Things 3 to-dos into today's daily checklist. Preserves the
 * local checked/status of any task already imported (keyed by source_id) and
 * prunes today's things items no longer returned. Same insert-on-conflict
 * integration-row + sync_events bookkeeping as the other integrations.
 *
 * `opts.dbPath` / `opts.root` are injectable for tests; in production the path
 * is resolved from the Things group container.
 */
export async function syncThings(
  mainWindow?: BrowserWindow | null,
  opts?: { dbPath?: string; root?: string }
): Promise<SyncResult> {
  const db = getDb()
  const today = localYmd()

  // Opt-in self-gate: a `disconnected` row means the user turned Things off.
  // Cron calls syncThings directly and the scheduled task outlives the row for
  // the session, so without this an interval tick would silently re-import
  // after a disconnect. Returns without touching any rows (like Todoist's
  // no-token bail). `sync:trigger('things')` flips the row back to connected
  // before calling us, so Connect / reconnect still work.
  const current = db
    .select({ status: integrations.status })
    .from(integrations)
    .where(eq(integrations.service, 'things'))
    .get()
  if (current?.status === 'disconnected') {
    return { service: 'things', success: false, error: 'Not connected' }
  }

  try {
    const dbPath = opts?.dbPath ?? resolveThingsDbPath(opts?.root)
    if (!dbPath) {
      throw new Error('Things 3 database not found. Is Things installed on this Mac?')
    }
    const rows = normalizeThingsTasks(readThingsTasks(dbPath), today)

    // Snapshot today's existing things items so we can preserve local
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
          eq(checklistItems.source, 'things')
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
              eq(checklistItems.source, 'things'),
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
            source: 'things',
            sourceId: row.sourceId,
            dueDate: row.dueDate,
            createdAt: new Date()
          })
          .run()
        imported++
      }
    })

    // Prune today's things items that are no longer actionable in Things.
    let removed = 0
    for (const e of existing) {
      if (e.sourceId && !fresh.has(e.sourceId)) {
        db.delete(checklistItems)
          .where(
            and(
              eq(checklistItems.listType, 'daily'),
              eq(checklistItems.listDate, today),
              eq(checklistItems.source, 'things'),
              eq(checklistItems.sourceId, e.sourceId)
            )
          )
          .run()
        removed++
      }
    }
    // Count refreshed + pruned rows too, so telemetry reflects all DB writes.
    const recordsUpdated = imported + updated + removed

    db.insert(integrations)
      .values({
        service: 'things',
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
      .where(eq(integrations.service, 'things'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'things',
      status: 'done',
      recordsUpdated
    })
    return { service: 'things', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Upsert (not a plain UPDATE): like Apple Calendar, Things has no token
    // flow that pre-creates the row, so a first-ever failure must still create
    // an error row to surface on the card.
    db.insert(integrations)
      .values({ service: 'things', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'things'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'things',
      status: 'error',
      error: message
    })
    return { service: 'things', success: false, error: message }
  }
}
