/**
 * Multi-currency foundation (Phase 11.1).
 *
 * Compass historically assumed every amount was USD. This module is the seam
 * that lets accounts and transactions carry an ISO-4217 `currency` and still
 * roll up into a single **base currency** (default USD) for net worth and
 * forecasting.
 *
 * The math is pure — `pickRate()` / `convert()` take a plain list of FX rates
 * and never touch the DB, so they're trivially testable. A thin DB-backed layer
 * (`loadFxRates`, `getBaseCurrency`, `upsertFxRate`) sits below for the IPC and
 * snapshot callers. Rates are stored as **units of `quote` per ONE unit of
 * `base`** (e.g. base 'USD', quote 'CRC', rate 512.3 → $1 = ₡512.3).
 *
 * Conversion is direction-agnostic: a direct pair, its inverse, or a
 * triangulation through USD all resolve, so a single USD↔foreign snapshot per
 * currency is enough to value the whole portfolio.
 */

export const DEFAULT_BASE_CURRENCY = 'USD'

// Triangulation pivot. The user is US-based and we always snapshot USD↔foreign,
// so any pair resolves through USD even without a direct rate.
const ANCHOR = 'USD'

export type CurrencyMeta = {
  code: string // ISO 4217
  symbol: string
  name: string
  // Fraction digits for DISPLAY. ISO minor units are 2 for most, but CRC/COP
  // céntimos/centavos are effectively obsolete, so we show whole units.
  decimals: number
}

// The currencies Compass knows how to label + format. Anchored on the user's
// real footprint (US/CR/Spain/Colombia/Panama) plus a few common ones. Adding
// a currency here is all it takes to surface it in the Accounts picker.
export const SUPPORTED_CURRENCIES: CurrencyMeta[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 },
  { code: 'CRC', symbol: '₡', name: 'Costa Rican Colón', decimals: 0 },
  { code: 'EUR', symbol: '€', name: 'Euro', decimals: 2 },
  { code: 'COP', symbol: '$', name: 'Colombian Peso', decimals: 0 },
  { code: 'MXN', symbol: '$', name: 'Mexican Peso', decimals: 2 },
  { code: 'GBP', symbol: '£', name: 'British Pound', decimals: 2 },
  { code: 'CAD', symbol: '$', name: 'Canadian Dollar', decimals: 2 }
]

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]))

// Default currency for each transaction `geo` bucket (see finance-geo.ts).
// Panama circulates USD (the balboa is pegged 1:1); OTHER falls back to USD.
export const CURRENCY_BY_GEO: Record<string, string> = {
  CR: 'CRC',
  US: 'USD',
  SPAIN: 'EUR',
  COLOMBIA: 'COP',
  PANAMA: 'USD',
  OTHER: 'USD'
}

/** ISO-4217 default currency for a geo tag. Unknown geos → USD. */
export function currencyForGeo(geo: string | null | undefined): string {
  if (!geo) return DEFAULT_BASE_CURRENCY
  return CURRENCY_BY_GEO[geo] ?? DEFAULT_BASE_CURRENCY
}

/** Normalize a user/import-supplied code to a canonical uppercase form. */
export function normalizeCurrency(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase()
}

export function isSupportedCurrency(code: string | null | undefined): boolean {
  return BY_CODE.has(normalizeCurrency(code))
}

export function currencyMeta(code: string | null | undefined): CurrencyMeta | null {
  return BY_CODE.get(normalizeCurrency(code)) ?? null
}

// ─── Pure conversion ─────────────────────────────────────────────────────────

export type FxRate = {
  date: string // 'YYYY-MM-DD' — as-of day (local)
  base: string // ISO 4217
  quote: string // ISO 4217
  rate: number // units of `quote` per 1 unit of `base`
}

/**
 * Latest valid rate for an ordered (base→quote) pair on or before `asOf`.
 * Ignores non-positive / non-finite rates (garbage from a bad manual entry).
 */
function directRate(rates: FxRate[], base: string, quote: string, asOf: string): number | null {
  let best: FxRate | null = null
  for (const r of rates) {
    if (r.base !== base || r.quote !== quote) continue
    if (r.date > asOf) continue
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue
    if (!best || r.date > best.date) best = r
  }
  return best ? best.rate : null
}

/**
 * Exchange rate to turn 1 unit of `from` into units of `to`, using the latest
 * snapshot on or before `asOf`. Tries a direct pair, then the inverse, then a
 * triangulation through USD. Returns null when no path exists (caller decides
 * how to surface an un-convertible balance — never silently treats it as 1:1).
 *
 * `asOf` defaults to the far future so "give me the latest rate" needs no date.
 */
export function pickRate(
  rates: FxRate[],
  from: string,
  to: string,
  asOf = '9999-12-31'
): number | null {
  const f = normalizeCurrency(from)
  const t = normalizeCurrency(to)
  if (f === t) return 1

  const direct = directRate(rates, f, t, asOf)
  if (direct != null) return direct

  const inverse = directRate(rates, t, f, asOf)
  if (inverse != null && inverse > 0) return 1 / inverse

  // Triangulate via the anchor: from→USD then USD→to. Guarded so the recursion
  // can't loop (each sub-call has the anchor on one side → triangulation skip).
  if (f !== ANCHOR && t !== ANCHOR) {
    const fromAnchor = pickRate(rates, f, ANCHOR, asOf)
    const anchorTo = pickRate(rates, ANCHOR, t, asOf)
    if (fromAnchor != null && anchorTo != null) return fromAnchor * anchorTo
  }
  return null
}

/**
 * Convert `amount` from one currency to another. Returns null (NOT the input)
 * when no rate is available, so callers can flag "unconverted" rather than
 * mislead with an un-exchanged number. Result is rounded to cents.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  rates: FxRate[],
  asOf?: string
): number | null {
  if (!Number.isFinite(amount)) return null
  const rate = pickRate(rates, from, to, asOf)
  if (rate == null) return null
  return Math.round(amount * rate * 100) / 100
}

// ─── DB-backed helpers (impure) ──────────────────────────────────────────────

export type SqliteForFx = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

/** Every stored FX rate, as plain rows for the pure helpers above. */
export function loadFxRates(sqlite: SqliteForFx): FxRate[] {
  try {
    return sqlite.prepare('SELECT date, base, quote, rate FROM fx_rates').all() as FxRate[]
  } catch {
    // `fx_rates` may not exist on a very old DB caught mid-upgrade — degrade to
    // "no rates" (foreign balances surface as unconverted) instead of crashing.
    return []
  }
}

export const BASE_CURRENCY_SETTING_KEY = 'baseCurrency'

/**
 * The user's chosen base currency (the one net worth + forecast roll up to).
 * Reads `app_settings`; falls back to USD when unset or invalid.
 */
export function getBaseCurrency(sqlite: SqliteForFx): string {
  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(BASE_CURRENCY_SETTING_KEY) as { value?: string } | undefined
    const code = normalizeCurrency(row?.value)
    return isSupportedCurrency(code) ? code : DEFAULT_BASE_CURRENCY
  } catch {
    return DEFAULT_BASE_CURRENCY
  }
}

/**
 * Insert-or-replace a single FX rate, keyed by (date, base, quote). Mirrors the
 * upsert idiom used across the finance store so a re-entry / re-fetch for the
 * same day updates in place instead of duplicating.
 */
export function upsertFxRate(
  sqlite: SqliteForFx,
  rate: { date: string; base: string; quote: string; rate: number; source?: string },
  now: number = Date.now()
): void {
  sqlite
    .prepare(
      `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, base, quote)
       DO UPDATE SET rate = excluded.rate, source = excluded.source, fetched_at = excluded.fetched_at`
    )
    .run(
      rate.date,
      normalizeCurrency(rate.base),
      normalizeCurrency(rate.quote),
      rate.rate,
      rate.source ?? 'manual',
      now
    )
}
