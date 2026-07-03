/**
 * Oura Ring integration — the first `health-fitness` LIVE source (see
 * `electron/lib/storehouse-projectors.ts` for the projection philosophy).
 * Read-only: pulls the last 30 days of sleep/readiness/activity scores from
 * Oura's v2 API and merges them into one row per calendar day in
 * `oura_daily_metrics`.
 *
 * Auth is a paste-once Personal Access Token (Oura → Account → Personal Access
 * Tokens — no OAuth app registration needed), encrypted via the standard
 * `saveToken` path — same trust posture as the GitHub/Linear/Todoist PATs.
 * Oura PATs go in the `Authorization` header as a Bearer token.
 *
 * The response → row transforms (`normalizeOuraSleep` / `normalizeOuraReadiness`
 * / `normalizeOuraActivity` / `mergeOuraDailyRows`) are pure so they unit-test
 * without any network; `syncOura` owns the fetch + upsert + bookkeeping (same
 * insert-on-conflict integration-row + sync_events pattern as the other
 * integrations).
 */

import { and, eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { habitEntries, habits, integrations, ouraDailyMetrics, syncEvents } from '../db/schema'
import { loadToken } from '../ipc/auth'
import { afterConnectorSync } from '../ipc/storehouse-sync'
import { updateOuraKnowledge } from '../knowledge/extractor'
import { localYmd } from '../lib/dates'
import { computeHabitAutoFills } from '../lib/habit-autolink'

export const OURA_API = 'https://api.ouraring.com'
/** How many trailing days to pull on every sync — cheap + covers re-sync drift. */
const WINDOW_DAYS = 30

// ---- Raw API shapes (v2 `daily_*` collection endpoints) --------------------
// Oura's public docs describe `contributors.total_sleep` as SECONDS. If the
// exact nested field name drifts in a future API revision, adjust the reader
// inside `normalizeOuraSleep` — it's the only place that touches this shape.

export interface OuraDailySleepItem {
  day?: string | null
  score?: number | null
  contributors?: { total_sleep?: number | null } | null
}

export interface OuraDailyReadinessItem {
  day?: string | null
  score?: number | null
}

export interface OuraDailyActivityItem {
  day?: string | null
  score?: number | null
  steps?: number | null
}

export interface OuraCollectionResponse<T> {
  data?: T[]
}

export interface OuraSleepRow {
  date: string // 'YYYY-MM-DD'
  sleepScore: number | null
  totalSleepMinutes: number | null
}

export interface OuraReadinessRow {
  date: string
  readinessScore: number | null
}

export interface OuraActivityRow {
  date: string
  activityScore: number | null
  steps: number | null
}

/** The merged, one-row-per-day shape written to `oura_daily_metrics`. */
export interface OuraDailyMetricRow {
  date: string
  sleepScore: number | null
  readinessScore: number | null
  activityScore: number | null
  steps: number | null
  totalSleepMinutes: number | null
}

/** Pure: `daily_sleep` items → rows, converting `contributors.total_sleep` seconds → minutes. */
export function normalizeOuraSleep(items: OuraDailySleepItem[]): OuraSleepRow[] {
  const rows: OuraSleepRow[] = []
  for (const item of items ?? []) {
    if (!item?.day) continue
    const seconds = item.contributors?.total_sleep
    rows.push({
      date: item.day,
      sleepScore: typeof item.score === 'number' ? item.score : null,
      totalSleepMinutes: typeof seconds === 'number' ? Math.round(seconds / 60) : null
    })
  }
  return rows
}

/** Pure: `daily_readiness` items → rows. */
export function normalizeOuraReadiness(items: OuraDailyReadinessItem[]): OuraReadinessRow[] {
  const rows: OuraReadinessRow[] = []
  for (const item of items ?? []) {
    if (!item?.day) continue
    rows.push({
      date: item.day,
      readinessScore: typeof item.score === 'number' ? item.score : null
    })
  }
  return rows
}

/** Pure: `daily_activity` items → rows. */
export function normalizeOuraActivity(items: OuraDailyActivityItem[]): OuraActivityRow[] {
  const rows: OuraActivityRow[] = []
  for (const item of items ?? []) {
    if (!item?.day) continue
    rows.push({
      date: item.day,
      activityScore: typeof item.score === 'number' ? item.score : null,
      steps: typeof item.steps === 'number' ? item.steps : null
    })
  }
  return rows
}

/**
 * Pure: merge the three per-endpoint row lists into one row per date. A date
 * present in any of the three inputs produces a row (missing fields stay
 * null) — Oura's three endpoints don't always finish processing the same set
 * of days at the same time.
 */
export function mergeOuraDailyRows(
  sleep: OuraSleepRow[],
  readiness: OuraReadinessRow[],
  activity: OuraActivityRow[]
): OuraDailyMetricRow[] {
  const byDate = new Map<string, OuraDailyMetricRow>()
  const get = (date: string): OuraDailyMetricRow => {
    let row = byDate.get(date)
    if (!row) {
      row = {
        date,
        sleepScore: null,
        readinessScore: null,
        activityScore: null,
        steps: null,
        totalSleepMinutes: null
      }
      byDate.set(date, row)
    }
    return row
  }
  for (const s of sleep) {
    const row = get(s.date)
    row.sleepScore = s.sleepScore
    row.totalSleepMinutes = s.totalSleepMinutes
  }
  for (const r of readiness) {
    get(r.date).readinessScore = r.readinessScore
  }
  for (const a of activity) {
    const row = get(a.date)
    row.activityScore = a.activityScore
    row.steps = a.steps
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 'YYYY-MM-DD' for `daysAgo` days before `today` (local calendar day). */
function daysBefore(today: string, daysAgo: number): string {
  const d = new Date(`${today}T00:00:00`)
  d.setDate(d.getDate() - daysAgo)
  return localYmd(d)
}

async function fetchOuraCollection<T>(
  path: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<T[]> {
  const url = new URL(`${OURA_API}${path}`)
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', endDate)
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Oura rejected the API token. Reconnect with a fresh token.')
  }
  if (!resp.ok) throw new Error(`Oura API responded with HTTP ${resp.status}.`)
  const json = (await resp.json()) as OuraCollectionResponse<T>
  return Array.isArray(json.data) ? json.data : []
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/** Metric-key → value lookup for one merged Oura day, matching `habits.autoLinkSource` values. */
function ouraMetricsFor(row: OuraDailyMetricRow): Record<string, number | null> {
  return {
    'oura-sleep-score': row.sleepScore,
    'oura-readiness-score': row.readinessScore,
    'oura-steps': row.steps
  }
}

/**
 * Cross-domain leverage: auto-fill TODAY's habit entry for any active habit
 * whose `autoLinkSource` points at an Oura metric that met its threshold.
 * Same "pre-populated but user-editable" trust model as the Todoist/Things
 * daily-checklist imports — an entry the user has already touched manually
 * (source is null, set by `habits:toggle`) is NEVER overwritten; only an
 * entry this function itself created (`source: 'oura'`) is refreshed on a
 * later re-sync. Defensive by construction: a bad/missing row is a no-op.
 */
function applyOuraHabitAutoLinks(
  db: ReturnType<typeof getDb>,
  todayRow: OuraDailyMetricRow | undefined
): void {
  if (!todayRow) return
  const linkedHabits = db
    .select({
      id: habits.id,
      autoLinkSource: habits.autoLinkSource,
      autoLinkThreshold: habits.autoLinkThreshold
    })
    .from(habits)
    .where(eq(habits.active, true))
    .all()
    .filter((h) => h.autoLinkSource?.startsWith('oura-'))
  if (linkedHabits.length === 0) return

  const fills = computeHabitAutoFills(linkedHabits, todayRow.date, ouraMetricsFor(todayRow))
  for (const fill of fills) {
    const existing = db
      .select({ id: habitEntries.id, source: habitEntries.source })
      .from(habitEntries)
      .where(and(eq(habitEntries.habitId, fill.habitId), eq(habitEntries.date, fill.date)))
      .get()
    if (existing) {
      // Only refresh an entry WE previously auto-filled — a manual (or other-source)
      // entry stays exactly as the user left it.
      if (existing.source === 'oura') {
        db.update(habitEntries)
          .set({ completed: true })
          .where(eq(habitEntries.id, existing.id))
          .run()
      }
      continue
    }
    db.insert(habitEntries)
      .values({ habitId: fill.habitId, date: fill.date, completed: true, source: 'oura' })
      .run()
  }
}

/**
 * Pull the last `WINDOW_DAYS` of sleep/readiness/activity from Oura and upsert
 * one merged row per date into `oura_daily_metrics`. Same insert-on-conflict
 * integration-row + sync_events bookkeeping as the other integrations, and the
 * same defensive `afterConnectorSync()` call at the end as GitHub/Linear so the
 * scores land on the Storehouse timeline.
 */
export async function syncOura(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('oura') as { access_token?: string } | null
  if (!tokens?.access_token) {
    return { service: 'oura', success: false, error: 'Not connected' }
  }
  const db = getDb()
  const today = localYmd()
  const startDate = daysBefore(today, WINDOW_DAYS)

  try {
    const [sleepItems, readinessItems, activityItems] = await Promise.all([
      fetchOuraCollection<OuraDailySleepItem>(
        '/v2/usercollection/daily_sleep',
        tokens.access_token,
        startDate,
        today
      ),
      fetchOuraCollection<OuraDailyReadinessItem>(
        '/v2/usercollection/daily_readiness',
        tokens.access_token,
        startDate,
        today
      ),
      fetchOuraCollection<OuraDailyActivityItem>(
        '/v2/usercollection/daily_activity',
        tokens.access_token,
        startDate,
        today
      )
    ])

    const rows = mergeOuraDailyRows(
      normalizeOuraSleep(sleepItems),
      normalizeOuraReadiness(readinessItems),
      normalizeOuraActivity(activityItems)
    )

    let recordsUpdated = 0
    for (const row of rows) {
      db.insert(ouraDailyMetrics)
        .values({
          date: row.date,
          sleepScore: row.sleepScore,
          readinessScore: row.readinessScore,
          activityScore: row.activityScore,
          steps: row.steps,
          totalSleepMinutes: row.totalSleepMinutes,
          syncedAt: new Date()
        })
        .onConflictDoUpdate({
          target: ouraDailyMetrics.date,
          set: {
            sleepScore: row.sleepScore,
            readinessScore: row.readinessScore,
            activityScore: row.activityScore,
            steps: row.steps,
            totalSleepMinutes: row.totalSleepMinutes,
            syncedAt: new Date()
          }
        })
        .run()
      recordsUpdated++
    }

    if (rows.length > 0) {
      await updateOuraKnowledge(rows)
    }

    // Cross-domain leverage: auto-fill today's linked habit entries. Defensive
    // — never allowed to fail the sync (a habit-config bug shouldn't break Oura data).
    try {
      applyOuraHabitAutoLinks(
        db,
        rows.find((r) => r.date === today)
      )
    } catch (err) {
      console.warn('[oura] habit auto-link failed (non-fatal):', err)
    }

    db.insert(integrations)
      .values({
        service: 'oura',
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
      .where(eq(integrations.service, 'oura'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'oura',
      status: 'done',
      recordsUpdated
    })
    // Project the freshly synced scores into the Storehouse spine (Timeline/Search).
    // Defensive — never fails the sync.
    afterConnectorSync()
    return { service: 'oura', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'oura', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'oura'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'oura',
      status: 'error',
      error: message
    })
    return { service: 'oura', success: false, error: message }
  }
}
