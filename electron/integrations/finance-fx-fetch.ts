/**
 * Automated FX-rate fetch (Phase 11.1b).
 *
 * The no-network foundation (finance-fx.ts) let the user enter rates by hand;
 * this pulls them automatically from a free, no-key provider so foreign-currency
 * net worth stays current without manual upkeep.
 *
 * SECURITY POSTURE (this is a `security-auditor` gate — keep the line):
 *   - MAIN-PROCESS ONLY. The renderer must NEVER import this module; it triggers
 *     a refresh over IPC (`finance:refresh-fx-rates`).
 *   - The request is an unauthenticated `GET https://open.er-api.com/v6/latest/USD`.
 *     It sends NO credentials, account numbers, balances, or any user data — only
 *     the literal anchor code "USD". The single network egress is this one host,
 *     pinned in `main.ts`'s CSP `connect-src` with NO wildcard.
 *   - The response writes only to `fx_rates` (non-sensitive public rates).
 *
 * Provider: open.er-api.com (exchangerate-api's free tier). Chosen because it
 * needs no API key AND covers the user's real currencies including CRC (colón)
 * and COP — which several no-key providers (e.g. frankfurter.app) omit.
 *
 * `fetchImpl` is injectable so tests never hit the network (the SimpleFIN-client
 * pattern).
 */

import { localYmd } from '../lib/dates'
import { SUPPORTED_CURRENCIES, type SqliteForFx, upsertFxRate } from './finance-fx'

// Pinned host. Must match the `connect-src` entry in electron/main.ts — keep the
// two in lockstep (no wildcard, single origin).
export const ER_API_BASE = 'https://open.er-api.com/v6/latest'

type ErApiResponse = {
  result?: string // 'success' | 'error'
  'error-type'?: string
  base_code?: string
  rates?: Record<string, number>
}

export type FetchedRate = { base: string; quote: string; rate: number }

/**
 * Fetch the latest USD-anchored rates for every supported currency. Returns one
 * `{ base:'USD', quote, rate }` per currency the provider knows (USD itself and
 * any missing/invalid entries are skipped). Throws on a network error, a non-2xx
 * response, a provider `result:"error"`, or a malformed body — the caller logs
 * and leaves the existing rates untouched.
 *
 * Always anchors on USD: the conversion engine triangulates every pair through
 * USD, so one USD-anchored snapshot values the whole portfolio regardless of the
 * user's chosen base currency.
 */
export async function fetchLatestRates(
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<FetchedRate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const anchor = 'USD'

  const resp = await fetchImpl(`${ER_API_BASE}/${anchor}`)
  if (!resp.ok) {
    throw new Error(`FX rate fetch failed (HTTP ${resp.status})`)
  }
  const data = (await resp.json()) as ErApiResponse
  if (data.result && data.result !== 'success') {
    throw new Error(`FX rate provider error: ${data['error-type'] ?? 'unknown'}`)
  }
  const rates = data.rates
  if (!rates || typeof rates !== 'object') {
    throw new Error('FX rate response missing rates')
  }

  const out: FetchedRate[] = []
  for (const c of SUPPORTED_CURRENCIES) {
    if (c.code === anchor) continue
    const rate = rates[c.code]
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      out.push({ base: anchor, quote: c.code, rate })
    }
  }
  return out
}

/**
 * Fetch + persist today's rates (source 'erapi'). Idempotent within a day via
 * the `fx_rates` UNIQUE (date, base, quote) key, so re-running just refreshes.
 * Returns the count written and the as-of date.
 */
export async function syncFxRates(
  sqlite: SqliteForFx,
  opts: { fetchImpl?: typeof fetch; date?: string } = {}
): Promise<{ updated: number; date: string }> {
  const date = opts.date ?? localYmd()
  const rates = await fetchLatestRates({ fetchImpl: opts.fetchImpl })
  for (const r of rates) {
    upsertFxRate(sqlite, { date, base: r.base, quote: r.quote, rate: r.rate, source: 'erapi' })
  }
  return { updated: rates.length, date }
}
