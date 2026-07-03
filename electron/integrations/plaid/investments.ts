/**
 * Plaid Investments → Compass holdings snapshot (Phase 10.2 — LIVE path).
 *
 * The LIVE sibling of the brokerage-CSV importer (`finance-holdings.ts`). Where
 * that path parses a positions CSV the user downloaded, this pulls current
 * positions from Plaid's `/investments/holdings/get` and writes them as the
 * SAME dated `records` snapshot (type `holding`) — just with a distinct
 * `source` (`plaid-investments`) and provenance. Net Worth's holdings card
 * reads both via `NET_WORTH_HOLDINGS_SOURCES`, so no new UI is needed.
 *
 * `normalizePlaidHoldings` is pure (join holdings↔securities, map to
 * `ParsedHolding`) so it's unit-testable without the network; `syncPlaidInvestments`
 * is the thin DB/API wrapper, mirroring `sync.ts`'s injectable-fetcher shape.
 */

import type { Holding, PlaidApi, Security } from 'plaid'
import { getDb } from '../../db/client'
import { plaidItems } from '../../db/schema'
import { localYmd } from '../../lib/dates'
import { PLAID_INVESTMENTS_SOURCE, type ParsedHolding, importHoldings } from '../finance-holdings'
import { getPlaidClient } from './client'
import { getAccessToken } from './vault'

export type PlaidInvestmentsResult = {
  itemId: string
  imported: number
  duplicates: number
  errorMessage?: string
}

/** The bits of `InvestmentsHoldingsGetResponse` we use — lets tests supply a
 *  fixture without the full Plaid type surface. */
export type HoldingsPage = {
  holdings: Holding[]
  securities: Security[]
}

type FetchHoldings = () => Promise<HoldingsPage>

/**
 * Pure mapping: Plaid holdings + securities → `ParsedHolding[]`. Joins each
 * holding to its security on `security_id` for the ticker/name, and uses
 * Plaid's institution-priced `institution_value` as market value (so, unlike
 * crypto exports, this DOES carry a real valuation). Rows whose security is
 * missing fall back to the security_id so nothing is silently dropped.
 */
export function normalizePlaidHoldings(
  page: HoldingsPage,
  accountNameFor: (accountId: string) => string
): ParsedHolding[] {
  const securityById = new Map(page.securities.map((s) => [s.security_id, s]))
  const out: ParsedHolding[] = []
  for (const h of page.holdings) {
    const sec = securityById.get(h.security_id)
    const symbol = (sec?.ticker_symbol || sec?.name || h.security_id).trim()
    if (!symbol) continue
    out.push({
      symbol: symbol.toUpperCase(),
      description: sec?.name ?? null,
      quantity: h.quantity ?? null,
      price: h.institution_price ?? null,
      marketValue: h.institution_value ?? null,
      costBasis: h.cost_basis ?? null,
      account: accountNameFor(h.account_id)
    })
  }
  return out
}

/**
 * Sync one Plaid Item's investment holdings into a dated `records` snapshot.
 * Returns (not throws) on the "not configured / no token" cases so a caller
 * looping over Items can summarize without losing partial successes.
 *
 * `fetchHoldings` is injectable for tests; production omits it and we build the
 * real fetcher from the configured Plaid client + vault token.
 */
export async function syncPlaidInvestments(
  plaidItemId: string,
  institutionName: string,
  opts?: { fetchHoldings?: FetchHoldings; asOf?: string }
): Promise<PlaidInvestmentsResult> {
  let fetchHoldings: FetchHoldings
  if (opts?.fetchHoldings) {
    fetchHoldings = opts.fetchHoldings
  } else {
    const accessToken = getAccessToken(plaidItemId)
    if (!accessToken) {
      return {
        itemId: plaidItemId,
        imported: 0,
        duplicates: 0,
        errorMessage:
          'No Plaid access token in vault for this Item — reconnect from the Integrations page.'
      }
    }
    let api: PlaidApi
    try {
      api = getPlaidClient().api
    } catch (err) {
      return {
        itemId: plaidItemId,
        imported: 0,
        duplicates: 0,
        errorMessage: err instanceof Error ? err.message : String(err)
      }
    }
    fetchHoldings = async () => {
      const resp = await api.investmentsHoldingsGet({ access_token: accessToken })
      return { holdings: resp.data.holdings, securities: resp.data.securities }
    }
  }

  let page: HoldingsPage
  try {
    page = await fetchHoldings()
  } catch (err) {
    return {
      itemId: plaidItemId,
      imported: 0,
      duplicates: 0,
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }

  const accountNameFor = (accountId: string): string => `${institutionName} ·${accountId.slice(-4)}`
  const holdings = normalizePlaidHoldings(page, accountNameFor)
  if (holdings.length === 0) {
    return { itemId: plaidItemId, imported: 0, duplicates: 0 }
  }

  const asOf = opts?.asOf ?? localYmd()
  const { imported, duplicates } = importHoldings(
    getDb(),
    holdings,
    asOf,
    `plaid:${institutionName}`,
    PLAID_INVESTMENTS_SOURCE
  )
  return { itemId: plaidItemId, imported, duplicates }
}

/**
 * Sync investment holdings for every connected Plaid Item. Best-effort: an Item
 * with no investment accounts returns an error (NO_INVESTMENT_ACCOUNTS etc.)
 * rather than throwing, so one checking-only Item never aborts the loop. Caller
 * folds the imported count into the Plaid sync total but does NOT gate the
 * transactions-sync success on these results.
 */
export async function syncAllPlaidInvestments(opts?: {
  fetchHoldings?: FetchHoldings
}): Promise<PlaidInvestmentsResult[]> {
  const db = getDb()
  const items = db
    .select({ itemId: plaidItems.itemId, institutionName: plaidItems.institutionName })
    .from(plaidItems)
    .all()
  const results: PlaidInvestmentsResult[] = []
  for (const i of items) {
    results.push(await syncPlaidInvestments(i.itemId, i.institutionName, opts))
  }
  return results
}
