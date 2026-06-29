/**
 * CR property / Airbnb P&L + Schedule E depreciation (Phase 11.3).
 *
 * Pure assembly over data Compass already tags: every CR transaction carries
 * `geo`/`purpose` (Phase 4.2) and a `taxTag` (Phase 4.3), and Phase 11.1 added a
 * `currency` so colón-priced rows can be valued in the base currency. This turns
 * those rows into a property P&L (revenue / operating / capex→basis / net) and a
 * cost-basis accumulator, then derives a Schedule E **depreciation schedule**.
 *
 * Sourcing (the tags are the source of truth):
 *   - revenue   = `tax:schedule-e-income` (rental income; user-tagged — the
 *                 auto-classifier never assigns it, so revenue is empty until
 *                 the user tags Airbnb payouts on the Transactions tab)
 *   - operating = `tax:schedule-e-expense` OR (geo CR + purpose `operating`)
 *   - capex     = `tax:capex-airbnb`        OR (geo CR + purpose `capex`)
 *
 * Capex accumulates into the cost basis (NOT expensed); operating is deducted in
 * the year incurred. Amounts convert to base currency at the transaction-date FX
 * rate when available (true historical USD cost), falling back to the latest rate
 * so coverage stays high when only recent rates are on file.
 *
 * DEPRECIATION CAVEAT (jurisdiction-specific — verify at build time): a US
 * taxpayer's *foreign* residential rental is depreciated straight-line under ADS
 * over **30 years** for property placed in service after 2017 (40 before; US
 * domestic residential is 27.5 under GDS). Default is 30; it's configurable.
 * Land is never depreciable — it's excluded from the basis.
 */

import { type FxRate, type SqliteForFx, getBaseCurrency, loadFxRates, pickRate } from './finance-fx'

export const PROPERTY_RECOVERY_YEARS_DEFAULT = 30 // foreign residential ADS (verify)

export type PropertyConfig = {
  placedInService: string | null // ISO 'YYYY-MM-DD' the property went into service
  landValue: number // base currency; excluded from the depreciable basis
  recoveryYears: number // 30 (foreign ADS) | 27.5 (US GDS) | 40 (pre-2018 ADS)
  basisOverride: number | null // base currency; overrides accumulated-capex basis when set
}

export const DEFAULT_PROPERTY_CONFIG: PropertyConfig = {
  placedInService: null,
  landValue: 0,
  recoveryYears: PROPERTY_RECOVERY_YEARS_DEFAULT,
  basisOverride: null
}

export type PropertyPnlYear = {
  year: number
  revenue: number // base currency
  operating: number // base currency, positive = expense magnitude
  capex: number // base currency, positive
  netOperating: number // revenue - operating
}

export type DepreciationYear = {
  year: number
  depreciation: number
  accumulated: number
  remainingBasis: number
}

export type PropertyPnl = {
  baseCurrency: string
  byYear: PropertyPnlYear[]
  totals: { revenue: number; operating: number; capex: number; netOperating: number }
  basisToDate: number // cumulative capex (base currency)
  depreciableBasis: number // basis (override or accumulated capex) minus land
  netYieldOnBasis: number | null // total netOperating / depreciableBasis (null if no basis)
  depreciation: DepreciationYear[]
  unconvertedCount: number // property rows with no usable FX rate (left out of totals)
  config: PropertyConfig
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Depreciation (pure) ─────────────────────────────────────────────────────

/**
 * Straight-line depreciation schedule with the mid-month convention (the row a
 * US Schedule E uses). Year 1 is prorated by the month placed in service —
 * `(12 - month + 0.5) / 12` — and the tail year carries whatever basis remains.
 *
 * Returns [] when there's no in-service date or nothing to depreciate. Pure and
 * injectable; `throughYear` bounds the table (defaults to full recovery).
 */
export function buildDepreciationSchedule(opts: {
  depreciableBasis: number
  placedInService: string | null
  recoveryYears: number
  throughYear?: number
}): DepreciationYear[] {
  const { depreciableBasis, placedInService, recoveryYears } = opts
  if (
    !placedInService ||
    !/^\d{4}-\d{2}-\d{2}$/.test(placedInService) ||
    !(depreciableBasis > 0) ||
    !(recoveryYears > 0)
  ) {
    return []
  }

  const startYear = Number.parseInt(placedInService.slice(0, 4), 10)
  const startMonth = Number.parseInt(placedInService.slice(5, 7), 10) // 1-12
  if (!Number.isFinite(startYear) || startMonth < 1 || startMonth > 12) return []

  const annual = depreciableBasis / recoveryYears
  // Mid-month convention: fraction of the first calendar year in service.
  const firstYearFraction = (12 - startMonth + 0.5) / 12

  // Cap the loop at recoveryYears + 2 (first partial + tail) so a tiny float
  // remainder can't spin forever.
  const maxYears = Math.ceil(recoveryYears) + 2
  const lastYear = opts.throughYear ?? startYear + maxYears

  const out: DepreciationYear[] = []
  let remaining = depreciableBasis
  for (let i = 0; i <= maxYears && startYear + i <= lastYear; i++) {
    if (remaining <= 0) break
    const year = startYear + i
    const raw = i === 0 ? annual * firstYearFraction : annual
    const dep = Math.min(raw, remaining)
    remaining = round2(remaining - dep)
    out.push({
      year,
      depreciation: round2(dep),
      accumulated: round2(depreciableBasis - remaining),
      remainingBasis: remaining
    })
  }
  return out
}

// ─── P&L assembly (DB-backed) ────────────────────────────────────────────────

type PropertyRow = {
  date: string
  amount: number
  currency: string | null
  tax_tag: string
  geo: string | null
  purpose: string | null
}

type Bucket = 'revenue' | 'operating' | 'capex' | null

/** Which P&L bucket a tagged row belongs to (capex wins over operating). */
export function bucketFor(row: {
  tax_tag: string
  geo: string | null
  purpose: string | null
}): Bucket {
  if (row.tax_tag === 'tax:capex-airbnb' || (row.geo === 'CR' && row.purpose === 'capex')) {
    return 'capex'
  }
  if (
    row.tax_tag === 'tax:schedule-e-expense' ||
    (row.geo === 'CR' && row.purpose === 'operating')
  ) {
    return 'operating'
  }
  if (row.tax_tag === 'tax:schedule-e-income') return 'revenue'
  return null
}

/** base value of `amount` at the txn-date rate, falling back to the latest. */
function convertAsOf(
  amount: number,
  currency: string,
  base: string,
  rates: FxRate[],
  date: string
): number | null {
  if (currency === base) return amount
  const rate = pickRate(rates, currency, base, date) ?? pickRate(rates, currency, base)
  if (rate == null) return null
  return amount * rate
}

/**
 * Assemble the property P&L + depreciation. `config` is supplied by the caller
 * (read from app_settings at the IPC boundary). Pure SQLite — no Drizzle.
 */
export function buildPropertyPnl(
  sqlite: SqliteForFx,
  config: PropertyConfig = DEFAULT_PROPERTY_CONFIG
): PropertyPnl {
  const base = getBaseCurrency(sqlite)
  const rates = loadFxRates(sqlite)

  const rows = sqlite
    .prepare(
      `SELECT date, amount, currency, tax_tag, geo, purpose
         FROM finance_transactions
        WHERE tax_tag IN ('tax:schedule-e-income','tax:schedule-e-expense','tax:capex-airbnb')
           OR (geo = 'CR' AND purpose IN ('operating','capex'))`
    )
    .all() as PropertyRow[]

  const byYear = new Map<number, PropertyPnlYear>()
  const ensureYear = (year: number): PropertyPnlYear => {
    let y = byYear.get(year)
    if (!y) {
      y = { year, revenue: 0, operating: 0, capex: 0, netOperating: 0 }
      byYear.set(year, y)
    }
    return y
  }

  let unconvertedCount = 0
  for (const row of rows) {
    const bucket = bucketFor(row)
    if (!bucket) continue
    const year = Number.parseInt(row.date.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    const converted = convertAsOf(
      row.amount,
      (row.currency || base).toUpperCase(),
      base,
      rates,
      row.date
    )
    if (converted == null) {
      unconvertedCount++
      continue
    }
    const y = ensureYear(year)
    if (bucket === 'revenue')
      y.revenue += converted // signed: deposits add, chargebacks subtract
    else if (bucket === 'operating')
      y.operating += -converted // expense magnitude
    else y.capex += -converted
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year)
  for (const y of years) {
    y.revenue = round2(y.revenue)
    y.operating = round2(y.operating)
    y.capex = round2(y.capex)
    y.netOperating = round2(y.revenue - y.operating)
  }

  const totals = years.reduce(
    (acc, y) => ({
      revenue: acc.revenue + y.revenue,
      operating: acc.operating + y.operating,
      capex: acc.capex + y.capex,
      netOperating: acc.netOperating + y.netOperating
    }),
    { revenue: 0, operating: 0, capex: 0, netOperating: 0 }
  )
  totals.revenue = round2(totals.revenue)
  totals.operating = round2(totals.operating)
  totals.capex = round2(totals.capex)
  totals.netOperating = round2(totals.netOperating)

  const basisToDate = totals.capex
  const grossBasis = config.basisOverride != null ? config.basisOverride : basisToDate
  const depreciableBasis = round2(Math.max(0, grossBasis - (config.landValue || 0)))

  const depreciation = buildDepreciationSchedule({
    depreciableBasis,
    placedInService: config.placedInService,
    recoveryYears: config.recoveryYears || PROPERTY_RECOVERY_YEARS_DEFAULT
  })

  // A yield is a ratio (e.g. 0.3125 = 31.25%), so keep 4 decimals — round2 would
  // collapse 31.25% → 31% and mislead.
  const netYieldOnBasis =
    depreciableBasis > 0
      ? Math.round((totals.netOperating / depreciableBasis) * 10000) / 10000
      : null

  return {
    baseCurrency: base,
    byYear: years,
    totals,
    basisToDate,
    depreciableBasis,
    netYieldOnBasis,
    depreciation,
    unconvertedCount,
    config
  }
}

// ─── Config persistence (app_settings) ───────────────────────────────────────

export const PROPERTY_CONFIG_KEYS = {
  placedInService: 'propertyPlacedInService',
  landValue: 'propertyLandValue',
  recoveryYears: 'propertyRecoveryYears',
  basisOverride: 'propertyBasisOverride'
} as const

/** Read the property config from `app_settings`, falling back to the defaults. */
export function getPropertyConfig(sqlite: SqliteForFx): PropertyConfig {
  const read = (key: string): string | null => {
    try {
      const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        | { value?: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }
  const placedRaw = read(PROPERTY_CONFIG_KEYS.placedInService)
  const placedInService = placedRaw && /^\d{4}-\d{2}-\d{2}$/.test(placedRaw) ? placedRaw : null
  const landValue = Number(read(PROPERTY_CONFIG_KEYS.landValue))
  const recoveryYears = Number(read(PROPERTY_CONFIG_KEYS.recoveryYears))
  const basisRaw = read(PROPERTY_CONFIG_KEYS.basisOverride)
  const basisOverride = basisRaw == null || basisRaw === '' ? null : Number(basisRaw)
  return {
    placedInService,
    landValue: Number.isFinite(landValue) && landValue >= 0 ? landValue : 0,
    recoveryYears:
      Number.isFinite(recoveryYears) && recoveryYears > 0
        ? recoveryYears
        : PROPERTY_RECOVERY_YEARS_DEFAULT,
    basisOverride:
      basisOverride != null && Number.isFinite(basisOverride) && basisOverride >= 0
        ? basisOverride
        : null
  }
}

/**
 * Persist a config patch. Validation happens at the IPC boundary; this just
 * writes the provided keys (empty string clears `placedInService`/`basisOverride`).
 */
export function setPropertyConfig(
  sqlite: SqliteForFx,
  patch: Partial<PropertyConfig>,
  now: number = Date.now()
): void {
  const write = (key: string, value: string): void => {
    sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now)
  }
  if ('placedInService' in patch) {
    write(PROPERTY_CONFIG_KEYS.placedInService, patch.placedInService ?? '')
  }
  if ('landValue' in patch) write(PROPERTY_CONFIG_KEYS.landValue, String(patch.landValue ?? 0))
  if ('recoveryYears' in patch) {
    write(
      PROPERTY_CONFIG_KEYS.recoveryYears,
      String(patch.recoveryYears ?? PROPERTY_RECOVERY_YEARS_DEFAULT)
    )
  }
  if ('basisOverride' in patch) {
    write(
      PROPERTY_CONFIG_KEYS.basisOverride,
      patch.basisOverride == null ? '' : String(patch.basisOverride)
    )
  }
}
