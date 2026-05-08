import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import cron from 'node-cron'
import { getDb } from './db/client'
import { appSettings, integrations } from './db/schema'
import { syncGitHub, syncGoogle } from './ipc/sync'

// Map of service name -> active scheduled task (so we can stop/restart per integration).
const scheduledTasks = new Map<string, cron.ScheduledTask>()

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
  } catch {
    return 15
  }
}

function runSyncForService(service: string): void {
  const win = getMainWindow()
  if (service === 'google') {
    void syncGoogle(win)
  } else if (service === 'github') {
    void syncGitHub(win)
  }
}

function stopAllJobs(): void {
  for (const task of scheduledTasks.values()) {
    task.stop()
  }
  scheduledTasks.clear()
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
      const interval = row.syncIntervalMinutes ?? fallback
      scheduleForService(row.service, interval)
    }
  } catch {
    // DB not ready yet — caller will likely call restartCronJobs() once init completes.
  }
}

export function restartCronJobs(): void {
  startCronJobs()
}
