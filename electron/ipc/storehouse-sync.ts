/**
 * Storehouse live-sync bridge — projects LIVE-integration data into the `records`
 * timeline so People / Merchants / Places / Subscriptions / Timeline / Search light
 * up from synced data, not just manually-dropped files.
 *
 * This is the impure orchestration around the pure projectors in
 * `electron/lib/storehouse-projectors.ts`: read the domain table → project →
 * `insertRecords` (the same dedup + FTS path file imports use) → ONE
 * `refreshDerivedEntities` at the end (never per-row).
 *
 * `storehouse:backfill` runs it on demand for already-synced data. `afterFinanceSync`
 * is the post-sync hook the finance sync paths call so new data keeps flowing in.
 *
 * NB the AI/MCP boundary: per an explicit product decision, finance rows ARE allowed
 * into `records` (and thus readable by the assistant/MCP), so no exclusion flag is
 * applied here. If that reverts, gate the finance projector's output instead.
 */
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { calendarEvents, financeTransactions, gmailActions } from '../db/schema'
import { captureSnapshots } from '../integrations/finance-snapshot'
import { refreshDerivedEntities } from '../lib/entities-projection'
import {
  type CalendarRow,
  type FinanceTxnRow,
  type GmailRow,
  projectCalendar,
  projectFinanceTransactions,
  projectGmail
} from '../lib/storehouse-projectors'
import { insertRecords } from './records'

/** Read every finance transaction as a projector input row. */
function readFinanceTxns(): FinanceTxnRow[] {
  return getDb()
    .select({
      hash: financeTransactions.hash,
      date: financeTransactions.date,
      amount: financeTransactions.amount,
      currency: financeTransactions.currency,
      description: financeTransactions.description,
      category: financeTransactions.category
    })
    .from(financeTransactions)
    .all()
}

/** Read Gmail inbox rows as projector inputs (timestamp_ms → epoch ms). */
function readGmail(): GmailRow[] {
  return getDb()
    .select({
      threadId: gmailActions.threadId,
      subject: gmailActions.subject,
      fromAddress: gmailActions.fromAddress,
      snippet: gmailActions.snippet,
      receivedAt: gmailActions.receivedAt
    })
    .from(gmailActions)
    .all()
    .map((r) => ({ ...r, receivedAt: r.receivedAt ? r.receivedAt.getTime() : null }))
}

/** Read calendar events as projector inputs (timestamp_ms → epoch ms). */
function readCalendar(): CalendarRow[] {
  return getDb()
    .select({
      externalId: calendarEvents.externalId,
      title: calendarEvents.title,
      location: calendarEvents.location,
      startAt: calendarEvents.startAt
    })
    .from(calendarEvents)
    .all()
    .map((r) => ({ ...r, startAt: r.startAt ? r.startAt.getTime() : null }))
}

export interface BackfillResult {
  /** Records newly inserted this run (already-present rows dedupe to 0). */
  imported: number
  /** Derived entities in the cache after the post-projection rebuild. */
  entities: number
}

/**
 * Project all live-integration domain tables into `records`, then rebuild the
 * derived-entity cache ONCE. Idempotent — safe to run on every sync and on demand.
 * Covers finance + Gmail + Calendar; GitHub/Linear projectors slot in here next.
 * Per-source provenance tags keep the batch labels meaningful.
 */
export function projectAllToRecords(): BackfillResult {
  const now = Date.now()
  let imported = 0
  imported += insertRecords(
    projectFinanceTransactions(readFinanceTxns()),
    `live:finance:${now}`
  ).imported
  imported += insertRecords(projectGmail(readGmail()), `live:gmail:${now}`).imported
  imported += insertRecords(projectCalendar(readCalendar()), `live:gcal:${now}`).imported
  const { count } = refreshDerivedEntities(getDb())
  return { imported, entities: count }
}

/**
 * Post-sync hook for the finance sync paths (daily cron + manual "sync now" +
 * connect-time first sync). Fully defensive: NEVER throws, so a sync's success and
 * its notification UX never depend on projection succeeding, and it's safe to call
 * from unit-tested code paths where the DB may not be initialized (it no-ops).
 *
 * Order: capture balance snapshots first (so net worth + deltas reflect the freshly
 * synced balances), then project transactions into the spine.
 */
export function afterFinanceSync(): void {
  try {
    captureSnapshots(getRawSqlite())
  } catch (err) {
    console.warn('[storehouse-sync] snapshot capture failed (non-fatal):', err)
  }
  try {
    projectAllToRecords()
  } catch (err) {
    console.warn('[storehouse-sync] records projection failed (non-fatal):', err)
  }
}

/**
 * Post-sync hook for the Google sync path (Gmail/Calendar → People/Places). Same
 * defensive contract as `afterFinanceSync` but without the finance snapshot step.
 */
export function afterGoogleSync(): void {
  try {
    projectAllToRecords()
  } catch (err) {
    console.warn('[storehouse-sync] google projection failed (non-fatal):', err)
  }
}

export function registerStorehouseSyncHandlers(ipcMain: IpcMain): void {
  // One-time / on-demand projection of already-synced data into the spine.
  ipcMain.handle('storehouse:backfill', (): BackfillResult => projectAllToRecords())
}
