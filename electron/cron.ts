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

function scheduleForService(service: string, intervalMinutes: number): void {
  // 0 (or invalid) = manual only — skip scheduling entirely.
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return

  // node-cron supports `*/N * * * *`; clamp upper bound at 59 minutes for predictable cron syntax.
  const minutes = Math.max(1, Math.min(59, Math.floor(intervalMinutes)))
  const expr = `*/${minutes} * * * *`
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
