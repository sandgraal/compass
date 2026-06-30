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
import { type RawTxn, categorize } from '../finance'
import { applyAtmSplit } from '../finance-atm-split'
import { reconcileTransactionCurrency } from '../finance-currency'
import { tagGeoAndPurpose } from '../finance-geo'
import { tagTax } from '../finance-tax'
import { classifySimplefinAccount } from './classify'
import { type SimplefinAccountsResponse, fetchAccounts } from './client'
import { SIMPLEFIN_INCREMENTAL_LOOKBACK_DAYS, SIMPLEFIN_LOOKBACK_DAYS } from './config'
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

  // 5. Upsert accounts + build the account-name lookup. Balance is refreshed
  //    every sync; name/type/assetClass are classified on first insert only, so
  //    a user's later re-classification in the Accounts UI is never clobbered.
  //    For DEBT accounts the stored balance is the positive amount owed (schema
  //    convention; see finance-snapshot.ts), so we store |balance|.
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
          simplefinConnectionId: conn.id,
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
          simplefinConnectionId: conn.id,
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
        simplefinConnectionId: conn.id,
        simplefinAccountId: acct.id
      })
      .run()
    accountsUpserted++
    nameMap.set(acct.id, displayName)
    idMap.set(acct.id, Number(res.lastInsertRowid))
  }
  const accountNameFor = (id: string): string => nameMap.get(id) ?? `SimpleFIN ·${id.slice(-4)}`

  // 6. Normalize every account's transactions to RawTxn, remembering which
  //    finance_accounts.id each one belongs to (parallel to allRaw, preserved
  //    through the order-stable categorize/tag pipeline below).
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
  //    The loop pairs tagged[i] with rawAccountIds[i] by index, which assumes
  //    the categorize/geo/tax pipeline preserves order AND length. Assert it so
  //    a future filtering/reordering change fails fast here instead of silently
  //    mis-linking transactions to the wrong account.
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
        sourceFile: t.sourceFile,
        ingestedAt: new Date()
      })
      .onConflictDoNothing()
      .run()
    if (res.changes === 1) added++
    else duplicates++
  }

  // 9. CR ATM split + currency reconcile (only if we added rows), mirroring
  //    the Plaid + CSV paths. Reconcile runs after the split so the split
  //    sibling rows inherit their account's currency too.
  if (added > 0) {
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
    ...allErrors.map((e) => `${e.transactionId}: ${e.message}`)
  ]
  writeSyncEvent(integrationId, added, eventLog.length > 0 ? JSON.stringify(eventLog) : null)

  return {
    connectionId,
    added,
    duplicates,
    accountsUpserted,
    accountsLinked,
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
