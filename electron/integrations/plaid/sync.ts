/**
 * Plaid `/transactions/sync` cursor loop (Phase 4.6, PR 4).
 *
 * This is the heart of the Plaid integration. It pulls the delta of
 * transactions since the last sync, normalizes each one to Compass's
 * shared `RawTxn` shape, runs the same categorize / geo / tax pipeline
 * the CSV ingest path uses, and persists the results. Plaid's cursor
 * model means we can resume from a crash without dupes — but only if we
 * persist the cursor AFTER applying a page, never before.
 *
 * Ordering invariants this file enforces:
 *
 *   1. Cursor read → API call → DB writes → cursor write. Each page is
 *      one transaction in spirit (we don't wrap in BEGIN/COMMIT because
 *      better-sqlite3 single-statement writes are already atomic and the
 *      hash UNIQUE constraint provides the dedupe guarantee).
 *   2. Access token comes from the vault (`getAccessToken`). Never from a
 *      function argument — that would let a misbehaving renderer pass a
 *      token of its choosing, which is precisely the failure mode we built
 *      the vault to prevent.
 *   3. `removed` deletes happen BEFORE `added` upserts. Plaid sometimes
 *      sends a transaction as `removed` and re-issues it under a new
 *      `transaction_id` in the same response (e.g. when a pending charge
 *      posts). Removing first means the new row's hash isn't blocked by a
 *      stale duplicate.
 *
 * Error handling:
 *
 *   - `ITEM_LOGIN_REQUIRED` → record on `plaid_items.error_code` and
 *     return; the UI's Integrations card surfaces a "Re-authenticate"
 *     button. We do NOT delete the vault entry — the user's credentials
 *     are still valid, they just need to re-confirm with the institution.
 *   - Other Plaid errors → bubble up so the existing sync-events writer
 *     captures the message for the Sync Log.
 *   - Network errors → same as above; transient failures auto-recover
 *     when the next cron fires.
 */

import { eq } from 'drizzle-orm'
import type { PlaidApi, Transaction } from 'plaid'
import { getDb } from '../../db/client'
import {
  financeAccounts,
  financeTransactions,
  integrations,
  plaidItems,
  syncEvents
} from '../../db/schema'
import { categorizationRules } from '../../db/schema'
import { categorize } from '../finance'
import { applyAtmSplit } from '../finance-atm-split'
import { tagGeoAndPurpose } from '../finance-geo'
import { tagTax } from '../finance-tax'
import { getPlaidClient } from './client'
import { getCursor, setCursor } from './cursor'
import { buildPlaidSourceFile, normalizePlaidBatch } from './normalize'
import { getAccessToken } from './vault'

/**
 * Outcome of a single-Item sync. Returned (not thrown) for non-fatal
 * conditions so callers can summarize across multiple Items without
 * losing the partial successes.
 */
export type PlaidSyncResult = {
  itemId: string
  added: number
  modified: number
  removed: number
  duplicates: number
  cursorAdvanced: boolean
  errorCode?: string
  errorMessage?: string
}

/**
 * The shape of the bits of `TransactionsSyncResponse` we actually use.
 * Lets us mock the Plaid client in tests without dragging the full
 * 300-field Plaid types in.
 */
type SyncPage = {
  added: Transaction[]
  modified: Transaction[]
  removed: Array<{ transaction_id: string; account_id: string }>
  next_cursor: string
  has_more: boolean
}

/** Convenience: a function that returns the next page given a cursor. */
type FetchPage = (cursor: string | null) => Promise<SyncPage>

/**
 * Default page fetcher — talks to the real Plaid API. The sync loop accepts
 * any function with this shape so tests can substitute a deterministic
 * fixture without monkey-patching the SDK.
 */
function makeRealFetcher(api: PlaidApi, accessToken: string): FetchPage {
  return async (cursor) => {
    const resp = await api.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {})
    })
    return {
      added: resp.data.added,
      modified: resp.data.modified,
      removed: resp.data.removed,
      next_cursor: resp.data.next_cursor,
      has_more: resp.data.has_more
    }
  }
}

/**
 * Build a fast `account_id → account_name` lookup. The pipeline normalizes
 * to `RawTxn.account` (a human-readable string), so we read every
 * Plaid-linked `financeAccounts` row once at the start of a sync rather
 * than hitting the DB per transaction.
 *
 * For accounts we don't have a name for, fall back to a synthetic
 * `"<institution> ·<last4-of-id>"` so categorize() and the UI never see
 * an empty string.
 */
function buildAccountLookup(institutionName: string): (plaidAccountId: string) => string {
  const db = getDb()
  const rows = db
    .select({
      plaidAccountId: financeAccounts.plaidAccountId,
      name: financeAccounts.name
    })
    .from(financeAccounts)
    .all()
  const map = new Map<string, string>()
  for (const r of rows) {
    if (r.plaidAccountId) map.set(r.plaidAccountId, r.name)
  }
  return (plaidAccountId) => {
    const known = map.get(plaidAccountId)
    if (known) return known
    return `${institutionName} ·${plaidAccountId.slice(-4)}`
  }
}

/**
 * Categorization rules passed into `applyPage`. Read once at the top of
 * `syncPlaid` and reused across every page so we don't re-query
 * `categorization_rules` on each Plaid response.
 */
type CategorizeRule = { pattern: string; category: string; subcategory: string | null }

/**
 * Apply one page of Plaid sync results to the DB. Pure-ish — it reads the
 * existing hash set up-front and uses `ON CONFLICT DO NOTHING` for the
 * insert path, so concurrent syncs across multiple Items can't trip over
 * each other.
 */
function applyPage(
  page: SyncPage,
  itemContext: { institutionName: string },
  accountNameFor: (plaidAccountId: string) => string,
  rules: CategorizeRule[]
): {
  added: number
  modified: number
  removed: number
  duplicates: number
  errors: Array<{ transactionId: string; message: string }>
} {
  const db = getDb()

  // 1. Removed first — see top-of-file comment for rationale.
  let removedCount = 0
  for (const r of page.removed) {
    const sourceFile = buildPlaidSourceFile(itemContext, r.transaction_id)
    const res = db
      .delete(financeTransactions)
      .where(eq(financeTransactions.sourceFile, sourceFile))
      .run()
    removedCount += res.changes
  }

  // 2. Normalize, categorize, tag.
  const { ok: addedRaw, errors: addedErrors } = normalizePlaidBatch(
    page.added,
    itemContext,
    accountNameFor
  )
  const { ok: modifiedRaw, errors: modifiedErrors } = normalizePlaidBatch(
    page.modified,
    itemContext,
    accountNameFor
  )
  const all = [...addedRaw, ...modifiedRaw]
  // Rules were loaded once by syncPlaid and passed in — avoids a DB round-trip
  // per page on multi-page syncs.
  const tagged = tagTax(tagGeoAndPurpose(categorize(all, rules)))

  // 3. Apply — added uses insert-ignore-on-conflict, modified uses upsert
  //    (Plaid's `modified` array means "I had this txn before but a field
  //    changed", so we update in place rather than dropping).
  let addedCount = 0
  let duplicates = 0
  for (let i = 0; i < addedRaw.length; i++) {
    const t = tagged[i]
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
    if (res.changes === 1) addedCount++
    else duplicates++
  }

  let modifiedCount = 0
  for (let i = 0; i < modifiedRaw.length; i++) {
    // Modified rows live at index addedRaw.length + i in `tagged`.
    const t = tagged[addedRaw.length + i]
    // Update by hash — the hash is stable across `added`/`modified` because
    // it's derived from natural fields. If amount/date/description change
    // on Plaid's side, the hash changes too, and we'll see a new `added`
    // row + a `removed` row instead. So this UPDATE covers the case where
    // category-relevant fields (e.g. merchant_name) refined.
    const res = db
      .update(financeTransactions)
      .set({
        description: t.description,
        category: t.category ?? 'Uncategorized',
        subcategory: t.subcategory,
        notes: t.notes,
        geo: t.geo ?? 'US',
        purpose: t.purpose ?? null,
        taxTag: t.taxTag ?? 'tax:none',
        sourceFile: t.sourceFile
      })
      .where(eq(financeTransactions.hash, t.hash))
      .run()
    modifiedCount += res.changes
  }

  return {
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
    duplicates,
    errors: [...addedErrors, ...modifiedErrors]
  }
}

/**
 * Sync one Plaid Item end-to-end. Pulls every page (`has_more === false`
 * before returning), persists the cursor after each, and writes a single
 * `sync_events` row summarizing the result.
 *
 * `fetchPage` is exposed for tests; production callers omit it and we
 * build the real fetcher from the configured Plaid client + vault token.
 */
export async function syncPlaid(
  plaidItemId: string,
  opts?: { fetchPage?: FetchPage }
): Promise<PlaidSyncResult> {
  const db = getDb()

  // 1. Look up the Item row (institution name needed for sourceFile).
  const item = db
    .select({
      id: plaidItems.id,
      itemId: plaidItems.itemId,
      institutionName: plaidItems.institutionName
    })
    .from(plaidItems)
    .where(eq(plaidItems.itemId, plaidItemId))
    .get()
  if (!item) {
    return {
      itemId: plaidItemId,
      added: 0,
      modified: 0,
      removed: 0,
      duplicates: 0,
      cursorAdvanced: false,
      errorMessage: `No plaid_items row for itemId=${plaidItemId}`
    }
  }

  // 2. Build the fetcher (mock or real).
  let fetchPage: FetchPage
  if (opts?.fetchPage) {
    fetchPage = opts.fetchPage
  } else {
    const accessToken = getAccessToken(plaidItemId)
    if (!accessToken) {
      return {
        itemId: plaidItemId,
        added: 0,
        modified: 0,
        removed: 0,
        duplicates: 0,
        cursorAdvanced: false,
        errorMessage:
          'No Plaid access token in vault for this Item — reconnect from the Integrations page.'
      }
    }
    const client = getPlaidClient()
    fetchPage = makeRealFetcher(client.api, accessToken)
  }

  const accountNameFor = buildAccountLookup(item.institutionName)
  // Read categorization rules ONCE for the whole sync, not per page. Empty
  // array is fine — the smart fallbacks inside categorize() still fire
  // (CR ATM regex, Rocket Money rm:* mapping).
  const rules = db
    .select({
      pattern: categorizationRules.pattern,
      category: categorizationRules.category,
      subcategory: categorizationRules.subcategory
    })
    .from(categorizationRules)
    .orderBy(categorizationRules.priority)
    .all()
  // Look up the integrations.id ONCE for sync_events writes. sync_events.
  // integration_id is a FK to integrations.id (NOT plaid_items.id); passing
  // a plaid_items PK here would create an invalid FK and the Sync Log UI
  // would render "unknown" service.
  const integrationsRow = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, 'plaid'))
    .get()
  const integrationId = integrationsRow?.id ?? null

  const totals = { added: 0, modified: 0, removed: 0, duplicates: 0 }
  const allErrors: Array<{ transactionId: string; message: string }> = []
  let cursor = getCursor(plaidItemId)
  let cursorAdvanced = false

  // 3. Page loop. Bounded at MAX_PAGES to defend against a Plaid response
  //    that returns has_more=true forever with the same cursor (we've never
  //    seen this happen, but the bound is cheap insurance). Track whether
  //    we exited because Plaid said `has_more === false` (real completion)
  //    or because we hit the cap (partial sync — leave error_code intact
  //    and don't pretend the Item is fully synced).
  const MAX_PAGES = 50
  let completed = false
  for (let i = 0; i < MAX_PAGES; i++) {
    let page: SyncPage
    try {
      page = await fetchPage(cursor)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const errorCode = extractPlaidErrorCode(err)
      // Record persistent errors (ITEM_LOGIN_REQUIRED etc.) on the Item
      // row so the UI can surface them. Don't bubble — the sync_events
      // row below will record the failure.
      if (errorCode) {
        db.update(plaidItems).set({ errorCode }).where(eq(plaidItems.itemId, plaidItemId)).run()
      }
      writeSyncEvent(integrationId, totals.added + totals.modified, message)
      return {
        itemId: plaidItemId,
        ...totals,
        cursorAdvanced,
        errorCode: errorCode ?? undefined,
        errorMessage: message
      }
    }

    const pageResult = applyPage(
      page,
      { institutionName: item.institutionName },
      accountNameFor,
      rules
    )
    totals.added += pageResult.added
    totals.modified += pageResult.modified
    totals.removed += pageResult.removed
    totals.duplicates += pageResult.duplicates
    allErrors.push(...pageResult.errors)

    // Persist cursor only after a fully-successful page — see top of file.
    setCursor(plaidItemId, page.next_cursor)
    cursor = page.next_cursor
    cursorAdvanced = true

    if (!page.has_more) {
      completed = true
      break
    }
  }

  // 4. Always: run the CR ATM split if we added rows, write sync_events.
  //    On real completion: clear any prior error_code + stamp lastSyncedAt
  //    on both plaid_items and integrations.
  //    On cap-hit: leave error_code untouched, record a partial-sync error
  //    so the next sync resumes from the persisted cursor.
  if (totals.added > 0) applyAtmSplit(db)

  if (completed) {
    db.update(plaidItems)
      .set({ errorCode: null, lastSyncedAt: new Date() })
      .where(eq(plaidItems.itemId, plaidItemId))
      .run()
    db.update(integrations)
      .set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, 'plaid'))
      .run()
    writeSyncEvent(
      integrationId,
      totals.added + totals.modified,
      allErrors.length > 0 ? JSON.stringify(allErrors) : null
    )
    return { itemId: plaidItemId, ...totals, cursorAdvanced }
  }

  // Partial sync (hit MAX_PAGES cap). Cursor is persisted at the last
  // applied page, so the next run resumes correctly.
  const partialMessage = `Plaid sync hit ${MAX_PAGES}-page cap; partial — next sync will resume from cursor.`
  writeSyncEvent(integrationId, totals.added + totals.modified, partialMessage)
  return {
    itemId: plaidItemId,
    ...totals,
    cursorAdvanced,
    errorMessage: partialMessage
  }
}

/**
 * Sync every connected Plaid Item. Used by the daily cron and by the
 * Integrations page "Sync all" button. Errors on individual Items don't
 * abort the loop.
 */
export async function syncAllPlaid(opts?: { fetchPage?: FetchPage }): Promise<PlaidSyncResult[]> {
  const db = getDb()
  const items = db.select({ itemId: plaidItems.itemId }).from(plaidItems).all()
  const results: PlaidSyncResult[] = []
  for (const i of items) {
    results.push(await syncPlaid(i.itemId, opts))
  }
  return results
}

// ---------- helpers ----------

/**
 * Pull Plaid's `error_code` out of a thrown SDK error. The Plaid SDK throws
 * Axios-style errors with the structured Plaid body under
 * `err.response.data.error_code`. We only care about persistent codes
 * (`ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`); transient ones don't get
 * stuck on the Item row.
 */
function extractPlaidErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { response?: { data?: { error_code?: unknown } } }
  const code = e.response?.data?.error_code
  if (typeof code !== 'string') return null
  // Only persistent error codes get sticky. Anything else (rate limit,
  // network blip) is transient and shouldn't trip the re-auth UI.
  const PERSISTENT = new Set([
    'ITEM_LOGIN_REQUIRED',
    'PENDING_EXPIRATION',
    'PENDING_DISCONNECT',
    'ACCESS_NOT_GRANTED'
  ])
  return PERSISTENT.has(code) ? code : null
}

/**
 * Insert a `sync_events` row. `integrationId` MUST be a value from
 * `integrations.id` (the schema FK), or null if no integrations row exists
 * yet for Plaid. Callers must NOT pass `plaid_items.id` here — that would
 * create an invalid FK + show "unknown" in the Sync Log UI.
 */
function writeSyncEvent(
  integrationId: number | null,
  recordsUpdated: number,
  errors: string | null
): void {
  const db = getDb()
  db.insert(syncEvents)
    .values({
      integrationId,
      syncedAt: new Date(),
      recordsUpdated,
      errors
    })
    .run()
}
