import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import cron from 'node-cron'
import { getDb } from './db/client'
import { appSettings } from './db/schema'
import { syncGitHub, syncGoogle } from './ipc/sync'

let scheduledTask: cron.ScheduledTask | null = null

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function getSyncIntervalMinutes(): number {
  try {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, 'syncInterval')).get()
    return Number.parseInt(row?.value || '15', 10)
  } catch {
    return 15
  }
}

export function startCronJobs(): void {
  const interval = getSyncIntervalMinutes()
  if (interval <= 0) {
    // "Manual only" — don't schedule anything
    scheduledTask = null
    return
  }
  scheduledTask = cron.schedule(`*/${interval} * * * *`, async () => {
    const win = getMainWindow()
    await Promise.all([syncGoogle(win), syncGitHub(win)])
  })
  scheduledTask.start()
}

export function restartCronJobs(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
  const interval = getSyncIntervalMinutes()
  if (interval <= 0) {
    // "Manual only" — don't reschedule
    return
  }
  scheduledTask = cron.schedule(`*/${interval} * * * *`, async () => {
    const win = getMainWindow()
    await Promise.all([syncGoogle(win), syncGitHub(win)])
  })
  scheduledTask.start()
}
