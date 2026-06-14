/**
 * Daily SimpleFIN sync cron + notification UX (Phase 4.7).
 *
 * Like Plaid, SimpleFIN is special-cased out of the per-integration interval
 * cron in `electron/cron.ts`:
 *
 *   1. SimpleFIN's data updates ~once/day and the bridge asks clients to make
 *      ≤24 requests/day. A 15-minute interval would burn that budget for zero
 *      new data. The contract is daily at 06:00 local.
 *
 *   2. There is no cursor — each run re-pulls the trailing 90-day window and
 *      relies on the `hash` UNIQUE constraint for idempotency (see
 *      integrations/simplefin/sync.ts). `syncAllSimplefin()` returns a
 *      structured result array the notification helper summarizes.
 *
 * Notification UX mirrors the Plaid cron: at most one native notification per
 * run — silent on 0 records + no errors, "N records updated" otherwise, error
 * body when any connection failed.
 */

import cron from 'node-cron'
import { syncAllSimplefin } from './integrations/simplefin/sync'
import { maybeSendNotification } from './ipc/sync'

/** Cron expression for the daily SimpleFIN sync. Local time, not UTC. */
export const SIMPLEFIN_DAILY_CRON = '0 6 * * *'

/**
 * Inner handler — exported for tests. Runs `syncAllSimplefin()`, summarizes the
 * results, and fires (at most) one native notification. Errors thrown by the
 * sync itself are caught and turned into an error notification so the cron
 * never crashes the process. `syncAll` is parameterized for tests.
 */
export async function runDailySimplefinSync(
  syncAll: () => Promise<
    Array<{ connectionId: string; added: number; duplicates: number; errorMessage?: string }>
  > = syncAllSimplefin,
  notify: typeof maybeSendNotification = maybeSendNotification
): Promise<void> {
  try {
    const results = await syncAll()
    if (results.length === 0) return // nothing connected — quiet
    const totalRecords = results.reduce((n, r) => n + r.added, 0)
    const errored = results.filter((r) => r.errorMessage)
    if (errored.length > 0) {
      const first = errored[0]
      const msg =
        errored.length === 1
          ? (first.errorMessage ?? 'sync failed')
          : `${errored.length} connections failed (${first.errorMessage ?? 'unknown'})`
      notify('simplefin', totalRecords, msg)
      return
    }
    notify('simplefin', totalRecords)
  } catch (err) {
    notify('simplefin', 0, err instanceof Error ? err.message : String(err))
  }
}

let task: cron.ScheduledTask | null = null

/**
 * Schedule the daily SimpleFIN sync. Idempotent — replaces any prior task so
 * calling this twice from `startCronJobs()` doesn't double-fire.
 */
export function scheduleSimplefinDailySync(): void {
  task?.stop()
  task = cron.schedule(SIMPLEFIN_DAILY_CRON, () => {
    void runDailySimplefinSync()
  })
  task.start()
}

/** Stop the SimpleFIN daily task. Called from cron.ts `stopAllJobs()`. */
export function stopSimplefinDailySync(): void {
  task?.stop()
  task = null
}
