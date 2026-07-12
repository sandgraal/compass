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
 * is the post-sync hook the finance sync paths call so new data keeps flowing in;
 * `afterDomainWrite` is the debounced equivalent for user-edited domains (habits,
 * tasks, goals, travel, comps).
 *
 * NB the AI/MCP boundary: per the data-access policy (docs/data-access-policy.md),
 * EVERY domain row flows into `records` (and is thus readable by the assistant/MCP)
 * in full detail. The one exclusion is raw GPS coordinates (`location_points`),
 * which never enter the spine.
 */
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import {
  argylePaystubs,
  calendarEvents,
  checklistItems,
  financeTransactions,
  financialGoals,
  githubItems,
  gmailActions,
  habitEntries,
  habits,
  linearIssues,
  medicalRecords,
  ouraDailyMetrics,
  rentalComps,
  snapshotFacts,
  travelSegments,
  utilityBills
} from '../db/schema'
import { captureSnapshots } from '../integrations/finance-snapshot'
import { refreshDerivedEntities } from '../lib/entities-projection'
import { type SqliteForOneShot, runOnceGated } from '../lib/one-shot-repair'
import { type RecordInput, hashRecord } from '../lib/recognizers'
import {
  type CalendarRow,
  type FinanceTxnRow,
  type FinancialGoalRow,
  type GithubRow,
  type GmailRow,
  type HabitCheckRow,
  type LinearRow,
  type MedicalRow,
  type OuraRow,
  type PaystubRow,
  type RentalCompRow,
  type SnapshotFactRow,
  type TaskRow,
  type TravelSegmentRow,
  type UtilityBillRow,
  projectCalendar,
  projectFinanceTransactions,
  projectFinancialGoals,
  projectGithub,
  projectGmail,
  projectHabitChecks,
  projectLinear,
  projectMedicalRecords,
  projectOuraMetrics,
  projectPaystubs,
  projectRentalComps,
  projectSnapshotFacts,
  projectTasks,
  projectTravelSegments,
  projectUtilityBills
} from '../lib/storehouse-projectors'
import { enrichContactsFromCache } from './contact-enrich'
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

/** Read COMPLETED habit checks (⋈ habits for the display name) as projector inputs. */
function readHabitChecks(): HabitCheckRow[] {
  return getDb()
    .select({
      habitId: habitEntries.habitId,
      habitName: habits.name,
      date: habitEntries.date,
      source: habitEntries.source
    })
    .from(habitEntries)
    .innerJoin(habits, eq(habitEntries.habitId, habits.id))
    .where(eq(habitEntries.completed, true))
    .all()
    .map((r) => ({ ...r, habitId: r.habitId ?? 0 }))
}

/** Read checklist items as projector inputs. */
function readTasks(): TaskRow[] {
  return getDb()
    .select({
      id: checklistItems.id,
      listType: checklistItems.listType,
      listDate: checklistItems.listDate,
      title: checklistItems.title,
      body: checklistItems.body,
      status: checklistItems.status,
      checked: checklistItems.checked,
      category: checklistItems.category
    })
    .from(checklistItems)
    .all()
}

/** Read clinical records as projector inputs. */
function readMedicalRecords(): MedicalRow[] {
  return getDb()
    .select({
      externalId: medicalRecords.externalId,
      category: medicalRecords.category,
      description: medicalRecords.description,
      code: medicalRecords.code,
      status: medicalRecords.status,
      recordedAt: medicalRecords.recordedAt
    })
    .from(medicalRecords)
    .all()
}

/** Read logged trips as projector inputs. */
function readTravelSegments(): TravelSegmentRow[] {
  return getDb()
    .select({
      id: travelSegments.id,
      country: travelSegments.country,
      startDate: travelSegments.startDate,
      endDate: travelSegments.endDate,
      notes: travelSegments.notes
    })
    .from(travelSegments)
    .all()
}

/** Read paystubs as projector inputs. */
function readPaystubs(): PaystubRow[] {
  return getDb()
    .select({
      externalId: argylePaystubs.externalId,
      employer: argylePaystubs.employer,
      grossPay: argylePaystubs.grossPay,
      netPay: argylePaystubs.netPay,
      currency: argylePaystubs.currency,
      periodStart: argylePaystubs.periodStart,
      periodEnd: argylePaystubs.periodEnd,
      paidAt: argylePaystubs.paidAt
    })
    .from(argylePaystubs)
    .all()
}

/** Read utility statements as projector inputs. */
function readUtilityBills(): UtilityBillRow[] {
  return getDb()
    .select({
      externalId: utilityBills.externalId,
      provider: utilityBills.provider,
      serviceAddress: utilityBills.serviceAddress,
      statementDate: utilityBills.statementDate,
      amount: utilityBills.amount,
      currency: utilityBills.currency
    })
    .from(utilityBills)
    .all()
}

/** Read savings goals as projector inputs (timestamp_ms → epoch ms). */
function readFinancialGoals(): FinancialGoalRow[] {
  return getDb()
    .select({
      id: financialGoals.id,
      name: financialGoals.name,
      category: financialGoals.category,
      targetAmount: financialGoals.targetAmount,
      targetDate: financialGoals.targetDate,
      createdAt: financialGoals.createdAt
    })
    .from(financialGoals)
    .all()
    .map((r) => ({ ...r, createdAt: r.createdAt ? r.createdAt.getTime() : null }))
}

/** Read rental comps as projector inputs (timestamp_ms → epoch ms). */
function readRentalComps(): RentalCompRow[] {
  return getDb()
    .select({
      id: rentalComps.id,
      name: rentalComps.name,
      zone: rentalComps.zone,
      bedrooms: rentalComps.bedrooms,
      nightlyUsd: rentalComps.nightlyUsd,
      savedAt: rentalComps.savedAt,
      createdAt: rentalComps.createdAt
    })
    .from(rentalComps)
    .all()
    .map((r) => ({ ...r, createdAt: r.createdAt ? r.createdAt.getTime() : null }))
}

/** Read snapshot facts as projector inputs. */
function readSnapshotFacts(): SnapshotFactRow[] {
  return getDb()
    .select({
      source: snapshotFacts.source,
      category: snapshotFacts.category,
      label: snapshotFacts.label,
      value: snapshotFacts.value,
      dedupHash: snapshotFacts.dedupHash
    })
    .from(snapshotFacts)
    .all()
}

export interface BackfillResult {
  /** Records newly inserted this run (already-present rows dedupe to 0). */
  imported: number
  /** Derived entities in the cache after the post-projection rebuild. */
  entities: number
}

/**
 * Delete spine rows for `source` whose backing domain row no longer produces a
 * projection (an unchecked habit, a deleted task/trip/goal/comp, a re-categorized
 * medical record). Without this, toggling a habit off would leave a ghost on the
 * timeline forever. Set-differenced in memory against the just-projected inputs
 * (same stable hash `upsertLiveRecords` uses — occurredAt excluded); the
 * `records_ad` FTS trigger keeps the search index in sync. Only called for
 * sources whose domain rows are delete-capable — aggregator streams
 * (paystub/utility) and immutable facts never shrink, so they skip it.
 */
function reconcileLiveRecords(source: string, inputs: RecordInput[]): number {
  const sqlite = getRawSqlite()
  const valid = new Set(inputs.map((inp) => hashRecord(inp.source, inp.type, null, inp.naturalKey)))
  const existing = sqlite
    .prepare('SELECT id, dedup_hash AS hash FROM records WHERE source = ?')
    .all(source) as Array<{ id: number; hash: string }>
  const stale = existing.filter((r) => !valid.has(r.hash)).map((r) => r.id)
  if (stale.length === 0) return 0
  const del = sqlite.prepare('DELETE FROM records WHERE id = ?')
  const delMany = sqlite.transaction((ids: number[]) => {
    for (const id of ids) del.run(id)
  })
  delMany(stale)
  return stale.length
}

/**
 * Project the user-edited domain tables (habits, tasks, medical, travel, goals,
 * comps, paystubs, utility bills, snapshot facts) into `records`. Does NOT touch
 * connector-sourced tables (finance/gmail/gcal/github/linear/oura). Idempotent.
 */
function projectUserEditedDomainsToRecords(): number {
  const now = Date.now()
  let imported = 0
  // Spine-expansion domains (data-access policy): same mutable-row upsert, plus a
  // reconcile-delete for the delete-capable ones so unchecked/removed rows leave
  // the timeline. DEDUP KEYS ARE FROZEN — changing a source/type/naturalKey here
  // duplicates every already-projected row on the next run.
  const habitInputs = projectHabitChecks(readHabitChecks())
  imported += upsertLiveRecords(habitInputs, `live:habit:${now}`).imported
  reconcileLiveRecords('habit', habitInputs)
  const taskInputs = projectTasks(readTasks())
  imported += upsertLiveRecords(taskInputs, `live:task:${now}`).imported
  reconcileLiveRecords('task', taskInputs)
  const medicalInputs = projectMedicalRecords(readMedicalRecords())
  imported += upsertLiveRecords(medicalInputs, `live:medical:${now}`).imported
  reconcileLiveRecords('medical', medicalInputs)
  const travelInputs = projectTravelSegments(readTravelSegments())
  imported += upsertLiveRecords(travelInputs, `live:travel:${now}`).imported
  reconcileLiveRecords('travel', travelInputs)
  const goalInputs = projectFinancialGoals(readFinancialGoals())
  imported += upsertLiveRecords(goalInputs, `live:goal:${now}`).imported
  reconcileLiveRecords('goal', goalInputs)
  const compInputs = projectRentalComps(readRentalComps())
  imported += upsertLiveRecords(compInputs, `live:rental-comp:${now}`).imported
  reconcileLiveRecords('rental-comp', compInputs)
  // Aggregator streams: rows never get deleted locally, so upsert-only.
  imported += upsertLiveRecords(projectPaystubs(readPaystubs()), `live:paystub:${now}`).imported
  imported += upsertLiveRecords(
    projectUtilityBills(readUtilityBills()),
    `live:utility:${now}`
  ).imported
  // Snapshot facts are immutable (content-addressed) — plain dedup insert.
  imported += insertRecords(projectSnapshotFacts(readSnapshotFacts()), `facts:${now}`).imported
  return imported
}

/**
 * Project every domain table into `records` (no entity refresh). Idempotent —
 * safe to run on every sync and on demand. Includes both connector sources
 * (finance/gmail/gcal/github/linear/oura) and user-edited domains.
 */
function projectDomainsToRecords(): number {
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
  imported += projectUserEditedDomainsToRecords()
  return imported
}

/**
 * Project all domain tables into `records`, then rebuild the derived-entity
 * cache ONCE. Idempotent — safe to run on every sync and on demand.
 */
export function projectAllToRecords(): BackfillResult {
  const imported = projectDomainsToRecords()
  const { count } = refreshDerivedEntities(getDb())
  return { imported, entities: count }
}

/**
 * Debounced post-write hook for the user-edited domains that now live on the
 * spine (habits, tasks, goals, travel segments, rental comps). Call it after
 * any write handler mutates one of those tables; 3 s later (resetting on each
 * new write) only the user-edited domain projection re-runs (connector sources
 * such as finance/gmail/gcal/github/linear/oura are intentionally skipped to
 * keep routine habit/task churn cheap), so a burst of habit toggles costs one
 * projection, not ten. Same never-throws contract as `afterConnectorSync`.
 * Pass `{ entities: true }` when the write can change derived entities (e.g.
 * travel → Places); routine habit/task churn skips the entity rebuild.
 */
let domainWriteTimer: ReturnType<typeof setTimeout> | null = null
let domainWriteWantsEntities = false
export function afterDomainWrite(opts?: { entities?: boolean }): void {
  if (opts?.entities) domainWriteWantsEntities = true
  if (domainWriteTimer) clearTimeout(domainWriteTimer)
  domainWriteTimer = setTimeout(() => {
    domainWriteTimer = null
    const wantEntities = domainWriteWantsEntities
    domainWriteWantsEntities = false
    try {
      projectUserEditedDomainsToRecords()
      if (wantEntities) refreshDerivedEntities(getDb())
    } catch (err) {
      console.warn('[storehouse-sync] domain-write projection failed (non-fatal):', err)
    }
  }, 3000)
  domainWriteTimer.unref?.()
}

export const SPINE_EXPANSION_BACKFILL_KEY = 'spineExpansionBackfillV1'

/**
 * One-time startup backfill for the 2026-07 spine expansion: project the
 * domains that predate their projectors (habits, tasks, medical, travel,
 * paystubs, utility bills, goals, comps, facts) onto the `records` spine.
 * Syncs and `afterDomainWrite` keep the spine fresh afterward — the gate just
 * avoids paying a full projection on every launch.
 */
export function runSpineExpansionBackfillIfNeeded(
  sqlite: SqliteForOneShot,
  now: number = Date.now()
): { ran: boolean; imported?: number } {
  return runOnceGated(sqlite, SPINE_EXPANSION_BACKFILL_KEY, () => projectAllToRecords(), now)
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
  // Cheap cross-source contact enrichment: a name-join over the derived-entity
  // cache we just rebuilt (no FTS, no network) so every contact's "seen across N
  // sources" summary stays fresh after each sync. Its own try/catch inside means
  // this never throws.
  enrichContactsFromCache()
}

export function registerStorehouseSyncHandlers(ipcMain: IpcMain): void {
  // One-time / on-demand projection of already-synced data into the spine.
  ipcMain.handle('storehouse:backfill', (): BackfillResult => projectAllToRecords())
}
