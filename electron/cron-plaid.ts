/**
 * Daily Plaid sync cron + notification UX (Phase 4.6 — PR 6).
 *
 * Plaid is special-cased out of the per-integration cron mechanism in
 * `electron/cron.ts`. Two reasons:
 *
 *   1. The per-integration default of 15 minutes is wrong for Plaid —
 *      hitting `/transactions/sync` every 15 minutes wastes a daily Plaid
 *      transaction-update budget and provides zero new data (banks update
 *      transactions in bulk overnight). The contract in
 *      `docs/finance/plaid-integration.md` is daily at 06:00 local.
 *
 *   2. `syncAllPlaid()` is multi-Item and returns a structured result
 *      array. The cron module's `runSyncForService` returns void, so it
 *      can't surface aggregate counts to the notification helper without
 *      adding a branch that knows about Plaid-specific result shapes.
 *      Separating concerns keeps `cron.ts` shape-agnostic.
 *
 * The notification UX: after each daily run, fire ONE native notification
 * summarizing the result across all connected Items:
 *
 *   - 0 records updated AND no errors → silent (matches the existing
 *     per-service rule in `maybeSendNotification`).
 *   - >0 records updated → "N records updated" body.
 *   - Any Item errored → error body with the first message; the per-Item
 *     UI in the Integrations card surfaces the full list.
 */

import cron from 'node-cron'
import { syncAllPlaid } from './integrations/plaid/sync'
import { maybeSendNotification } from './ipc/sync'

/** Cron expression for the daily Plaid sync. Local time, not UTC. */
export const PLAID_DAILY_CRON = '0 6 * * *'

/**
 * Inner handler — exported for tests. Runs `syncAllPlaid()`, summarizes
 * the results, and fires (at most) one native notification.
 *
 * Errors thrown by `syncAllPlaid` itself are caught and turned into an
 * error notification; we never want the cron to crash the process.
 *
 * `syncAll` is parameterized so tests can substitute a mock without
 * exercising the real Plaid client.
 */
export async function runDailyPlaidSync(
  syncAll: () => Promise<
    Array<{
      itemId: string
      added: number
      modified: number
      removed: number
      errorCode?: string
      errorMessage?: string
    }>
  > = syncAllPlaid,
  notify: typeof maybeSendNotification = maybeSendNotification
): Promise<void> {
  try {
    const results = await syncAll()
    if (results.length === 0) return // nothing connected — quiet
    const totalRecords = results.reduce((n, r) => n + r.added + r.modified + r.removed, 0)
    const errored = results.filter((r) => r.errorMessage)
    if (errored.length > 0) {
      // Prefer ITEM_LOGIN_REQUIRED in the body when present — it's the one
      // a user actually needs to take action on.
      const reAuth = errored.find((r) => r.errorCode === 'ITEM_LOGIN_REQUIRED')
      const first = reAuth ?? errored[0]
      const msg =
        errored.length === 1
          ? (first.errorMessage ?? 'sync failed')
          : `${errored.length} institutions failed (${first.errorMessage ?? first.errorCode ?? 'unknown'})`
      notify('plaid', totalRecords, msg)
      return
    }
    notify('plaid', totalRecords)
  } catch (err) {
    notify('plaid', 0, err instanceof Error ? err.message : String(err))
  }
}

let task: cron.ScheduledTask | null = null

/**
 * Schedule the daily Plaid sync. Idempotent — replaces any prior task,
 * so calling this twice from `startCronJobs()` doesn't double-fire.
 */
export function schedulePlaidDailySync(): void {
  task?.stop()
  task = cron.schedule(PLAID_DAILY_CRON, () => {
    void runDailyPlaidSync()
  })
  task.start()
}

/**
 * Stop the Plaid daily task. Called from cron.ts `stopAllJobs()` so
 * `restartCronJobs()` doesn't leave the previous task firing alongside
 * the new one.
 */
export function stopPlaidDailySync(): void {
  task?.stop()
  task = null
}
