/**
 * SimpleFIN date-windowed sync (Phase 4.7).
 *
 * The SimpleFIN counterpart to `plaid/sync.ts`, but simpler — there is no
 * cursor and no `/transactions/sync` delta. Each run GETs `<accessUrl>/accounts`
 * for a trailing date window (a wide backfill on first connect, a lighter
 * overlap after — see step 3), upserts the account rows, normalizes every
 * transaction to Compass's shared `RawTxn` shape, runs the same categorize /
 * geo / tax pipeline the CSV + Plaid paths use, and inserts with
 * `ON CONFLICT DO NOTHING`.
 *
 * IDEMPOTENCY: there is no resume state. Re-pulling an overlapping window every
 * day is safe **entirely** because the `hash` UNIQUE constraint on
 * finance_transactions makes a re-seen row a no-op (counted as a duplicate).
 * This is the whole story — the sync test runs twice and asserts the second
 * run inserts zero.
 *
 * Invariants mirrored from the Plaid path:
 *   - The Access URL comes from the vault (`getAccessUrl`), never a function
 *     argument — a misbehaving renderer must not be able to pass credentials.
 *   - `sync_events.integration_id` is a FK to `integrations.id` (NOT
 *     `simplefin_connections.id`); passing the connection PK would corrupt the
 *     Sync Log UI.
 *
 * Account classification: SimpleFIN's base `/accounts` payload has no
 * standardized account-type field, so on first link we classify by name + org
 * keywords (see classify.ts) — a card/loan becomes a credit/liability so an
 * Amex doesn't sit on the asset side of net-worth. Balances are refreshed every
 * sync (debt balances stored positive = owed), but `name` / `type` /
 * `assetClass` / `isDebt` are set only on first insert so a user's later
 * re-classification in the Accounts UI is never clobbered.
 *
 * Historical backfill (`backfillSimplefinHistory`, below `syncSimplefin`) is a
 * separate, user-triggered, one-time action that walks further back than the
 * recurring sync ever does. It shares the account-upsert/normalize/categorize/
 * insert logic via `ingestSimplefinResponse` but owns its own date-window walk
 * and its own persisted progress (`historyOldestDate` / `historyBackfillStatus`
 * on the connection row) — it never touches `lastSyncedAt`, which is reserved
 * for the recurring sync's first-vs-incremental window choice.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  categorizationRules,
  financeAccounts,
  financeTransactions,
  integrations,
  simplefinConnections,
  syncEvents
} from '../../db/schema'
import { normalizeMerchant } from '../../lib/normalize'
import { type RawTxn, categorize } from '../finance'
import { applyAtmSplit } from '../finance-atm-split'
import { reconcileTransactionCurrency } from '../finance-currency'
import { tagGeoAndPurpose } from '../finance-geo'
import { tagTax } from '../finance-tax'
import { classifySimplefinAccount } from './classify'
import { type SimplefinAccountsResponse, fetchAccounts } from './client'
import {
  SIMPLEFIN_BACKFILL_MAX_WINDOWS,
  SIMPLEFIN_BACKFILL_REQUEST_DELAY_MS,
  SIMPLEFIN_BACKFILL_WINDOW_DAYS,
  SIMPLEFIN_INCREMENTAL_LOOKBACK_DAYS,
  SIMPLEFIN_LOOKBACK_DAYS
} from './config'
import { findAccountMatch } from './match'
import { normalizeSimplefinAccount } from './normalize'
import { getAccessUrl } from './vault'

/**
 * Outcome of a single-connection sync. Returned (not thrown) for non-fatal
 * conditions so callers can summarize across multiple connections without
 * losing partial successes.
 */
export type SimplefinSyncResult = {
  connectionId: string
  added: number
  duplicates: number
  /** New finance_accounts rows created for SimpleFIN accounts. */
  accountsUpserted: number
  /** Existing unlinked accounts adopted via institution+last-4 match (#1). */
  accountsLinked: number
  errorMessage?: string
}

/** A function that returns the `/accounts` payload for a date window. Injected
 *  by tests; production builds it from the vault Access URL. */
type FetchAccountsFn = (opts: {
  startDate: number
  endDate: number
  pending?: boolean
}) => Promise<SimplefinAccountsResponse>

type CategorizationRuleRow = {
  pattern: string
  category: string
  subcategory: string | null
}

/**
 * Result of ingesting one `/accounts` response (one date window) into the DB.
 * Shared by `syncSimplefin` (one window) and `backfillSimplefinHistory` (many
 * windows, one call per window).
 */
type IngestResult = {
  added: number
  duplicates: number
  accountsUpserted: number
  accountsLinked: number
  errors: Array<{ transactionId: string; message: string }>
  /** Total transactions present in the raw response, pre-dedup — used by the
   *  backfill loop to detect "this window had nothing" vs. "everything in it
   *  was already a duplicate". */
  txnCountInWindow: number
}

/**
 * Upsert accounts, normalize + categorize + tag every transaction, and insert
 * with `ON CONFLICT DO NOTHING`. Pure ingestion: does NOT write `sync_events`,
 * does NOT touch `simplefin_connections` / `integrations`, and does NOT run
 * the ATM-split / currency-reconcile passes — callers own those so a
 * multi-window caller (the backfill loop) can batch them once instead of per
 * window.
 */
function ingestSimplefinResponse(
  db: ReturnType<typeof getDb>,
  connRowId: number,
  response: SimplefinAccountsResponse,
  rules: CategorizationRuleRow[]
): IngestResult {
  // Upsert accounts + build the account-name lookup. Balance is refreshed
  // every call; name/type/assetClass are classified on first insert only, so
  // a user's later re-classification in the Accounts UI is never clobbered.
  // For DEBT accounts the stored balance is the positive amount owed (schema
  // convention; see finance-snapshot.ts), so we store |balance|.
  const nameMap = new Map<string, string>()
  // simplefinAccountId → finance_accounts.id, so the transactions below can be
  // linked to their account (per-account views + account-scoped dedup).
  const idMap = new Map<string, number>()
  let accountsUpserted = 0
  let accountsLinked = 0
  for (const acct of response.accounts) {
    const orgName = acct.org?.name ?? ''
    const balanceNum = Number.parseFloat(acct.balance)
    const balance = Number.isFinite(balanceNum) ? balanceNum : 0
    const displayName =
      (acct.name ?? '').trim() || `${orgName || 'SimpleFIN'} ·${acct.id.slice(-4)}`
    const existing = db
      .select({
        id: financeAccounts.id,
        name: financeAccounts.name,
        isDebt: financeAccounts.isDebt
      })
      .from(financeAccounts)
      .where(eq(financeAccounts.simplefinAccountId, acct.id))
      .get()
    if (existing) {
      // Respect the account's current debt classification (which the user may
      // have changed) when deciding the balance sign.
      const storedBalance = existing.isDebt ? Math.abs(balance) : balance
      db.update(financeAccounts)
        .set({
          balance: storedBalance,
          institution: orgName,
          simplefinConnectionId: connRowId,
          updatedAt: new Date()
        })
        .where(eq(financeAccounts.id, existing.id))
        .run()
      nameMap.set(acct.id, existing.name)
      idMap.set(acct.id, existing.id)
      continue
    }
    // No prior SimpleFIN link. Before creating a (likely duplicate) row, try to
    // ADOPT an existing UNLINKED account that matches by institution + last-4.
    const candidates = db
      .select({
        id: financeAccounts.id,
        name: financeAccounts.name,
        institution: financeAccounts.institution,
        mask: financeAccounts.mask
      })
      .from(financeAccounts)
      .where(
        and(
          isNull(financeAccounts.simplefinAccountId),
          isNull(financeAccounts.simplefinConnectionId),
          isNull(financeAccounts.plaidItemId)
        )
      )
      .all()
    const matchId = findAccountMatch({ name: displayName, orgName }, candidates)
    if (matchId !== null) {
      // Adopt it: attach the SimpleFIN linkage + refresh balance, but KEEP the
      // user's existing name / type / assetClass / isDebt.
      const cur = db
        .select({ name: financeAccounts.name, isDebt: financeAccounts.isDebt })
        .from(financeAccounts)
        .where(eq(financeAccounts.id, matchId))
        .get()
      db.update(financeAccounts)
        .set({
          simplefinAccountId: acct.id,
          simplefinConnectionId: connRowId,
          balance: cur?.isDebt ? Math.abs(balance) : balance,
          updatedAt: new Date()
        })
        .where(eq(financeAccounts.id, matchId))
        .run()
      accountsLinked++
      nameMap.set(acct.id, cur?.name ?? displayName)
      idMap.set(acct.id, matchId)
      continue
    }
    // No confident match — create a new account.
    const cls = classifySimplefinAccount(displayName, orgName)
    const res = db
      .insert(financeAccounts)
      .values({
        name: displayName,
        type: cls.type,
        isDebt: cls.isDebt,
        institution: orgName,
        assetClass: cls.assetClass,
        balance: cls.isDebt ? Math.abs(balance) : balance,
        simplefinConnectionId: connRowId,
        simplefinAccountId: acct.id
      })
      .run()
    accountsUpserted++
    nameMap.set(acct.id, displayName)
    idMap.set(acct.id, Number(res.lastInsertRowid))
  }
  const accountNameFor = (id: string): string => nameMap.get(id) ?? `SimpleFIN ·${id.slice(-4)}`

  // Normalize every account's transactions to RawTxn, remembering which
  // finance_accounts.id each one belongs to (parallel to allRaw, preserved
  // through the order-stable categorize/tag pipeline below).
  const allRaw: RawTxn[] = []
  const rawAccountIds: Array<number | null> = []
  const allErrors: Array<{ transactionId: string; message: string }> = []
  for (const acct of response.accounts) {
    const accountId = idMap.get(acct.id) ?? null
    const { ok, errors } = normalizeSimplefinAccount(acct, accountNameFor)
    for (const r of ok) {
      allRaw.push(r)
      rawAccountIds.push(accountId)
    }
    allErrors.push(...errors)
  }

  // Categorize + geo/tax tag. `rules` is read once per sync/backfill call by
  // the caller, not once per window.
  const tagged = tagTax(tagGeoAndPurpose(categorize(allRaw, rules)))

  // Insert. The hash UNIQUE constraint is the entire idempotency guard. The
  // loop pairs tagged[i] with rawAccountIds[i] by index, which assumes the
  // categorize/geo/tax pipeline preserves order AND length. Assert it so a
  // future filtering/reordering change fails fast here instead of silently
  // mis-linking transactions to the wrong account.
  if (tagged.length !== rawAccountIds.length) {
    throw new Error(
      `SimpleFIN sync: tag pipeline changed row count (${tagged.length} tagged vs ${rawAccountIds.length} account ids) — account linkage would be wrong`
    )
  }
  let added = 0
  let duplicates = 0
  for (let i = 0; i < tagged.length; i++) {
    const t = tagged[i]
    const res = db
      .insert(financeTransactions)
      .values({
        hash: t.hash,
        date: t.date,
        amount: t.amount,
        description: t.description,
        accountId: rawAccountIds[i],
        category: t.category ?? 'Uncategorized',
        subcategory: t.subcategory,
        notes: t.notes,
        geo: t.geo ?? 'US',
        purpose: t.purpose ?? null,
        taxTag: t.taxTag ?? 'tax:none',
        taxTagSource: 'auto',
        taxYear: t.taxYear ?? null,
        normalizedMerchant: normalizeMerchant(t.description),
        sourceFile: t.sourceFile,
        ingestedAt: new Date()
      })
      .onConflictDoNothing()
      .run()
    if (res.changes === 1) added++
    else duplicates++
  }

  return {
    added,
    duplicates,
    accountsUpserted,
    accountsLinked,
    errors: allErrors,
    txnCountInWindow: allRaw.length
  }
}

/**
 * Sync one SimpleFIN connection end-to-end. Upserts accounts, ingests the
 * windowed transactions, and writes one `sync_events` row.
 *
 * `fetchAccountsFn` / `now` are exposed for tests; production callers omit them
 * and we build the real fetcher from the vault Access URL.
 */
export async function syncSimplefin(
  connectionId: string,
  opts?: { fetchAccountsFn?: FetchAccountsFn; now?: Date }
): Promise<SimplefinSyncResult> {
  const db = getDb()
  const base = { connectionId, added: 0, duplicates: 0, accountsUpserted: 0, accountsLinked: 0 }

  // 1. Connection row (its PK is the FK we stamp onto finance_accounts;
  //    lastSyncedAt picks the first-sync-vs-incremental window below).
  const conn = db
    .select({ id: simplefinConnections.id, lastSyncedAt: simplefinConnections.lastSyncedAt })
    .from(simplefinConnections)
    .where(eq(simplefinConnections.connectionId, connectionId))
    .get()
  if (!conn) {
    return {
      ...base,
      errorMessage: `No simplefin_connections row for connectionId=${connectionId}`
    }
  }

  // 2. Build the fetcher (mock or real). Access URL always from the vault.
  let fetchAccountsFn: FetchAccountsFn
  if (opts?.fetchAccountsFn) {
    fetchAccountsFn = opts.fetchAccountsFn
  } else {
    const accessUrl = getAccessUrl(connectionId)
    if (!accessUrl) {
      return {
        ...base,
        errorMessage:
          'No SimpleFIN access URL in vault — re-claim a Setup Token from the Integrations page.'
      }
    }
    fetchAccountsFn = (o) => fetchAccounts(accessUrl, o)
  }

  // 3. Date window: a wide backfill on first connect, a lighter overlap after.
  //    The narrower incremental window stays under institutions' recommended
  //    range (avoiding the "exceeds 45 days" warning) and is cheaper; dedup
  //    makes the overlap a no-op.
  const lookbackDays = conn.lastSyncedAt
    ? SIMPLEFIN_INCREMENTAL_LOOKBACK_DAYS
    : SIMPLEFIN_LOOKBACK_DAYS
  const now = opts?.now ?? new Date()
  const endDate = Math.floor(now.getTime() / 1000)
  const startDate = endDate - lookbackDays * 86_400

  // integrations.id for sync_events — looked up once. May be null if the
  // connection was created before the integrations row (it isn't, in practice;
  // the claim handler creates the row), in which case sync_events stores null.
  const integrationsRow = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, 'simplefin'))
    .get()
  const integrationId = integrationsRow?.id ?? null

  // 4. Fetch. A transport failure is recorded on the connection row + a
  //    sync_events row, then returned (not thrown) so syncAll keeps going.
  let response: SimplefinAccountsResponse
  try {
    response = await fetchAccountsFn({ startDate, endDate })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.update(simplefinConnections)
      .set({ errorCode: message.slice(0, 200) })
      .where(eq(simplefinConnections.connectionId, connectionId))
      .run()
    writeSyncEvent(integrationId, 0, message)
    return { ...base, errorMessage: message }
  }

  // 5-8. Upsert accounts, normalize, categorize/tag, insert (shared with the
  //      backfill loop below).
  const rules = readCategorizationRules(db)
  const ingest = ingestSimplefinResponse(db, conn.id, response, rules)

  // 9. ATM split + currency reconcile (only if we added rows), mirroring the
  //    Plaid + CSV paths.
  if (ingest.added > 0) {
    applyAtmSplit(db)
    reconcileTransactionCurrency(db)
  }

  // 10. Record outcome. SimpleFIN's top-level `errors[]` mixes genuine failures
  //     with non-fatal warnings (e.g. USAA's "exceeds recommended range of 45
  //     days"). The reliable signal of a real failure is "no accounts came
  //     back" — if we DID get data, the sync succeeded and any errors[] are
  //     warnings: log them to the Sync Log, but DON'T flag the connection red /
  //     flip the integration to 'error' (that's the "needs attention" UI). Only
  //     an empty-accounts response with errors is a hard failure that should
  //     surface as an error + drive the cron's "failed" notification.
  const messages = response.errors
  const hardFailure = response.accounts.length === 0 && messages.length > 0
  const connError = hardFailure ? messages.join('; ').slice(0, 200) : null
  db.update(simplefinConnections)
    .set({ lastSyncedAt: new Date(), errorCode: connError })
    .where(eq(simplefinConnections.connectionId, connectionId))
    .run()
  db.update(integrations)
    .set({
      lastSyncedAt: new Date(),
      status: hardFailure ? 'error' : 'connected',
      errorMessage: connError
    })
    .where(eq(integrations.service, 'simplefin'))
    .run()
  // Warnings + per-row normalize errors go to the Sync Log (visible, not
  // alarming); a hard failure's messages are already on the connection row.
  const eventLog = [
    ...(hardFailure ? messages : messages.map((m) => `warning: ${m}`)),
    ...ingest.errors.map((e) => `${e.transactionId}: ${e.message}`)
  ]
  writeSyncEvent(integrationId, ingest.added, eventLog.length > 0 ? JSON.stringify(eventLog) : null)

  return {
    connectionId,
    added: ingest.added,
    duplicates: ingest.duplicates,
    accountsUpserted: ingest.accountsUpserted,
    accountsLinked: ingest.accountsLinked,
    errorMessage: connError ?? undefined
  }
}

/**
 * Sync every connected SimpleFIN connection. Used by the daily cron and the
 * Integrations "Sync all" path. An error on one connection doesn't abort the
 * loop. (`opts` is for tests; production passes none so each connection reads
 * its own vault Access URL.)
 */
export async function syncAllSimplefin(opts?: {
  fetchAccountsFn?: FetchAccountsFn
  now?: Date
}): Promise<SimplefinSyncResult[]> {
  const db = getDb()
  const conns = db
    .select({ connectionId: simplefinConnections.connectionId })
    .from(simplefinConnections)
    .all()
  const results: SimplefinSyncResult[] = []
  for (const c of conns) {
    results.push(await syncSimplefin(c.connectionId, opts))
  }
  return results
}

/**
 * Outcome of a historical backfill run. Returned (not thrown) for non-fatal
 * conditions, matching `SimplefinSyncResult`'s convention.
 */
export type SimplefinBackfillResult = {
  connectionId: string
  windowsFetched: number
  added: number
  duplicates: number
  /** Oldest ISO date ('YYYY-MM-DD') successfully covered, across this run AND
   *  any prior run (since a run resumes from the prior `historyOldestDate`). */
  oldestDateReached: string | null
  /** 'complete' = two consecutive windows added nothing new, assume history
   *  is exhausted (non-fatal warnings in that window don't prevent this).
   *  'partial' = hit the safety cap; a later run resumes further back.
   *  'error' = a fetch failure stopped the loop before either of the above. */
  status: 'complete' | 'partial' | 'error'
  errorMessage?: string
}

function toIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

function fromIsoDate(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000)
}

function readCategorizationRules(db: ReturnType<typeof getDb>): CategorizationRuleRow[] {
  return db
    .select({
      pattern: categorizationRules.pattern,
      category: categorizationRules.category,
      subcategory: categorizationRules.subcategory
    })
    .from(categorizationRules)
    .orderBy(categorizationRules.priority)
    .all()
}

/**
 * Walk backward from `historyOldestDate` (or now, on a first run) in
 * `SIMPLEFIN_BACKFILL_WINDOW_DAYS`-wide windows, ingesting each one, until
 * either two consecutive windows come back empty (assume the institution's
 * history is exhausted), a fetch fails, or `SIMPLEFIN_BACKFILL_MAX_WINDOWS` is
 * hit (safety cap — a later call resumes from here). A prior 'complete' run
 * short-circuits with zero network calls: there's nothing further back to get.
 *
 * `fetchAccountsFn` / `now` / `sleepFn` are exposed for tests; production
 * callers omit them (real vault fetcher, real clock, real `setTimeout`).
 */
export async function backfillSimplefinHistory(
  connectionId: string,
  opts?: { fetchAccountsFn?: FetchAccountsFn; now?: Date; sleepFn?: (ms: number) => Promise<void> }
): Promise<SimplefinBackfillResult> {
  const db = getDb()
  const base = { connectionId, windowsFetched: 0, added: 0, duplicates: 0 }

  const conn = db
    .select({
      id: simplefinConnections.id,
      historyOldestDate: simplefinConnections.historyOldestDate,
      historyBackfillStatus: simplefinConnections.historyBackfillStatus
    })
    .from(simplefinConnections)
    .where(eq(simplefinConnections.connectionId, connectionId))
    .get()
  if (!conn) {
    return {
      ...base,
      oldestDateReached: null,
      status: 'error',
      errorMessage: `No simplefin_connections row for connectionId=${connectionId}`
    }
  }
  if (conn.historyBackfillStatus === 'complete') {
    // Already walked back to the institution's actual history start (or a
    // hard stop) on a prior run — nothing further back to fetch.
    return {
      ...base,
      oldestDateReached: conn.historyOldestDate,
      status: 'complete'
    }
  }

  let fetchAccountsFn: FetchAccountsFn
  if (opts?.fetchAccountsFn) {
    fetchAccountsFn = opts.fetchAccountsFn
  } else {
    const accessUrl = getAccessUrl(connectionId)
    if (!accessUrl) {
      return {
        ...base,
        oldestDateReached: conn.historyOldestDate,
        status: 'error',
        errorMessage:
          'No SimpleFIN access URL in vault — re-claim a Setup Token from the Integrations page.'
      }
    }
    fetchAccountsFn = (o) => fetchAccounts(accessUrl, o)
  }
  const sleepFn = opts?.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const integrationsRow = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, 'simplefin'))
    .get()
  const integrationId = integrationsRow?.id ?? null

  const rules = readCategorizationRules(db)

  const now = opts?.now ?? new Date()
  let endDate = conn.historyOldestDate
    ? fromIsoDate(conn.historyOldestDate)
    : Math.floor(now.getTime() / 1000)
  let oldestDateReached = conn.historyOldestDate
  let windowsFetched = 0
  let added = 0
  let duplicates = 0
  let consecutiveEmpty = 0
  let status: 'complete' | 'partial' | 'error' = 'partial'
  let errorMessage: string | undefined

  for (let i = 0; i < SIMPLEFIN_BACKFILL_MAX_WINDOWS; i++) {
    const startDate = endDate - SIMPLEFIN_BACKFILL_WINDOW_DAYS * 86_400

    let response: SimplefinAccountsResponse
    try {
      response = await fetchAccountsFn({ startDate, endDate })
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
      status = 'error'
      break
    }
    windowsFetched++

    const hardFailure = response.accounts.length === 0 && response.errors.length > 0
    if (hardFailure) {
      errorMessage = response.errors.join('; ').slice(0, 200)
      status = 'error'
      break
    }

    const ingest = ingestSimplefinResponse(db, conn.id, response, rules)
    added += ingest.added
    duplicates += ingest.duplicates
    oldestDateReached = toIsoDate(startDate)

    // "Nothing new" — not "nothing in the raw response" — is the real signal
    // that we've walked past useful history. Some bridges/institutions (seen
    // live with USAA via MX) ignore an old `start-date` and just keep
    // re-serving the same limited recent window every time, so
    // `txnCountInWindow` alone never hits zero; `added` catches that because
    // the hash UNIQUE constraint dedupes the repeat within this same run.
    // Deliberately NOT conditioned on `response.errors` being empty: a
    // non-fatal warning (e.g. USAA's "exceeds recommended range" — the same
    // warning `syncSimplefin` already tolerates, and one every 90-day backfill
    // window trips) still needs to count toward "empty" or this never fires —
    // that combination is exactly what happened live and burned the full
    // safety cap for nothing.
    if (ingest.added === 0) {
      consecutiveEmpty++
    } else {
      consecutiveEmpty = 0
    }
    if (consecutiveEmpty >= 2) {
      status = 'complete'
      break
    }

    endDate = startDate
    if (i < SIMPLEFIN_BACKFILL_MAX_WINDOWS - 1) {
      await sleepFn(SIMPLEFIN_BACKFILL_REQUEST_DELAY_MS)
    }
  }

  if (added > 0) {
    applyAtmSplit(db)
    reconcileTransactionCurrency(db)
  }

  db.update(simplefinConnections)
    .set({ historyOldestDate: oldestDateReached, historyBackfillStatus: status })
    .where(eq(simplefinConnections.connectionId, connectionId))
    .run()

  const statusNote =
    status === 'partial'
      ? ' (partial — safety cap hit, more history may exist)'
      : status === 'error'
        ? ` (stopped on error: ${errorMessage})`
        : ' (complete — institution history exhausted)'
  writeSyncEvent(
    integrationId,
    added,
    `Historical backfill: ${windowsFetched} window(s), ${added} added, oldest reached ${oldestDateReached ?? 'n/a'}${statusNote}`
  )

  return {
    connectionId,
    windowsFetched,
    added,
    duplicates,
    oldestDateReached,
    status,
    errorMessage
  }
}

/**
 * Insert a `sync_events` row. `integrationId` MUST be a value from
 * `integrations.id` (the schema FK), or null. Callers must NOT pass
 * `simplefin_connections.id` here.
 */
function writeSyncEvent(
  integrationId: number | null,
  recordsUpdated: number,
  errors: string | null
): void {
  const db = getDb()
  db.insert(syncEvents)
    .values({ integrationId, syncedAt: new Date(), recordsUpdated, errors })
    .run()
}
