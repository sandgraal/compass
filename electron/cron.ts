import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import cron from 'node-cron'
import { schedulePlaidDailySync, stopPlaidDailySync } from './cron-plaid'
import { getDb, getRawSqlite } from './db/client'
import { appSettings, integrations } from './db/schema'
import { captureSnapshots } from './integrations/finance-snapshot'
import { syncLinear } from './integrations/linear'
import { syncNotion } from './integrations/notion'
import { syncObsidian } from './integrations/obsidian'
import { syncTodoist } from './integrations/todoist'
import {
  computeLowCashAlert,
  computePriceHikeAlert,
  morningBriefCronExpr,
  notifyMorningBrief
} from './ipc/morning-brief'
import { syncAppleCalendar, syncGitHub, syncGoogle } from './ipc/sync'

// Map of service name -> active scheduled task (so we can stop/restart per integration).
const scheduledTasks = new Map<string, cron.ScheduledTask>()
let snapshotTask: cron.ScheduledTask | null = null
let morningBriefTask: cron.ScheduledTask | null = null

// Daily at 00:05 local time. Runs the net-worth balance snapshot pass for
// every account. Idempotent — captureSnapshots() skips accounts that
// already have a snapshot for today.
const SNAPSHOT_CRON = '5 0 * * *'

function runFinanceSnapshot(): void {
  try {
    const sqlite = getRawSqlite()
    captureSnapshots(sqlite)
  } catch (err) {
    console.error('[cron] finance snapshot failed:', err)
  }
}

function scheduleFinanceSnapshot(): void {
  snapshotTask?.stop()
  snapshotTask = cron.schedule(SNAPSHOT_CRON, runFinanceSnapshot)
  snapshotTask.start()
}

// Daily Morning Brief notification at the user-chosen local time
// (`morningBriefNotifyTime` = "HH:MM", or empty/off). Best-effort: a failure
// to read the setting or build the digest must never crash the scheduler.
function scheduleMorningBrief(): void {
  morningBriefTask?.stop()
  morningBriefTask = null
  let time: string | null = null
  try {
    const db = getDb()
    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'morningBriefNotifyTime'))
      .get()
    time = row?.value ?? null
  } catch (err) {
    console.warn('[cron] read morningBriefNotifyTime failed; brief notification off', err)
    return
  }
  const expr = morningBriefCronExpr(time)
  if (!expr) return // off / invalid → no schedule
  morningBriefTask = cron.schedule(expr, () => {
    try {
      const db = getDb()
      // Cheap gate first: if notifications are off, skip the (comparatively
      // expensive) cash-flow forecast entirely. notifyMorningBrief re-checks
      // this, but short-circuiting here avoids the forecast work each day.
      const notifRow = db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, 'notificationsEnabled'))
        .get()
      if (notifRow?.value === 'false') return
      const fireTime = new Date()
      notifyMorningBrief(
        db,
        fireTime,
        computeLowCashAlert(db, getRawSqlite(), fireTime),
        computePriceHikeAlert(db, fireTime)
      )
    } catch (err) {
      console.error('[cron] morning brief notification failed:', err)
    }
  })
  morningBriefTask.start()
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

/**
 * Default sync interval (minutes) used when seeding a brand-new integration row that has no
 * explicit value yet. Reads the legacy global `appSettings.syncInterval` so users who configured
 * it before per-integration intervals were a thing keep their preference for new integrations.
 */
function getDefaultIntervalMinutes(): number {
  try {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, 'syncInterval')).get()
    const parsed = Number.parseInt(row?.value ?? '15', 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15
  } catch (err) {
    console.warn('[cron] read syncInterval failed; defaulting to 15', err)
    return 15
  }
}

function runSyncForService(service: string): void {
  const win = getMainWindow()
  if (service === 'google') {
    void syncGoogle(win)
  } else if (service === 'github') {
    void syncGitHub(win)
  } else if (service === 'apple-calendar') {
    void syncAppleCalendar(win)
  } else if (service === 'obsidian') {
    void syncObsidian(win)
  } else if (service === 'notion') {
    void syncNotion(win)
  } else if (service === 'linear') {
    void syncLinear(win)
  } else if (service === 'todoist') {
    void syncTodoist(win)
  }
}

function stopAllJobs(): void {
  for (const task of scheduledTasks.values()) {
    task.stop()
  }
  scheduledTasks.clear()
  snapshotTask?.stop()
  snapshotTask = null
  morningBriefTask?.stop()
  morningBriefTask = null
  // Plaid daily task is scheduled separately (see cron-plaid.ts for the
  // rationale on why it's not driven by the per-integration interval).
  stopPlaidDailySync()
}

function cronExpressionForIntervalMinutes(intervalMinutes: number): string | null {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null

  const minutes = Math.floor(intervalMinutes)

  // Exact minute-based schedules.
  if (minutes >= 1 && minutes <= 59) {
    return `*/${minutes} * * * *`
  }

  // Exact hourly schedule.
  if (minutes === 60) {
    return '0 * * * *'
  }

  // Exact daily schedule.
  if (minutes === 1440) {
    return '0 0 * * *'
  }

  // Exact multi-hour schedules that cron can represent as "every N hours".
  if (minutes > 60 && minutes < 1440 && minutes % 60 === 0) {
    const hours = minutes / 60
    if (hours >= 1 && hours <= 23) {
      return `0 */${hours} * * *`
    }
  }

  // Do not silently change the configured interval to a different cadence.
  return null
}

function scheduleForService(service: string, intervalMinutes: number): void {
  // 0 (or invalid/unsupported) = manual only — skip scheduling entirely.
  const expr = cronExpressionForIntervalMinutes(intervalMinutes)
  if (!expr) return

  const task = cron.schedule(expr, () => runSyncForService(service))
  task.start()
  scheduledTasks.set(service, task)
}

export function startCronJobs(): void {
  stopAllJobs()
  try {
    const db = getDb()
    const rows = db.select().from(integrations).all()
    const fallback = getDefaultIntervalMinutes()
    for (const row of rows) {
      // Plaid uses its own daily-at-06:00 schedule rather than the
      // per-integration interval mechanism (the 15min default is wrong
      // for Plaid; see cron-plaid.ts for rationale).
      if (row.service === 'plaid') continue
      const interval = row.syncIntervalMinutes ?? fallback
      scheduleForService(row.service, interval)
    }
  } catch (err) {
    // DB not ready yet — caller will likely call restartCronJobs() once init completes.
    console.warn('[cron] scheduling from integrations failed (DB not ready?)', err)
  }
  scheduleFinanceSnapshot()
  scheduleMorningBrief()
  schedulePlaidDailySync()
}

export function restartCronJobs(): void {
  startCronJobs()
}
