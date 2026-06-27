/**
 * Currency formatting for the renderer (Phase 11.1).
 *
 * Compass historically hard-coded `toLocaleString('en-US', { currency: 'USD' })`
 * at every call site. This centralizes it so a value can be rendered in ANY
 * currency the user holds — the colón cost of a CR charge, a euro balance — by
 * passing the ISO-4217 code through to `Intl.NumberFormat`, which knows the
 * symbol + minor units for every currency natively.
 *
 * Self-contained on purpose: the renderer never imports from `electron/`, so the
 * authoritative supported-currency list comes over IPC (`getCurrencySettings`)
 * at runtime; this module only needs sensible formatting defaults.
 */

// Currencies conventionally shown without decimals (large denominations). Used
// as the default fraction-digit policy; callers can override per call.
const ZERO_DECIMAL_CURRENCIES = new Set(['CRC', 'COP', 'JPY', 'KRW', 'CLP', 'VND', 'PYG', 'HUF'])

export type FormatMoneyOptions = {
  /** Override the fraction digits. Defaults to 0 for whole-unit currencies, 2 otherwise. */
  decimals?: number
  /** Compact notation, e.g. "$1.2M" — handy for axis labels / tight tiles. */
  compact?: boolean
  /** Drop the currency symbol/code, returning just the grouped number. */
  noSymbol?: boolean
}

function defaultDecimals(code: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(code.toUpperCase()) ? 0 : 2
}

/**
 * Format an amount in the given ISO-4217 currency. Falls back gracefully for an
 * unknown code (plain number + code suffix) so a bad value never throws in the
 * render path.
 */
export function formatMoney(
  amount: number | null | undefined,
  currency = 'USD',
  opts: FormatMoneyOptions = {}
): string {
  const value = Number.isFinite(amount as number) ? (amount as number) : 0
  const code = (currency || 'USD').toUpperCase()
  const maximumFractionDigits = opts.decimals ?? defaultDecimals(code)

  if (opts.noSymbol) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits,
      ...(opts.compact ? { notation: 'compact' } : {})
    })
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits,
      ...(opts.compact ? { notation: 'compact' } : {})
    }).format(value)
  } catch {
    // Unknown/unsupported currency code → never throw in render.
    return `${value.toLocaleString('en-US', { maximumFractionDigits })} ${code}`
  }
}

/** Signed variant: "+$1,200" / "−$340" — for deltas where direction matters. */
export function formatMoneySigned(
  amount: number | null | undefined,
  currency = 'USD',
  opts: FormatMoneyOptions = {}
): string {
  const value = Number.isFinite(amount as number) ? (amount as number) : 0
  const sign = value < 0 ? '−' : '+'
  return `${sign}${formatMoney(Math.abs(value), currency, opts)}`
}
