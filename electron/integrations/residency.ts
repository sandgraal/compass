/**
 * Days-in-country & residency readiness (Phase 11.5).
 *
 * For a US-based owner of CR property with a cross-border footprint, presence
 * days drive two questions at once: the **US Substantial Presence Test** (am I a
 * US tax resident?) and a future **CR 183-day** residency rule. This assembles
 * per-country day counts from logged travel segments, runs both tests, checks
 * the CR residency-by-investment pathways, and estimates CAJA (CR public health).
 *
 * Model: the user logs trips OUTSIDE their home country (a country + an inclusive
 * date window). Days not covered by any segment count as the home country, so
 * you only record the exceptions. A future calendar / CBP I-94 feed can populate
 * the same `travel_segments` table (`source`).
 *
 * Thresholds are jurisdiction-specific *(verify at filing time)* — kept as named
 * constants. The math is pure + injectable; a thin DB layer does segment CRUD +
 * config and sources the investment default from net worth.
 */

import type { SqliteForFx } from './finance-fx'
import { type SqliteForSnapshot, getNetWorthSnapshot } from './finance-snapshot'

const DAY_MS = 86_400_000

// ─── Day counting (pure) ─────────────────────────────────────────────────────

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Parse 'YYYY-MM-DD' to a UTC epoch (avoids DST drift in day arithmetic). */
function utcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}

/** Calendar days in `year` (365 or 366). */
export function daysInYear(year: number): number {
  return Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS)
}

export type TravelSegment = {
  country: string
  startDate: string // inclusive 'YYYY-MM-DD'
  endDate: string // inclusive 'YYYY-MM-DD'
}

/** Number of a segment's days that fall within `year` (inclusive, clipped). */
export function segmentDaysInYear(seg: TravelSegment, year: number): number {
  if (!isYmd(seg.startDate) || !isYmd(seg.endDate)) return 0
  const start = Math.max(utcDay(seg.startDate), Date.UTC(year, 0, 1))
  const end = Math.min(utcDay(seg.endDate), Date.UTC(year, 11, 31))
  if (end < start) return 0
  return Math.round((end - start) / DAY_MS) + 1
}

/**
 * Days per country for a year, counted as UNIQUE calendar days so overlapping
 * segments can't inflate a total past the year length (which would clamp the
 * home remainder to 0 and skew SPT/CR). Home-country segments are ignored (home
 * is the implicit default = the days no segment covers).
 */
export function dayCountsForYear(
  segments: TravelSegment[],
  homeCountry: string,
  year: number
): Record<string, number> {
  const home = homeCountry.toUpperCase()
  const yearStart = Date.UTC(year, 0, 1)
  const yearEnd = Date.UTC(year, 11, 31)
  const perCountry: Record<string, Set<number>> = {}
  const awayDays = new Set<number>() // unique day-indices abroad (any non-home country)

  for (const seg of segments) {
    const c = (seg.country || '').toUpperCase()
    if (!c || c === home) continue
    if (!isYmd(seg.startDate) || !isYmd(seg.endDate)) continue
    const start = Math.max(utcDay(seg.startDate), yearStart)
    const end = Math.min(utcDay(seg.endDate), yearEnd)
    if (end < start) continue
    let set = perCountry[c]
    if (!set) {
      set = new Set<number>()
      perCountry[c] = set
    }
    for (let t = start; t <= end; t += DAY_MS) {
      const dayIdx = Math.round((t - yearStart) / DAY_MS)
      set.add(dayIdx)
      awayDays.add(dayIdx)
    }
  }

  const byCountry: Record<string, number> = {}
  for (const [c, set] of Object.entries(perCountry)) byCountry[c] = set.size
  byCountry[home] = Math.max(0, daysInYear(year) - awayDays.size)
  return byCountry
}

// ─── US Substantial Presence Test (pure) ─────────────────────────────────────

export const SPT_THRESHOLD = 183 // weighted days (verify)
export const SPT_MIN_CURRENT_YEAR = 31 // must also be ≥31 in the current year (verify)

export type SubstantialPresence = {
  usCurrent: number
  usPrior1: number
  usPrior2: number
  weightedDays: number // current + prior1/3 + prior2/6
  meetsTest: boolean
}

/**
 * US Substantial Presence Test: present ≥31 days this year AND a weighted sum of
 * `thisYear + prior1/3 + prior2/6` ≥ 183. *(Verify; ignores treaty/closer-
 * connection exceptions.)*
 */
export function substantialPresenceTest(
  usCurrent: number,
  usPrior1: number,
  usPrior2: number
): SubstantialPresence {
  const weighted = usCurrent + usPrior1 / 3 + usPrior2 / 6
  return {
    usCurrent,
    usPrior1,
    usPrior2,
    weightedDays: Math.round(weighted * 100) / 100,
    meetsTest: usCurrent >= SPT_MIN_CURRENT_YEAR && weighted >= SPT_THRESHOLD
  }
}

// ─── CR residency (pure) ─────────────────────────────────────────────────────

export const CR_RESIDENCY_DAYS = 183 // verify

export function crResidencyCheck(crDays: number): { days: number; meets: boolean } {
  return { days: crDays, meets: crDays >= CR_RESIDENCY_DAYS }
}

// ─── CR residency-by-income/investment pathways (pure) ───────────────────────

export const PENSIONADO_MONTHLY_USD = 1000 // lifetime pension (verify)
export const RENTISTA_MONTHLY_USD = 2500 // stable unearned income (verify)
export const INVERSIONISTA_USD = 150_000 // qualifying investment incl. property (verify)

export type ResidencyPathway = {
  id: 'pensionado' | 'rentista' | 'inversionista'
  label: string
  requirement: string
  threshold: number
  period: 'monthly' | 'total'
  actual: number
  meets: boolean
}

export function residencyPathways(input: {
  pensionMonthly: number
  rentaMonthly: number
  investmentUsd: number
}): ResidencyPathway[] {
  return [
    {
      id: 'pensionado',
      label: 'Pensionado',
      requirement: 'Lifetime pension',
      threshold: PENSIONADO_MONTHLY_USD,
      period: 'monthly',
      actual: input.pensionMonthly,
      meets: input.pensionMonthly >= PENSIONADO_MONTHLY_USD
    },
    {
      id: 'rentista',
      label: 'Rentista',
      requirement: 'Stable unearned income',
      threshold: RENTISTA_MONTHLY_USD,
      period: 'monthly',
      actual: input.rentaMonthly,
      meets: input.rentaMonthly >= RENTISTA_MONTHLY_USD
    },
    {
      id: 'inversionista',
      label: 'Inversionista',
      requirement: 'Investment incl. property',
      threshold: INVERSIONISTA_USD,
      period: 'total',
      actual: input.investmentUsd,
      meets: input.investmentUsd >= INVERSIONISTA_USD
    }
  ]
}

// ─── CAJA estimate (pure) ────────────────────────────────────────────────────

export const CAJA_RATE_PCT_DEFAULT = 11 // ~7–11% of declared income (verify)

export function cajaEstimate(
  monthlyIncomeUsd: number,
  ratePct: number
): { monthlyUsd: number; annualUsd: number; ratePct: number } {
  const monthly = Math.round(monthlyIncomeUsd * (ratePct / 100) * 100) / 100
  return { monthlyUsd: monthly, annualUsd: Math.round(monthly * 12 * 100) / 100, ratePct }
}

// ─── DB layer ────────────────────────────────────────────────────────────────

export type ResidencyConfig = {
  homeCountry: string
  pensionMonthly: number
  rentaMonthly: number
  investmentUsd: number | null // null → auto from net worth (CR property + manual assets)
  cajaMonthlyIncome: number
  cajaRatePct: number
}

export const RESIDENCY_CONFIG_KEYS: Record<keyof ResidencyConfig, string> = {
  homeCountry: 'residencyHomeCountry',
  pensionMonthly: 'residencyPensionMonthly',
  rentaMonthly: 'residencyRentaMonthly',
  investmentUsd: 'residencyInvestmentUsd',
  cajaMonthlyIncome: 'residencyCajaMonthlyIncome',
  cajaRatePct: 'residencyCajaRatePct'
}

const DEFAULTS: ResidencyConfig = {
  homeCountry: 'US',
  pensionMonthly: 0,
  rentaMonthly: 0,
  investmentUsd: null,
  cajaMonthlyIncome: 0,
  cajaRatePct: CAJA_RATE_PCT_DEFAULT
}

export function listTravelSegments(sqlite: SqliteForFx): Array<{
  id: number
  country: string
  startDate: string
  endDate: string
  notes: string | null
}> {
  return sqlite
    .prepare(
      'SELECT id, country, start_date AS startDate, end_date AS endDate, notes FROM travel_segments ORDER BY start_date DESC'
    )
    .all() as Array<{
    id: number
    country: string
    startDate: string
    endDate: string
    notes: string | null
  }>
}

export function addTravelSegment(
  sqlite: SqliteForFx,
  seg: { country: string; startDate: string; endDate: string; notes?: string | null },
  now: number = Date.now()
): number {
  const info = sqlite
    .prepare(
      "INSERT INTO travel_segments (country, start_date, end_date, notes, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)"
    )
    .run(seg.country.toUpperCase(), seg.startDate, seg.endDate, seg.notes ?? null, now)
  return Number(info.lastInsertRowid)
}

export function deleteTravelSegment(sqlite: SqliteForFx, id: number): void {
  sqlite.prepare('DELETE FROM travel_segments WHERE id = ?').run(id)
}

export function getResidencyConfig(sqlite: SqliteForFx): ResidencyConfig {
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
  const num = (key: keyof ResidencyConfig, fallback: number): number => {
    const raw = read(RESIDENCY_CONFIG_KEYS[key])
    if (raw == null || raw === '') return fallback
    const v = Number(raw)
    return Number.isFinite(v) ? v : fallback
  }
  const homeRaw = read(RESIDENCY_CONFIG_KEYS.homeCountry)
  const investRaw = read(RESIDENCY_CONFIG_KEYS.investmentUsd)
  const investmentUsd =
    investRaw == null || investRaw === '' || !Number.isFinite(Number(investRaw))
      ? null
      : Number(investRaw)
  return {
    homeCountry: homeRaw?.trim() ? homeRaw.trim().toUpperCase() : DEFAULTS.homeCountry,
    pensionMonthly: num('pensionMonthly', DEFAULTS.pensionMonthly),
    rentaMonthly: num('rentaMonthly', DEFAULTS.rentaMonthly),
    investmentUsd,
    cajaMonthlyIncome: num('cajaMonthlyIncome', DEFAULTS.cajaMonthlyIncome),
    cajaRatePct: num('cajaRatePct', DEFAULTS.cajaRatePct)
  }
}

export function setResidencyConfig(
  sqlite: SqliteForFx,
  patch: Partial<ResidencyConfig>,
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
  for (const [k, v] of Object.entries(patch) as Array<[keyof ResidencyConfig, unknown]>) {
    const key = RESIDENCY_CONFIG_KEYS[k]
    if (!key) continue
    if (k === 'homeCountry') {
      if (typeof v === 'string' && v.trim()) write(key, v.trim().toUpperCase())
    } else if (k === 'investmentUsd') {
      write(key, v == null ? '' : String(v))
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      write(key, String(v))
    }
  }
}

/** CR property + manual assets value (base currency) — the inversionista default. */
function defaultInvestmentUsd(sqlite: SqliteForSnapshot): number {
  const snap = getNetWorthSnapshot(sqlite)
  return (
    Math.round(
      snap.byAccount
        .filter((a) => a.assetClass === 'real_estate' || a.assetClass === 'manual_asset')
        .reduce((sum, a) => sum + (a.baseBalance ?? 0), 0) * 100
    ) / 100
  )
}

export type ResidencyYear = {
  year: number
  countries: Array<{ country: string; days: number }>
}

export type ResidencySummary = {
  config: ResidencyConfig
  investmentUsd: number // resolved (override or net-worth default)
  segments: Array<{
    id: number
    country: string
    startDate: string
    endDate: string
    notes: string | null
  }>
  years: ResidencyYear[] // current + 2 prior, sorted desc
  substantialPresence: SubstantialPresence
  crResidency: { days: number; meets: boolean }
  pathways: ResidencyPathway[]
  caja: { monthlyUsd: number; annualUsd: number; ratePct: number }
}

/** Assemble the residency summary. `currentYear` injected for determinism. */
export function buildResidencySummary(
  sqlite: SqliteForFx & SqliteForSnapshot,
  currentYear: number
): ResidencySummary {
  const config = getResidencyConfig(sqlite)
  const segments = listTravelSegments(sqlite)
  const home = config.homeCountry.toUpperCase()

  const yearList = [currentYear, currentYear - 1, currentYear - 2]
  const counts = yearList.map((y) => ({ year: y, counts: dayCountsForYear(segments, home, y) }))

  const usDays = (counts: Record<string, number>): number => counts.US ?? 0
  const crDays = (counts: Record<string, number>): number => counts.CR ?? 0

  const substantialPresence = substantialPresenceTest(
    usDays(counts[0].counts),
    usDays(counts[1].counts),
    usDays(counts[2].counts)
  )
  const crResidency = crResidencyCheck(crDays(counts[0].counts))

  const investmentUsd =
    config.investmentUsd != null ? config.investmentUsd : defaultInvestmentUsd(sqlite)
  const pathways = residencyPathways({
    pensionMonthly: config.pensionMonthly,
    rentaMonthly: config.rentaMonthly,
    investmentUsd
  })
  const caja = cajaEstimate(config.cajaMonthlyIncome, config.cajaRatePct)

  return {
    config,
    investmentUsd,
    segments,
    years: counts.map(({ year, counts }) => ({
      year,
      countries: Object.entries(counts)
        .map(([country, days]) => ({ country, days }))
        .sort((a, b) => b.days - a.days)
    })),
    substantialPresence,
    crResidency,
    pathways,
    caja
  }
}
