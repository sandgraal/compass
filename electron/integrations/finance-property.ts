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
  // Service-address substring that narrows which Arcadia utility bills (Phase 10.9)
  // attribute to this property. null = every ingested bill is a candidate.
  utilityAddress: string | null
  // OPT-IN: Arcadia bills carry no geo/purpose scoping — they may be PERSONAL home
  // utilities, and this P&L is a rental-property Schedule E. Bills are therefore only
  // ADDED to the operating-expense math when this is true; they always surface
  // informationally in `PropertyPnl.utilityBills` regardless.
  includeUtilityBillsInPnl: boolean
}

export const DEFAULT_PROPERTY_CONFIG: PropertyConfig = {
  placedInService: null,
  landValue: 0,
  recoveryYears: PROPERTY_RECOVERY_YEARS_DEFAULT,
  basisOverride: null,
  utilityAddress: null,
  includeUtilityBillsInPnl: false
}

export type PropertyPnlYear = {
  year: number
  revenue: number // base currency
  operating: number // base currency, positive = expense magnitude (INCLUDES utilities)
  utilities: number // base currency, positive — the utilities portion of `operating` (Arcadia)
  capex: number // base currency, positive
  netOperating: number // revenue - operating
}

export type DepreciationYear = {
  year: number
  depreciation: number
  accumulated: number
  remainingBasis: number
}

// Informational Arcadia utility-bill rollup — ALWAYS present on the P&L output,
// whether or not the bills are included in the operating-expense math.
export type UtilityBillsSummary = {
  byYear: Array<{ year: number; total: number; count: number }> // base currency
  total: number // base currency, all years
  count: number // bills summarized (convertible amount + valid statement date)
  providers: string[] // distinct utility companies, sorted
  // Bills SKIPPED from the operating-expense math because an already-counted
  // operating transaction matched (same currency + absolute amount to the cent,
  // within ±4 days) — the bank payment is already on the P&L. Only non-zero when
  // `includeUtilityBillsInPnl` is on; skipped bills still count informationally.
  deduped: number
  includedInOperating: boolean // echo of config.includeUtilityBillsInPnl
}

export type PropertyPnl = {
  baseCurrency: string
  byYear: PropertyPnlYear[]
  totals: {
    revenue: number
    operating: number
    utilities: number
    capex: number
    netOperating: number
  }
  basisToDate: number // cumulative capex (base currency)
  depreciableBasis: number // basis (override or accumulated capex) minus land
  netYieldOnBasis: number | null // total netOperating / depreciableBasis (null if no basis)
  depreciation: DepreciationYear[]
  unconvertedCount: number // property rows with no usable FX rate (left out of totals)
  utilityBills: UtilityBillsSummary
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

type UtilityBillPnlRow = {
  provider: string | null
  statementDate: string | null
  amount: number | null
  currency: string | null
}

/**
 * Read Arcadia utility bills that attribute to the property: all of them when no
 * service-address filter is configured (Arcadia bills carry no other scoping), or the
 * case-insensitive-substring matches when one is. Empty on older installs (table-less).
 */
function readUtilityBills(sqlite: SqliteForFx, addressFilter: string | null): UtilityBillPnlRow[] {
  // INSTR gives a TRUE substring match — LIKE would treat `%`/`_` in a user-entered
  // address as wildcards and mis-attribute bills.
  const needle = addressFilter?.trim().toLowerCase() ?? ''
  try {
    return sqlite
      .prepare(
        `SELECT provider, statement_date AS statementDate, amount, currency
           FROM utility_bills
          WHERE amount IS NOT NULL AND statement_date IS NOT NULL
            AND (? = '' OR INSTR(LOWER(COALESCE(service_address, '')), ?) > 0)`
      )
      .all(needle, needle) as UtilityBillPnlRow[]
  } catch {
    return []
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEDUP_WINDOW_DAYS = 4

/** A counted operating transaction, kept for the utility-bill dedup check. */
type OperatingTxnKey = {
  timeMs: number // Date.parse of the local-day 'YYYY-MM-DD' (UTC midnight — consistent)
  currency: string // upper-cased original currency
  absCents: number // absolute original amount, rounded to cents
}

/**
 * Dedup heuristic (deliberately simple): a bill is considered already-on-the-P&L when
 * some counted operating transaction has the SAME currency, the SAME absolute amount
 * rounded to cents, and a date within ±4 days of the statement date — i.e. the bank
 * payment of that bill was tagged and counted, so adding the statement too would
 * double-count the expense.
 */
function matchesCountedOperatingTxn(
  bill: { timeMs: number; currency: string; absCents: number },
  counted: OperatingTxnKey[]
): boolean {
  return counted.some(
    (t) =>
      t.currency === bill.currency &&
      t.absCents === bill.absCents &&
      Math.abs(t.timeMs - bill.timeMs) <= DEDUP_WINDOW_DAYS * DAY_MS
  )
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
      y = { year, revenue: 0, operating: 0, utilities: 0, capex: 0, netOperating: 0 }
      byYear.set(year, y)
    }
    return y
  }

  let unconvertedCount = 0
  const countedOperatingTxns: OperatingTxnKey[] = []
  for (const row of rows) {
    const bucket = bucketFor(row)
    if (!bucket) continue
    const year = Number.parseInt(row.date.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    const currency = (row.currency || base).toUpperCase()
    const converted = convertAsOf(row.amount, currency, base, rates, row.date)
    if (converted == null) {
      unconvertedCount++
      continue
    }
    const y = ensureYear(year)
    if (bucket === 'revenue') {
      y.revenue += converted // signed: deposits add, chargebacks subtract
    } else if (bucket === 'operating') {
      y.operating += -converted // expense magnitude
      const timeMs = Date.parse(row.date)
      if (Number.isFinite(timeMs)) {
        countedOperatingTxns.push({
          timeMs,
          currency,
          absCents: Math.round(Math.abs(row.amount) * 100)
        })
      }
    } else y.capex += -converted
  }

  // Utility bills (Arcadia, Phase 10.9) — ALWAYS summarized informationally (per-year
  // totals + counts + providers), narrowed to the configured service address when one is
  // set. They are only ADDED to `operating` (and the visible `utilities` sub-total) when
  // the user opted in via `includeUtilityBillsInPnl` — bills carry no geo/purpose scoping,
  // so auto-adding possibly-personal utilities would corrupt the Schedule E. When included,
  // bills matching an already-counted operating transaction are skipped (see
  // `matchesCountedOperatingTxn`) and reported as `deduped`.
  const include = config.includeUtilityBillsInPnl
  const utilityByYear = new Map<number, { year: number; total: number; count: number }>()
  const providerSet = new Set<string>()
  let utilityDeduped = 0
  for (const b of readUtilityBills(sqlite, config.utilityAddress)) {
    if (b.amount == null || !b.statementDate) continue
    const year = Number.parseInt(b.statementDate.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    const currency = (b.currency || base).toUpperCase()
    const converted = convertAsOf(b.amount, currency, base, rates, b.statementDate)
    if (converted == null) {
      if (include) unconvertedCount++ // only surfaces as excluded-from-P&L when opted in
      continue
    }
    let u = utilityByYear.get(year)
    if (!u) {
      u = { year, total: 0, count: 0 }
      utilityByYear.set(year, u)
    }
    u.total += converted
    u.count++
    if (b.provider?.trim()) providerSet.add(b.provider.trim())
    if (!include) continue
    const timeMs = Date.parse(b.statementDate)
    if (
      Number.isFinite(timeMs) &&
      matchesCountedOperatingTxn(
        { timeMs, currency, absCents: Math.round(Math.abs(b.amount) * 100) },
        countedOperatingTxns
      )
    ) {
      utilityDeduped++
      continue
    }
    const y = ensureYear(year)
    y.operating += converted // positive = expense magnitude
    y.utilities += converted
  }

  const utilityYears = [...utilityByYear.values()].sort((a, b) => a.year - b.year)
  for (const u of utilityYears) u.total = round2(u.total)
  const utilityBills: UtilityBillsSummary = {
    byYear: utilityYears,
    total: round2(utilityYears.reduce((s, u) => s + u.total, 0)),
    count: utilityYears.reduce((s, u) => s + u.count, 0),
    providers: [...providerSet].sort((a, b) => a.localeCompare(b)),
    deduped: utilityDeduped,
    includedInOperating: include
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year)
  for (const y of years) {
    y.revenue = round2(y.revenue)
    y.operating = round2(y.operating)
    y.utilities = round2(y.utilities)
    y.capex = round2(y.capex)
    y.netOperating = round2(y.revenue - y.operating)
  }

  const totals = years.reduce(
    (acc, y) => ({
      revenue: acc.revenue + y.revenue,
      operating: acc.operating + y.operating,
      utilities: acc.utilities + y.utilities,
      capex: acc.capex + y.capex,
      netOperating: acc.netOperating + y.netOperating
    }),
    { revenue: 0, operating: 0, utilities: 0, capex: 0, netOperating: 0 }
  )
  totals.revenue = round2(totals.revenue)
  totals.operating = round2(totals.operating)
  totals.utilities = round2(totals.utilities)
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
    utilityBills,
    config
  }
}

// ─── Config persistence (app_settings) ───────────────────────────────────────

export const PROPERTY_CONFIG_KEYS = {
  placedInService: 'propertyPlacedInService',
  landValue: 'propertyLandValue',
  recoveryYears: 'propertyRecoveryYears',
  basisOverride: 'propertyBasisOverride',
  utilityAddress: 'propertyUtilityAddress',
  includeUtilityBillsInPnl: 'propertyIncludeUtilityBills'
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
  const utilityAddress = read(PROPERTY_CONFIG_KEYS.utilityAddress)
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
        : null,
    utilityAddress: utilityAddress?.trim() ? utilityAddress.trim() : null,
    // opt-in, so anything but an explicit 'true' (incl. missing) means false
    includeUtilityBillsInPnl: read(PROPERTY_CONFIG_KEYS.includeUtilityBillsInPnl) === 'true'
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
  if ('utilityAddress' in patch) {
    write(PROPERTY_CONFIG_KEYS.utilityAddress, patch.utilityAddress ?? '')
  }
  if ('includeUtilityBillsInPnl' in patch) {
    write(
      PROPERTY_CONFIG_KEYS.includeUtilityBillsInPnl,
      patch.includeUtilityBillsInPnl ? 'true' : 'false'
    )
  }
}
