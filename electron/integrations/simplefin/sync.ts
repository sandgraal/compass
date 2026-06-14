/**
 * SimpleFIN date-windowed sync (Phase 4.7).
 *
 * The SimpleFIN counterpart to `plaid/sync.ts`, but simpler — there is no
 * cursor and no `/transactions/sync` delta. Each run GETs `<accessUrl>/accounts`
 * for the last `SIMPLEFIN_LOOKBACK_DAYS`, upserts the account rows, normalizes
 * every transaction to Compass's shared `RawTxn` shape, runs the same
 * categorize / geo / tax pipeline the CSV + Plaid paths use, and inserts with
 * `ON CONFLICT DO NOTHING`.
 *
 * IDEMPOTENCY: there is no resume state. Re-pulling the same 90-day window every
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
 * standardized account-type field, so newly-linked accounts default to a
 * 'checking' / 'spending' account. Balances are refreshed every sync, but the
 * `name` / `type` / `assetClass` are preserved after first link so a user's
 * re-classification in the Accounts UI is never clobbered.
 */

import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  categorizationRules,
  financeAccounts,
  financeTransactions,
  integrations,
  simplefinConnections,
  syncEvents
} from '../../db/schema'
import { type RawTxn, categorize } from '../finance'
import { applyAtmSplit } from '../finance-atm-split'
import { tagGeoAndPurpose } from '../finance-geo'
import { tagTax } from '../finance-tax'
import { type SimplefinAccountsResponse, fetchAccounts } from './client'
import { SIMPLEFIN_LOOKBACK_DAYS } from './config'
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
  accountsUpserted: number
  errorMessage?: string
}

/** A function that returns the `/accounts` payload for a date window. Injected
 *  by tests; production builds it from the vault Access URL. */
type FetchAccountsFn = (opts: {
  startDate: number
  endDate: number
  pending?: boolean
}) => Promise<SimplefinAccountsResponse>

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
  const base = { connectionId, added: 0, duplicates: 0, accountsUpserted: 0 }

  // 1. Connection row (its PK is the FK we stamp onto finance_accounts).
  const conn = db
    .select({ id: simplefinConnections.id })
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

  // 3. Date window: the trailing SIMPLEFIN_LOOKBACK_DAYS up to now.
  const now = opts?.now ?? new Date()
  const endDate = Math.floor(now.getTime() / 1000)
  const startDate = endDate - SIMPLEFIN_LOOKBACK_DAYS * 86_400

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

  // 5. Upsert accounts + build the account-name lookup. Balance is refreshed
  //    every sync; name/type/assetClass are set only on first insert so user
  //    edits survive.
  const nameMap = new Map<string, string>()
  let accountsUpserted = 0
  for (const acct of response.accounts) {
    const orgName = acct.org?.name ?? ''
    const balanceNum = Number.parseFloat(acct.balance)
    const balance = Number.isFinite(balanceNum) ? balanceNum : 0
    const displayName =
      (acct.name ?? '').trim() || `${orgName || 'SimpleFIN'} ·${acct.id.slice(-4)}`
    const existing = db
      .select({ id: financeAccounts.id, name: financeAccounts.name })
      .from(financeAccounts)
      .where(eq(financeAccounts.simplefinAccountId, acct.id))
      .get()
    if (existing) {
      db.update(financeAccounts)
        .set({
          balance,
          institution: orgName,
          simplefinConnectionId: conn.id,
          updatedAt: new Date()
        })
        .where(eq(financeAccounts.id, existing.id))
        .run()
      nameMap.set(acct.id, existing.name)
    } else {
      db.insert(financeAccounts)
        .values({
          name: displayName,
          type: 'checking',
          institution: orgName,
          assetClass: 'spending',
          balance,
          simplefinConnectionId: conn.id,
          simplefinAccountId: acct.id
        })
        .run()
      accountsUpserted++
      nameMap.set(acct.id, displayName)
    }
  }
  const accountNameFor = (id: string): string => nameMap.get(id) ?? `SimpleFIN ·${id.slice(-4)}`

  // 6. Normalize every account's transactions to RawTxn.
  const allRaw: RawTxn[] = []
  const allErrors: Array<{ transactionId: string; message: string }> = []
  for (const acct of response.accounts) {
    const { ok, errors } = normalizeSimplefinAccount(acct, accountNameFor)
    allRaw.push(...ok)
    allErrors.push(...errors)
  }

  // 7. Categorize + geo/tax tag. Rules read once for the whole sync.
  const rules = db
    .select({
      pattern: categorizationRules.pattern,
      category: categorizationRules.category,
      subcategory: categorizationRules.subcategory
    })
    .from(categorizationRules)
    .orderBy(categorizationRules.priority)
    .all()
  const tagged = tagTax(tagGeoAndPurpose(categorize(allRaw, rules)))

  // 8. Insert. The hash UNIQUE constraint is the entire idempotency guard.
  let added = 0
  let duplicates = 0
  for (const t of tagged) {
    const res = db
      .insert(financeTransactions)
      .values({
        hash: t.hash,
        date: t.date,
        amount: t.amount,
        description: t.description,
        accountId: null,
        category: t.category ?? 'Uncategorized',
        subcategory: t.subcategory,
        notes: t.notes,
        geo: t.geo ?? 'US',
        purpose: t.purpose ?? null,
        taxTag: t.taxTag ?? 'tax:none',
        taxTagSource: 'auto',
        taxYear: t.taxYear ?? null,
        sourceFile: t.sourceFile,
        ingestedAt: new Date()
      })
      .onConflictDoNothing()
      .run()
    if (res.changes === 1) added++
    else duplicates++
  }

  // 9. CR ATM split (only if we added rows), mirroring the Plaid + CSV paths.
  if (added > 0) applyAtmSplit(db)

  // 10. Record outcome. SimpleFIN's top-level `errors[]` (e.g. a stale
  //     connection that needs re-auth at the bridge) sticks on the connection
  //     row + integrations status so the UI can prompt a re-claim.
  const responseErrors = response.errors.length > 0 ? response.errors.join('; ') : null
  db.update(simplefinConnections)
    .set({
      lastSyncedAt: new Date(),
      errorCode: responseErrors ? responseErrors.slice(0, 200) : null
    })
    .where(eq(simplefinConnections.connectionId, connectionId))
    .run()
  db.update(integrations)
    .set({
      lastSyncedAt: new Date(),
      status: responseErrors ? 'error' : 'connected',
      errorMessage: responseErrors
    })
    .where(eq(integrations.service, 'simplefin'))
    .run()
  const errorLog = [
    ...(responseErrors ? [responseErrors] : []),
    ...allErrors.map((e) => `${e.transactionId}: ${e.message}`)
  ]
  writeSyncEvent(integrationId, added, errorLog.length > 0 ? JSON.stringify(errorLog) : null)

  return {
    connectionId,
    added,
    duplicates,
    accountsUpserted,
    errorMessage: responseErrors ?? undefined
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
