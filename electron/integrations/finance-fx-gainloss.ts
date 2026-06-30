/**
 * Unrealized FX gain/loss on foreign-currency positions (Phase 11.1 follow-up).
 *
 * A US person holding a colón bank account (or owing a colón mortgage) carries
 * currency risk: the USD value of that position moves with the CRC/USD rate even
 * when the native balance is untouched. This surface answers "how much of my
 * foreign holdings' USD value is the exchange rate, not deposits?" by valuing
 * each foreign position at TWO rates — a baseline (year-start by default) and
 * the latest — holding the native balance constant:
 *
 *     gainLoss = balanceBase(now) − balanceBase(baseline)
 *
 * Balances are signed by net-worth convention (assets +, debts −), so a colón
 * debt shrinking in USD terms reads as a gain, an asset shrinking as a loss.
 * It is UNREALIZED and informational — not a tax figure (realized FX gain on an
 * actual conversion is a separate, transaction-level concept). Positions with no
 * FX rate on or before the baseline (or none at all) are surfaced as unpriced
 * rather than silently dropped.
 *
 * `computeFxGainLoss` is pure; `buildFxGainLossFromDb` wires the live positions
 * (reusing the net-worth snapshot) + the FX-rate history.
 */

import { type FxRate, convert, getBaseCurrency, loadFxRates, normalizeCurrency } from './finance-fx'
import { type SqliteForSnapshot, getNetWorthSnapshot } from './finance-snapshot'

export type FxPosition = {
  accountId: number
  name: string
  currency: string
  /** Native balance, SIGNED by net-worth convention (asset +, debt −). */
  balance: number
}

export type FxGainLossRow = {
  accountId: number
  name: string
  currency: string
  balance: number
  /** `balance` valued in base currency at the baseline-date rate (null = no rate). */
  baseValueThen: number | null
  /** `balance` valued in base currency at the latest rate (null = no rate). */
  baseValueNow: number | null
  /** baseValueNow − baseValueThen, or null when either valuation is missing. */
  gainLoss: number | null
}

export type FxGainLossSummary = {
  baseCurrency: string
  baselineDate: string
  positions: FxGainLossRow[]
  /** Sum of the priced rows' gainLoss, in base currency. */
  totalGainLoss: number
  pricedCount: number
  /** Rows missing a baseline and/or current rate (excluded from the total). */
  unpricedCount: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Value each foreign position at the baseline + latest rate and difference them.
 * Base-currency positions carry no FX risk and are dropped (they'd be a 1:1
 * no-op). `asOfNow` defaults to "latest available rate".
 */
export function computeFxGainLoss(input: {
  positions: FxPosition[]
  baseCurrency: string
  rates: FxRate[]
  baselineDate: string
  asOfNow?: string
}): FxGainLossSummary {
  const base = normalizeCurrency(input.baseCurrency)
  const positions: FxGainLossRow[] = input.positions
    .filter((p) => normalizeCurrency(p.currency) !== base)
    .map((p) => {
      const currency = normalizeCurrency(p.currency)
      const baseValueThen = convert(p.balance, currency, base, input.rates, input.baselineDate)
      const baseValueNow = convert(p.balance, currency, base, input.rates, input.asOfNow)
      const gainLoss =
        baseValueThen != null && baseValueNow != null ? round2(baseValueNow - baseValueThen) : null
      return {
        accountId: p.accountId,
        name: p.name,
        currency,
        balance: p.balance,
        baseValueThen,
        baseValueNow,
        gainLoss
      }
    })

  const priced = positions.filter((r) => r.gainLoss != null)
  const totalGainLoss = round2(priced.reduce((s, r) => s + (r.gainLoss as number), 0))
  return {
    baseCurrency: base,
    baselineDate: input.baselineDate,
    positions,
    totalGainLoss,
    pricedCount: priced.length,
    unpricedCount: positions.length - priced.length
  }
}

/**
 * Live FX gain/loss for the current year (baseline = Jan 1). Reuses the
 * net-worth snapshot for current per-account balances (signed by debt), so a
 * foreign account's position matches exactly what Net Worth shows.
 */
export function buildFxGainLossFromDb(
  sqlite: SqliteForSnapshot,
  opts: { year?: number; now?: number } = {}
): FxGainLossSummary {
  const base = getBaseCurrency(sqlite)
  const rates = loadFxRates(sqlite)
  const snap = getNetWorthSnapshot(sqlite, opts.now)
  const positions: FxPosition[] = snap.byAccount
    .filter((a) => normalizeCurrency(a.currency) !== normalizeCurrency(base) && a.balance !== 0)
    .map((a) => ({
      accountId: a.accountId,
      name: a.name,
      currency: a.currency,
      balance: a.isDebt ? -a.balance : a.balance
    }))
  const year = opts.year ?? new Date(opts.now ?? Date.now()).getFullYear()
  return computeFxGainLoss({ positions, baseCurrency: base, rates, baselineDate: `${year}-01-01` })
}
