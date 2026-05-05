import cron from 'node-cron'
import { BrowserWindow } from 'electron'
import { syncGoogle, syncGitHub } from './ipc/sync'
import { getDb } from './db/client'
import { appSettings } from './db/schema'
import { eq } from 'drizzle-orm'

let scheduledTask: cron.ScheduledTask | null = null

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function getSyncIntervalMinutes(): number {
  try {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, 'syncInterval')).get()
    return parseInt(row?.value || '15', 10)
  } catch {
    return 15
  }
}

export function startCronJobs(): void {
  // Default: sync every 15 minutes
  scheduledTask = cron.schedule('*/15 * * * *', async () => {
    const win = getMainWindow()
    await Promise.all([syncGoogle(win), syncGitHub(win)])
  })

  scheduledTask.start()
}

export function restartCronJobs(): void {
  if (scheduledTask) {
    scheduledTask.stop()
  }
  const interval = getSyncIntervalMinutes()
  scheduledTask = cron.schedule(`*/${interval} * * * *`, async () => {
    const win = getMainWindow()
    await Promise.all([syncGoogle(win), syncGitHub(win)])
  })
  scheduledTask.start()
}
