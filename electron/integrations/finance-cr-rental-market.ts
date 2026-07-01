/**
 * Costa Rica short-term-rental market reference (Phase 10.2 CR Rental Studio —
 * ported from retire-early-hub `data/crRentalMarket.js`). Safe to commit; no
 * personal data. Planning estimates "as of 2025–2026" that WILL drift — verify
 * nightly rates against live comps and any tax figure with a CR accountant.
 *
 * NOTE: the large UI-only improvement `PLAYBOOK` / `PLAYBOOK_CATEGORIES` are NOT
 * ported here — they are reference content for the Rental Studio "Improve It" tab
 * and will land with that UI.
 */

// ─── Seasonality (Central Valley) ────────────────────────────────────────────
// RATE multipliers, indexed so the 12-month average is ~1.0 (the engine
// re-normalizes to be exact). Inland seasonality is milder than the coast.
export const CR_SEASONAL_RATE: number[] = [
  1.2, // Jan — peak dry
  1.18, // Feb
  1.14, // Mar — Semana Santa / Easter often falls here
  1.06, // Apr
  0.92, // May — green season begins
  0.88, // Jun
  0.96, // Jul — veranillo + northern-summer travel
  0.92, // Aug
  0.82, // Sep — wettest, lowest demand
  0.82, // Oct — wettest, lowest demand
  0.96, // Nov — shoulder, picking back up
  1.16 // Dec — holidays, dry season returns
]

// Occupancy swings more gently than rate; the engine derives a normalized
// occupancy curve from this amplitude factor (0 = flat occupancy year-round).
export const CR_SEASONAL_OCC_AMPLITUDE = 0.5

export const MONTH_LABELS: string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

// ─── Zone baselines (USD/night, furnished STR) ───────────────────────────────
// Rough nightly ranges + a typical occupancy band by area, to sanity-check
// collected comps (your own comps should always win over these).
export type ZoneBaseline = {
  oneBR: [number, number]
  twoBR: [number, number]
  occ: [number, number]
  note: string
}

export const ZONE_BASELINES: Record<string, ZoneBaseline> = {
  Cartago: {
    oneBR: [50, 80],
    twoBR: [70, 110],
    occ: [0.2, 0.3],
    note: 'Provincial capital; steady domestic + basilica pilgrimage demand, limited tourist nightlife. Occupancy runs low (~20–25%).'
  },
  Paraíso: {
    oneBR: [45, 75],
    twoBR: [60, 100],
    occ: [0.2, 0.3],
    note: 'Quieter, lower cost; gateway to Orosi & Lankester gardens.'
  },
  'Orosi Valley': {
    oneBR: [70, 110],
    twoBR: [95, 140],
    occ: [0.22, 0.32],
    note: 'Scenic valley, hot springs, coffee tourism (~$111 ADR) — commands a view premium but thin occupancy.'
  },
  'Tres Ríos': {
    oneBR: [55, 85],
    twoBR: [75, 115],
    occ: [0.28, 0.4],
    note: 'Expat pocket between Cartago & San José; good transit. STR data thin — verify locally.'
  },
  'San Rafael Oreamuno': {
    oneBR: [45, 72],
    twoBR: [62, 100],
    occ: [0.2, 0.3],
    note: 'Residential, cooler highland; appeals to longer-stay guests.'
  },
  'San José': {
    oneBR: [55, 85],
    twoBR: [75, 120],
    occ: [0.35, 0.55],
    note: 'Capital (~$64–74 ADR); highest and steadiest demand, most competition.'
  },
  Escazú: {
    oneBR: [90, 150],
    twoBR: [120, 200],
    occ: [0.3, 0.42],
    note: 'Upscale, business + medical-tourism demand (~$145 ADR); top rates in the valley.'
  },
  'Santa Ana': {
    oneBR: [75, 120],
    twoBR: [100, 165],
    occ: [0.3, 0.45],
    note: 'Affluent, modern (~$107 ADR); corporate relocations and longer stays.'
  },
  Other: {
    oneBR: [45, 90],
    twoBR: [65, 130],
    occ: [0.25, 0.4],
    note: 'Verify against local comps.'
  }
}

export const ZONES: string[] = Object.keys(ZONE_BASELINES)

// ─── Host economics defaults (USD unless noted) — all overridable in the UI ──
export type HostEconomics = {
  occupancy: number
  avgStayNights: number
  cleaningFeeUSD: number
  cleaningCostUSD: number
  platformFeePct: number
  incomeTaxRate: number
  deemedDeductionPct: number
  vatRatePct: number
  fixed: Record<string, number>
  mgmtFeePct: number
}

export const HOST_ECONOMICS: HostEconomics = {
  occupancy: 0.4, // annual avg paid-nights / available-nights — Central Valley blended
  avgStayNights: 4, // average length of stay → drives turnover count
  cleaningFeeUSD: 50, // charged to the guest per stay
  cleaningCostUSD: 45, // what a turnover actually costs you
  platformFeePct: 0.155, // Airbnb host-only fee (CR is not on the ~3% split-fee list)
  // CR small-host "capital inmobiliario" regime: 15% rate on income after a
  // deemed 15% deduction → an effective 12.75% of gross rental income.
  incomeTaxRate: 0.15,
  deemedDeductionPct: 0.15,
  vatRatePct: 0.13, // IVA on lodging (<30-night stays); host-remitted pass-through
  fixed: {
    internet: 50,
    utilitiesDelta: 45,
    supplies: 60,
    softwareTools: 15,
    maintenanceReserve: 60
  },
  mgmtFeePct: 0.0 // optional outsourced full-service management (~20–30% if used)
}

// Plain-language tax notes surfaced in the UI so the numbers read as intentional.
export const CR_RENTAL_TAX_NOTES: string[] = [
  'Rental income from a Costa Rican property is CR-source income — it IS taxable in Costa Rica. This is the key asymmetry vs. the rest of your plan: your US investment income is foreign-source and CR-exempt, but a CR rental is CR-source and CR-taxable.',
  'Small hosts file under the "rentas de capital inmobiliario" regime (Law 9635): a 15% rate with a flat 15%-of-gross deemed deduction and no other expenses — an effective ≈12.75% of gross, filed MONTHLY. Electing the profits regime (requires ≥1 CCSS-registered employee) instead lets you deduct actual expenses.',
  '13% IVA (VAT) applies to stays under 30 nights. Important: the HOST must register (Hacienda form D-140), add the 13% on top of the price, and file/remit it MONTHLY — Airbnb does NOT auto-collect the room-rate VAT in Costa Rica (it only adds VAT to its own service fee).',
  'A 2026 change may have platforms (Airbnb/Vrbo/Booking) withhold 12.75% income tax directly from host payouts and remit it to DGT — effectively pre-paying the income tax above. Effective date unconfirmed; verify before launch.',
  'Register in two places: ICT\'s "Hospedaje No Tradicional" registry (Ley 9742, mandatory, free) and DGT/Hacienda for tax. Most cantons also require a municipal patente (~$200–800/yr, canton-specific) — and confirm local zoning permits short-term rentals.',
  'As a US citizen you still report worldwide rental income on your US return (Schedule E). A foreign tax credit for CR tax paid usually keeps the extra US tax small, but not always zero — coordinate with an expat CPA.'
]
