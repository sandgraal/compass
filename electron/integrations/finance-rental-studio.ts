/**
 * CR Rental Studio backend (Phase 10.2) — persists the comps the user collects
 * (the `rental_comps` table) + their listing units and studio settings (JSON in
 * `app_settings`), and assembles the plan-facing totals from the pure pricing
 * engine (`finance-rental-pricing`).
 *
 * Forward vs backward: this studio PROJECTS revenue from comps + a listing
 * config; `finance-property.buildPropertyPnl` reports the BACKWARD-looking actual
 * P&L from tagged transactions. `buildRentalStudio` surfaces a reconciliation so
 * the two never diverge silently — and the studio's projected annual net is what
 * feeds the retirement engine's Airbnb income (wired at the IPC boundary).
 */
import { type SqliteForFx, getBaseCurrency } from './finance-fx'
import { buildPropertyPnl, getPropertyConfig } from './finance-property'
import { type Comp, type PropertyTotals, type Unit, propertyTotals } from './finance-rental-pricing'

export type SqliteForStudio = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ─── Comps (rental_comps table) ──────────────────────────────────────────────

export type CompRow = {
  id: number
  name: string
  url: string
  zone: string
  bedrooms: number
  nightlyUsd: number | null
  occupancyPct: number | null
  rating: number | null
  reviewCount: number | null
  notes: string | null
  savedAt: string | null
}

export type CompInput = {
  name?: string
  url?: string
  zone?: string
  bedrooms?: number
  nightlyUsd?: number | null
  occupancyPct?: number | null
  rating?: number | null
  reviewCount?: number | null
  notes?: string | null
  savedAt?: string | null
}

export function listComps(sqlite: SqliteForStudio): CompRow[] {
  return sqlite
    .prepare(
      `SELECT id, name, url, zone, bedrooms, nightly_usd AS nightlyUsd,
              occupancy_pct AS occupancyPct, rating, review_count AS reviewCount,
              notes, saved_at AS savedAt
         FROM rental_comps
        ORDER BY id ASC`
    )
    .all() as CompRow[]
}

export function addComp(
  sqlite: SqliteForStudio,
  input: CompInput,
  now: number = Date.now()
): number {
  const info = sqlite
    .prepare(
      `INSERT INTO rental_comps
         (name, url, zone, bedrooms, nightly_usd, occupancy_pct, rating, review_count, notes, saved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name ?? '',
      input.url ?? '',
      input.zone ?? 'Cartago',
      input.bedrooms ?? 2,
      input.nightlyUsd ?? null,
      input.occupancyPct ?? null,
      input.rating ?? null,
      input.reviewCount ?? null,
      input.notes ?? null,
      input.savedAt ?? null,
      now,
      now
    )
  return Number(info.lastInsertRowid)
}

export function updateComp(
  sqlite: SqliteForStudio,
  id: number,
  patch: CompInput,
  now: number = Date.now()
): void {
  const cols: Array<[string, unknown]> = []
  if ('name' in patch) cols.push(['name', patch.name ?? ''])
  if ('url' in patch) cols.push(['url', patch.url ?? ''])
  if ('zone' in patch) cols.push(['zone', patch.zone ?? 'Cartago'])
  if ('bedrooms' in patch) cols.push(['bedrooms', patch.bedrooms ?? 2])
  if ('nightlyUsd' in patch) cols.push(['nightly_usd', patch.nightlyUsd ?? null])
  if ('occupancyPct' in patch) cols.push(['occupancy_pct', patch.occupancyPct ?? null])
  if ('rating' in patch) cols.push(['rating', patch.rating ?? null])
  if ('reviewCount' in patch) cols.push(['review_count', patch.reviewCount ?? null])
  if ('notes' in patch) cols.push(['notes', patch.notes ?? null])
  if ('savedAt' in patch) cols.push(['saved_at', patch.savedAt ?? null])
  if (cols.length === 0) return
  cols.push(['updated_at', now])
  const setSql = cols.map(([c]) => `${c} = ?`).join(', ')
  sqlite
    .prepare(`UPDATE rental_comps SET ${setSql} WHERE id = ?`)
    .run(...cols.map(([, v]) => v), id)
}

export function deleteComp(sqlite: SqliteForStudio, id: number): void {
  sqlite.prepare('DELETE FROM rental_comps WHERE id = ?').run(id)
}

// ─── Units + settings (JSON in app_settings) ─────────────────────────────────

const UNITS_KEY = 'rentalStudioUnits'
const SETTINGS_KEY = 'rentalStudioSettings'

export type StudioSettings = {
  includeInPlan: boolean // feed the projected net into the retirement engine
  rentalYears: number // # of retirement years the rental income is assumed to run
}

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = { includeInPlan: true, rentalYears: 20 }

function readSetting(sqlite: SqliteForStudio, key: string): string | null {
  try {
    const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeSetting(sqlite: SqliteForStudio, key: string, value: string, now: number): void {
  sqlite
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, now)
}

export function getUnits(sqlite: SqliteForStudio): Unit[] {
  const raw = readSetting(sqlite, UNITS_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as Unit[]) : []
  } catch {
    return []
  }
}

export function setUnits(sqlite: SqliteForStudio, units: Unit[], now: number = Date.now()): void {
  writeSetting(sqlite, UNITS_KEY, JSON.stringify(Array.isArray(units) ? units : []), now)
}

export function getSettings(sqlite: SqliteForStudio): StudioSettings {
  const raw = readSetting(sqlite, SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_STUDIO_SETTINGS }
  try {
    const o = JSON.parse(raw) as Partial<StudioSettings>
    return {
      includeInPlan:
        typeof o.includeInPlan === 'boolean'
          ? o.includeInPlan
          : DEFAULT_STUDIO_SETTINGS.includeInPlan,
      rentalYears: Number.isFinite(Number(o.rentalYears))
        ? Number(o.rentalYears)
        : DEFAULT_STUDIO_SETTINGS.rentalYears
    }
  } catch {
    return { ...DEFAULT_STUDIO_SETTINGS }
  }
}

export function setSettings(
  sqlite: SqliteForStudio,
  patch: Partial<StudioSettings>,
  now: number = Date.now()
): void {
  const next = { ...getSettings(sqlite), ...patch }
  writeSetting(sqlite, SETTINGS_KEY, JSON.stringify(next), now)
}

// ─── Assembly + reconciliation ───────────────────────────────────────────────

export type RentalStudioResult = {
  baseCurrency: string
  comps: CompRow[]
  units: Unit[]
  settings: StudioSettings
  totals: PropertyTotals
  reconciliation: {
    studioAnnualNet: number // forward projection from comps + units (USD)
    actualsNetOperating: number // backward actuals from tagged txns (latest year, base ccy)
    actualsYear: number | null
    deltaPct: number | null // (projected − actual) / |actual|; null when there are no actuals
    note: string
  }
}

/**
 * The projected annual net the retirement engine should use (0 when the studio
 * is toggled off the plan). Used by the IPC layer to sync `airbnbAnnualNet`.
 */
export function studioPlanAnnualNet(sqlite: SqliteForFx & SqliteForStudio): number {
  const settings = getSettings(sqlite)
  if (!settings.includeInPlan) return 0
  const comps: Comp[] = listComps(sqlite).map((c) => ({
    nightlyUSD: c.nightlyUsd,
    bedrooms: c.bedrooms
  }))
  return round2(propertyTotals(getUnits(sqlite), comps).annualNet)
}

/** Assemble the studio view: comps + units + settings + totals + reconciliation. */
export function buildRentalStudio(sqlite: SqliteForFx & SqliteForStudio): RentalStudioResult {
  const baseCurrency = getBaseCurrency(sqlite)
  const comps = listComps(sqlite)
  const units = getUnits(sqlite)
  const settings = getSettings(sqlite)
  const engineComps: Comp[] = comps.map((c) => ({ nightlyUSD: c.nightlyUsd, bedrooms: c.bedrooms }))
  const totals = propertyTotals(units, engineComps)

  const pnl = buildPropertyPnl(sqlite, getPropertyConfig(sqlite))
  const latest = pnl.byYear.length
    ? pnl.byYear.reduce((a, b) => (b.year > a.year ? b : a), pnl.byYear[0])
    : null
  const actualsNetOperating = latest ? round2(latest.netOperating) : 0
  const actualsYear = latest ? latest.year : null
  const studioAnnualNet = round2(totals.annualNet)
  const deltaPct =
    actualsNetOperating !== 0
      ? round4((studioAnnualNet - actualsNetOperating) / Math.abs(actualsNetOperating))
      : null

  // The actuals read $0 until the user tags Airbnb payouts — the property P&L's
  // auto-classifier never assigns `tax:schedule-e-income`. Say so, rather than
  // implying a divergence.
  const note =
    actualsNetOperating === 0
      ? 'No tagged Schedule-E rental income yet — tag your Airbnb payouts as `tax:schedule-e-income` so the actual P&L can reconcile against this projection.'
      : `Projecting ${studioAnnualNet.toLocaleString()} ${baseCurrency}/yr net vs ${actualsYear} actual net operating ${actualsNetOperating.toLocaleString()} ${baseCurrency}.`

  return {
    baseCurrency,
    comps,
    units,
    settings,
    totals,
    reconciliation: { studioAnnualNet, actualsNetOperating, actualsYear, deltaPct, note }
  }
}
