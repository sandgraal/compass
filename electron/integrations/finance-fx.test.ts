import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BASE_CURRENCY_SETTING_KEY,
  CURRENCY_BY_GEO,
  DEFAULT_BASE_CURRENCY,
  type FxRate,
  convert,
  currencyForGeo,
  currencyMeta,
  getBaseCurrency,
  isSupportedCurrency,
  loadFxRates,
  normalizeCurrency,
  pickRate,
  upsertFxRate
} from './finance-fx'

// $1 = ₡512.3, $1 = €0.92, $1 = ₡COP 4000
const RATES: FxRate[] = [
  { date: '2026-06-25', base: 'USD', quote: 'CRC', rate: 500 },
  { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 512.3 },
  { date: '2026-06-27', base: 'USD', quote: 'EUR', rate: 0.92 },
  { date: '2026-06-27', base: 'USD', quote: 'COP', rate: 4000 }
]

describe('currency metadata', () => {
  it('maps every geo bucket to a supported currency', () => {
    for (const code of Object.values(CURRENCY_BY_GEO)) {
      expect(isSupportedCurrency(code)).toBe(true)
    }
  })

  it('defaults CR to colones and US/Panama to dollars', () => {
    expect(currencyForGeo('CR')).toBe('CRC')
    expect(currencyForGeo('US')).toBe('USD')
    expect(currencyForGeo('PANAMA')).toBe('USD')
    expect(currencyForGeo('SPAIN')).toBe('EUR')
    expect(currencyForGeo('COLOMBIA')).toBe('COP')
  })

  it('falls back to USD for unknown / missing geo', () => {
    expect(currencyForGeo('ATLANTIS')).toBe('USD')
    expect(currencyForGeo(null)).toBe('USD')
    expect(currencyForGeo(undefined)).toBe('USD')
  })

  it('normalizes codes and validates membership', () => {
    expect(normalizeCurrency(' crc ')).toBe('CRC')
    expect(isSupportedCurrency('crc')).toBe(true)
    expect(isSupportedCurrency('XYZ')).toBe(false)
    expect(currencyMeta('crc')?.symbol).toBe('₡')
    expect(currencyMeta('nope')).toBeNull()
  })
})

describe('pickRate', () => {
  it('returns 1 for identical currencies (case/space-insensitive)', () => {
    expect(pickRate(RATES, 'USD', 'USD')).toBe(1)
    expect(pickRate(RATES, 'usd', ' USD ')).toBe(1)
  })

  it('resolves a direct pair using the latest rate on or before today', () => {
    expect(pickRate(RATES, 'USD', 'CRC')).toBeCloseTo(512.3, 5)
  })

  it('honors as-of: picks the rate that held on an earlier day', () => {
    expect(pickRate(RATES, 'USD', 'CRC', '2026-06-26')).toBe(500)
    // Before any snapshot exists → null.
    expect(pickRate(RATES, 'USD', 'CRC', '2026-06-01')).toBeNull()
  })

  it('inverts when only the opposite direction is stored', () => {
    const rate = pickRate(RATES, 'CRC', 'USD')
    expect(rate).toBeCloseTo(1 / 512.3, 8)
  })

  it('triangulates a foreign→foreign pair through USD', () => {
    // CRC → EUR = (1/512.3 USD per CRC) * (0.92 EUR per USD)
    const rate = pickRate(RATES, 'CRC', 'EUR')
    expect(rate).toBeCloseTo((1 / 512.3) * 0.92, 8)
  })

  it('returns null when no path exists', () => {
    expect(pickRate(RATES, 'USD', 'JPY')).toBeNull()
    expect(pickRate([], 'USD', 'CRC')).toBeNull()
  })

  it('ignores non-positive / non-finite stored rates', () => {
    const bad: FxRate[] = [
      { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 0 },
      { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: Number.NaN }
    ]
    expect(pickRate(bad, 'USD', 'CRC')).toBeNull()
  })
})

describe('convert', () => {
  it('converts a colón amount to its USD value, rounded to cents', () => {
    // ₡512.30 / 512.3 = $1.00
    expect(convert(512.3, 'CRC', 'USD', RATES)).toBe(1)
    // ₡100,000 / 512.3 ≈ $195.20
    expect(convert(100_000, 'CRC', 'USD', RATES)).toBeCloseTo(195.2, 1)
  })

  it('converts USD into a foreign currency', () => {
    expect(convert(10, 'USD', 'CRC', RATES)).toBe(5123)
  })

  it('returns the same amount for a same-currency conversion', () => {
    expect(convert(42.5, 'USD', 'USD', RATES)).toBe(42.5)
  })

  it('returns null when no rate is available (never a 1:1 guess)', () => {
    expect(convert(100, 'USD', 'JPY', RATES)).toBeNull()
  })

  it('returns null for a non-finite amount', () => {
    expect(convert(Number.POSITIVE_INFINITY, 'USD', 'CRC', RATES)).toBeNull()
  })
})

// ─── DB-backed helpers ───────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      base TEXT NOT NULL,
      quote TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      fetched_at INTEGER
    );
    CREATE UNIQUE INDEX uq_fx_rates_date_base_quote ON fx_rates (date, base, quote);
  `)
  return sqlite
}

let sqlite: Database.Database

beforeEach(() => {
  sqlite = makeDb()
})

describe('getBaseCurrency', () => {
  it('defaults to USD when unset', () => {
    expect(getBaseCurrency(sqlite)).toBe(DEFAULT_BASE_CURRENCY)
  })

  it('reads + normalizes a stored base currency', () => {
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run(BASE_CURRENCY_SETTING_KEY, ' eur ')
    expect(getBaseCurrency(sqlite)).toBe('EUR')
  })

  it('ignores an unsupported stored value', () => {
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run(BASE_CURRENCY_SETTING_KEY, 'XYZ')
    expect(getBaseCurrency(sqlite)).toBe('USD')
  })
})

describe('upsertFxRate + loadFxRates', () => {
  it('inserts then round-trips through the pure helpers', () => {
    upsertFxRate(sqlite, { date: '2026-06-27', base: 'usd', quote: 'crc', rate: 512.3 })
    const rates = loadFxRates(sqlite)
    expect(rates).toHaveLength(1)
    expect(rates[0]).toMatchObject({ base: 'USD', quote: 'CRC', rate: 512.3 })
    expect(convert(512.3, 'CRC', 'USD', rates)).toBe(1)
  })

  it('replaces in place on a same-day re-entry (idempotent key)', () => {
    upsertFxRate(sqlite, { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 500 })
    upsertFxRate(sqlite, { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 512.3 })
    const rows = sqlite.prepare('SELECT rate FROM fx_rates').all() as Array<{ rate: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].rate).toBe(512.3)
  })

  it('keeps separate rows per day (history for FX gain/loss)', () => {
    upsertFxRate(sqlite, { date: '2026-06-25', base: 'USD', quote: 'CRC', rate: 500 })
    upsertFxRate(sqlite, { date: '2026-06-27', base: 'USD', quote: 'CRC', rate: 512.3 })
    const rates = loadFxRates(sqlite)
    expect(rates).toHaveLength(2)
    expect(pickRate(rates, 'USD', 'CRC', '2026-06-26')).toBe(500)
    expect(pickRate(rates, 'USD', 'CRC')).toBe(512.3)
  })
})
