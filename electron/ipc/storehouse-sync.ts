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
import {
  calendarEvents,
  financeTransactions,
  githubItems,
  gmailActions,
  linearIssues,
  ouraDailyMetrics
} from '../db/schema'
import { captureSnapshots } from '../integrations/finance-snapshot'
import { refreshDerivedEntities } from '../lib/entities-projection'
import {
  type CalendarRow,
  type FinanceTxnRow,
  type GithubRow,
  type GmailRow,
  type LinearRow,
  type OuraRow,
  projectCalendar,
  projectFinanceTransactions,
  projectGithub,
  projectGmail,
  projectLinear,
  projectOuraMetrics
} from '../lib/storehouse-projectors'
import { insertRecords, upsertLiveRecords } from './records'

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

/** Read GitHub issues/PRs as projector inputs. */
function readGithub(): GithubRow[] {
  return getDb()
    .select({
      externalId: githubItems.externalId,
      type: githubItems.type,
      repo: githubItems.repo,
      title: githubItems.title,
      state: githubItems.state,
      author: githubItems.author,
      updatedAt: githubItems.updatedAt
    })
    .from(githubItems)
    .all()
}

/** Read Linear issues as projector inputs. */
function readLinear(): LinearRow[] {
  return getDb()
    .select({
      externalId: linearIssues.externalId,
      identifier: linearIssues.identifier,
      title: linearIssues.title,
      state: linearIssues.state,
      team: linearIssues.team,
      updatedAt: linearIssues.updatedAt
    })
    .from(linearIssues)
    .all()
}

/** Read Oura daily metrics as projector inputs. */
function readOura(): OuraRow[] {
  return getDb()
    .select({
      date: ouraDailyMetrics.date,
      sleepScore: ouraDailyMetrics.sleepScore,
      readinessScore: ouraDailyMetrics.readinessScore,
      activityScore: ouraDailyMetrics.activityScore,
      steps: ouraDailyMetrics.steps
    })
    .from(ouraDailyMetrics)
    .all()
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
 * Covers finance + Gmail + Calendar + GitHub + Linear + Oura. Per-source
 * provenance tags keep the batch labels meaningful.
 */
export function projectAllToRecords(): BackfillResult {
  const now = Date.now()
  let imported = 0
  // Finance uses the plain (occurredAt-inclusive) insert: a transaction's date is
  // IMMUTABLE, so its hash is stable and re-projection is already a no-op — and this
  // keeps the dedup hash identical to what v0.17.0 shipped, so an upgrade doesn't
  // duplicate the 394 finance records already on disk.
  imported += insertRecords(
    projectFinanceTransactions(readFinanceTxns()),
    `live:finance:${now}`
  ).imported
  // Gmail/Calendar/GitHub/Linear/Oura carry a MUTABLE occurredAt (received_at /
  // start / updated_at / the day's scores being revised), so they UPSERT on a
  // stable per-domain-row key (occurredAt excluded): a changed timestamp or a
  // rescored day re-projects in place instead of spamming a new timeline row.
  imported += upsertLiveRecords(projectGmail(readGmail()), `live:gmail:${now}`).imported
  imported += upsertLiveRecords(projectCalendar(readCalendar()), `live:gcal:${now}`).imported
  imported += upsertLiveRecords(projectGithub(readGithub()), `live:github:${now}`).imported
  imported += upsertLiveRecords(projectLinear(readLinear()), `live:linear:${now}`).imported
  imported += upsertLiveRecords(projectOuraMetrics(readOura()), `live:oura:${now}`).imported
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
 * Post-sync hook for the non-finance connectors (Google Gmail/Calendar, GitHub,
 * Linear) — projects the latest synced data into the spine. Same defensive contract
 * as `afterFinanceSync` (never throws) but without the finance snapshot step.
 */
export function afterConnectorSync(): void {
  try {
    projectAllToRecords()
  } catch (err) {
    console.warn('[storehouse-sync] connector projection failed (non-fatal):', err)
  }
}

export function registerStorehouseSyncHandlers(ipcMain: IpcMain): void {
  // One-time / on-demand projection of already-synced data into the spine.
  ipcMain.handle('storehouse:backfill', (): BackfillResult => projectAllToRecords())
}
