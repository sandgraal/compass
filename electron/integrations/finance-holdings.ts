/**
 * Brokerage-holdings import (Phase 10.2 — FILE path).
 *
 * A GENERIC positions-CSV importer: most broker exports (Schwab, Fidelity,
 * Vanguard, E*Trade, …) share the same column concepts even when the exact
 * headers differ, so `parseHoldingsCsv` matches on a list of common names per
 * field rather than hard-coding one broker's format. Each import is a dated
 * SNAPSHOT of positions, stored as `records` (source `brokerage-holdings`,
 * type `holding`) — no new table — so re-importing next month adds a new
 * snapshot and the timeline keeps the history. `getLatestHoldings` reads back
 * the most recent snapshot for the Holdings view + net-worth-adjacent totals.
 *
 * NOTE: column matching is best-effort across brokers and unvalidated against a
 * specific real export; drop a real positions CSV to sharpen the recognizer.
 * `parseHoldingsCsv` + `summarizeHoldings` are pure; the DB layer is thin.
 */

import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

export const HOLDINGS_SOURCE = 'brokerage-holdings'

export type ParsedHolding = {
  symbol: string
  description: string | null
  quantity: number | null
  price: number | null
  marketValue: number | null
  costBasis: number | null
  account: string | null
}

export type HoldingsSummary = {
  count: number
  totalMarketValue: number
  totalCostBasis: number | null
  totalGain: number | null
  totalGainPct: number | null
}

// Common column names per field, in priority order. Exact-header match wins
// over a substring match so e.g. `price` doesn't lose to `price change`.
const COLS: Record<keyof Omit<ParsedHolding, 'account'>, string[]> = {
  symbol: ['symbol', 'ticker'],
  description: ['description', 'security', 'security description', 'name'],
  quantity: ['quantity', 'shares', 'qty', 'units', 'share quantity'],
  price: ['price', 'last price', 'last', 'market price', 'close price', 'current price'],
  marketValue: ['market value', 'current value', 'mkt val', 'market val', 'value'],
  costBasis: ['cost basis', 'cost basis total', 'total cost', 'cost', 'book value']
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Parse a money/number cell: strips `$ , %`, treats `(123)` as `-123`. */
function num(s: string | undefined): number | null {
  if (s == null) return null
  let t = s.trim()
  if (!t || t === '-' || t === 'N/A' || t === '--') return null
  const negParen = t.startsWith('(') && t.endsWith(')')
  if (negParen) t = t.slice(1, -1)
  t = t.replace(/[$,%\s]/g, '')
  if (!t) return null
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return null
  return negParen ? -n : n
}

function findCol(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.indexOf(c)
    if (i !== -1) return i
  }
  for (const c of candidates) {
    const i = headers.findIndex((h) => h.includes(c))
    if (i !== -1) return i
  }
  return -1
}

/**
 * Parse a brokerage positions CSV into holdings. Returns `[]` when the file
 * isn't a positions export (no symbol column). Market value is derived from
 * quantity × price when the export omits it. Total/summary rows and rows with
 * neither a quantity nor a value are skipped.
 */
export function parseHoldingsCsv(
  headers: string[],
  rows: string[][],
  opts: { account?: string } = {}
): ParsedHolding[] {
  const h = headers.map((c) => c.trim().toLowerCase())
  const iSym = findCol(h, COLS.symbol)
  if (iSym === -1) return []
  const iDesc = findCol(h, COLS.description)
  const iQty = findCol(h, COLS.quantity)
  const iPrice = findCol(h, COLS.price)
  const iMv = findCol(h, COLS.marketValue)
  const iCost = findCol(h, COLS.costBasis)

  const out: ParsedHolding[] = []
  for (const r of rows) {
    const symbol = (r[iSym] ?? '').trim()
    if (!symbol) continue
    if (symbol.toLowerCase().startsWith('total')) continue // summary row

    const quantity = iQty >= 0 ? num(r[iQty]) : null
    const price = iPrice >= 0 ? num(r[iPrice]) : null
    let marketValue = iMv >= 0 ? num(r[iMv]) : null
    if (marketValue == null && quantity != null && price != null) {
      marketValue = round2(quantity * price)
    }
    const costBasis = iCost >= 0 ? num(r[iCost]) : null

    if (quantity == null && marketValue == null) continue // nothing usable

    out.push({
      symbol: symbol.toUpperCase(),
      description: iDesc >= 0 ? (r[iDesc] ?? '').trim() || null : null,
      quantity,
      price,
      marketValue,
      costBasis,
      account: opts.account ?? null
    })
  }
  return out
}

/** Total market value, cost basis, and unrealized gain across positions. */
export function summarizeHoldings(holdings: ParsedHolding[]): HoldingsSummary {
  let totalMarketValue = 0
  let totalCostBasis = 0
  let hasCost = false
  for (const hd of holdings) {
    if (hd.marketValue != null) totalMarketValue += hd.marketValue
    if (hd.costBasis != null) {
      totalCostBasis += hd.costBasis
      hasCost = true
    }
  }
  totalMarketValue = round2(totalMarketValue)
  const cost = hasCost ? round2(totalCostBasis) : null
  const totalGain = cost != null ? round2(totalMarketValue - cost) : null
  const totalGainPct =
    cost != null && cost !== 0 ? round2(((totalMarketValue - cost) / cost) * 100) : null
  return { count: holdings.length, totalMarketValue, totalCostBasis: cost, totalGain, totalGainPct }
}

// ─── DB layer (records-backed; no dedicated table) ───────────────────────────

function dedupHash(asOf: string, symbol: string, account: string | null): string {
  return createHash('sha1')
    .update(`${HOLDINGS_SOURCE}|${asOf}|${symbol}|${account ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Persist a positions snapshot as `records`. `asOf` (YYYY-MM-DD) keys the
 * snapshot — re-importing the same day dedups, a new day adds a snapshot.
 */
export function importHoldings(
  db: BetterSQLite3Database<typeof schema>,
  holdings: ParsedHolding[],
  asOf: string,
  provenance: string
): { imported: number; duplicates: number } {
  const occurredAt = new Date(`${asOf}T00:00:00`)
  let imported = 0
  for (const hd of holdings) {
    const res = db
      .insert(schema.records)
      .values({
        source: HOLDINGS_SOURCE,
        type: 'holding',
        occurredAt,
        title: `${hd.symbol}${hd.quantity != null ? ` — ${hd.quantity} sh` : ''}`,
        body: hd.marketValue != null ? `$${hd.marketValue.toLocaleString('en-US')}` : null,
        payload: JSON.stringify({ ...hd, asOf }),
        dedupHash: dedupHash(asOf, hd.symbol, hd.account),
        provenance
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported, duplicates: holdings.length - imported }
}

export type SqliteForHoldings = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

/** The most recent positions snapshot + its summary (empty when none). */
export function getLatestHoldings(sqlite: SqliteForHoldings): {
  asOf: string | null
  holdings: ParsedHolding[]
  summary: HoldingsSummary
} {
  let rows: Array<{ occurred_at: number | null; payload: string | null }> = []
  try {
    rows = sqlite
      .prepare(
        'SELECT occurred_at, payload FROM records WHERE source = ? ORDER BY occurred_at DESC'
      )
      .all(HOLDINGS_SOURCE) as Array<{ occurred_at: number | null; payload: string | null }>
  } catch {
    // `records` may not exist on a very old DB — degrade to empty.
    return { asOf: null, holdings: [], summary: summarizeHoldings([]) }
  }
  if (rows.length === 0) return { asOf: null, holdings: [], summary: summarizeHoldings([]) }

  const latest = rows[0].occurred_at
  const holdings: ParsedHolding[] = []
  let asOf: string | null = null
  for (const r of rows) {
    if (r.occurred_at !== latest) break // rows are sorted desc → stop at older snapshot
    if (!r.payload) continue
    try {
      const p = JSON.parse(r.payload) as ParsedHolding & { asOf?: string }
      asOf = p.asOf ?? asOf
      holdings.push({
        symbol: p.symbol,
        description: p.description ?? null,
        quantity: p.quantity ?? null,
        price: p.price ?? null,
        marketValue: p.marketValue ?? null,
        costBasis: p.costBasis ?? null,
        account: p.account ?? null
      })
    } catch {
      // skip a corrupt payload
    }
  }
  return { asOf, holdings, summary: summarizeHoldings(holdings) }
}
