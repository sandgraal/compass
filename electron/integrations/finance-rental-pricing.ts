/**
 * Short-term-rental pricing & revenue engine (Phase 10.2 CR Rental Studio —
 * ported from retire-early-hub `utils/rentalPricing.js`). Pure, deterministic,
 * side-effect-free. Turns collected comps + a listing config into a suggested
 * nightly price, a 12-month seasonal revenue projection, and gross→net economics
 * after platform fees, operating costs, and CR tax. Market constants live in
 * `finance-cr-rental-market`.
 */
import {
  CR_SEASONAL_OCC_AMPLITUDE,
  CR_SEASONAL_RATE,
  HOST_ECONOMICS
} from './finance-cr-rental-market'

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] // planning estimate (ignores leap years)

const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export type Comp = {
  nightlyUSD?: number | string | null
  bedrooms?: number | string | null
}

export type Listing = {
  bedrooms?: number | string | null
  positioning?: number | string | null
  amenities?: string[]
}

export type CompStats = {
  count: number
  min: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  max: number | null
  mean: number | null
  perBedroomP50: number | null
}

export type SuggestNightlyResult = {
  suggested: number | null
  low: number | null
  high: number | null
  basis: 'no-comps' | 'median' | 'per-bedroom+median'
  stats: CompStats
}

/** Linear-interpolated percentile of a numeric array. p in [0,1]. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  if (xs.length === 1) return xs[0]
  const idx = clamp(p, 0, 1) * (xs.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return xs[lo]
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)
}

/** Summary statistics over comps' nightly rates, plus a per-bedroom figure. */
export function compStats(comps: Comp[] = []): CompStats {
  const rates = comps.map((c) => num(c.nightlyUSD)).filter((v) => v > 0)
  if (rates.length === 0) {
    return {
      count: 0,
      min: null,
      p25: null,
      p50: null,
      p75: null,
      max: null,
      mean: null,
      perBedroomP50: null
    }
  }
  const perBR = comps
    .map((c) => {
      const r = num(c.nightlyUSD)
      const br = Math.max(1, num(c.bedrooms, 1))
      return r > 0 ? r / br : null
    })
    .filter((v): v is number => v != null)
  const sum = rates.reduce((a, b) => a + b, 0)
  return {
    count: rates.length,
    min: Math.min(...rates),
    p25: percentile(rates, 0.25),
    p50: percentile(rates, 0.5),
    p75: percentile(rates, 0.75),
    max: Math.max(...rates),
    mean: sum / rates.length,
    perBedroomP50: percentile(perBR, 0.5)
  }
}

/**
 * Suggest a nightly price for the listing from the comps: scale the comps'
 * per-bedroom median to the listing's bedroom count, blend with the raw median,
 * then nudge for positioning + an amenity/quality premium.
 */
export function suggestNightly(comps: Comp[] = [], listing: Listing = {}): SuggestNightlyResult {
  const stats = compStats(comps)
  const bedrooms = Math.max(1, num(listing.bedrooms, 2))

  const positioning = clamp(num(listing.positioning, 0), -1, 1)
  const premiumAmenities = ['Pool', 'Mountain view', 'A/C', 'Workspace', 'Hot tub']
  const amenityHits = (listing.amenities || []).filter((a) => premiumAmenities.includes(a)).length
  const amenityLift = clamp(amenityHits * 0.03, 0, 0.12) // up to +12%

  if (stats.count === 0) {
    return { suggested: null, low: null, high: null, basis: 'no-comps', stats }
  }

  // count > 0 guarantees the percentiles are numbers; coalesce to satisfy types.
  const p25 = stats.p25 ?? 0
  const p50 = stats.p50 ?? 0
  const p75 = stats.p75 ?? 0
  const fromPerBR = stats.perBedroomP50 != null ? stats.perBedroomP50 * bedrooms : p50
  const anchor = stats.count >= 3 ? 0.6 * fromPerBR + 0.4 * p50 : p50

  const suggested = anchor * (1 + positioning * 0.15) * (1 + amenityLift)
  const low = stats.count >= 4 ? Math.min(suggested, p25) : suggested * 0.85
  const high = stats.count >= 4 ? Math.max(suggested, p75) : suggested * 1.18

  return {
    suggested: Math.round(suggested),
    low: Math.round(low),
    high: Math.round(high),
    basis: stats.count >= 3 ? 'per-bedroom+median' : 'median',
    stats
  }
}

/** Normalize an array of multipliers so its mean is exactly 1. */
function meanNormalize(arr: number[]): number[] {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  return mean === 0 ? arr.map(() => 1) : arr.map((v) => v / mean)
}

/** Mean-normalized seasonal RATE curve (12 months). */
export function seasonalRateCurve(): number[] {
  return meanNormalize(CR_SEASONAL_RATE)
}

/** Mean-normalized seasonal OCCUPANCY curve — same shape as rate but damped. */
export function seasonalOccCurve(amplitude: number = CR_SEASONAL_OCC_AMPLITUDE): number[] {
  const rate = seasonalRateCurve()
  const damped = rate.map((r) => 1 + (r - 1) * clamp(amplitude, 0, 1))
  return meanNormalize(damped)
}

export type RevenueOpts = {
  nightly?: number | string | null
  occupancy?: number | string | null
  avgStayNights?: number | string | null
  cleaningFeeUSD?: number | string | null
  cleaningCostUSD?: number | string | null
  platformFeePct?: number | string | null
  mgmtFeePct?: number | string | null
  incomeTaxRate?: number | string | null
  deemedDeductionPct?: number | string | null
  vatRatePct?: number | string | null
  fixed?: Record<string, number>
}

export type RevenueMonth = {
  month: number
  nightlyRate: number
  occupancy: number
  nightsBooked: number
  turnovers: number
  roomRevenue: number
  cleaningCollected: number
  vatCollected: number
  platformFee: number
  mgmtFee: number
  cleaningSpend: number
  fixedCosts: number
  crTax: number
  net: number
}

export type RevenueProjection = {
  months: RevenueMonth[]
  annual: {
    grossRoom: number
    grossTotal: number
    vatCollected: number
    platformFees: number
    mgmtFees: number
    cleaningSpend: number
    fixedCosts: number
    crTax: number
    netAfterTax: number
    nightsBooked: number
    occupancyRealized: number
  }
  monthlyNet: number
  effectiveTaxRate: number
  netMarginPct: number
}

/**
 * Full 12-month revenue projection. Cash model: room revenue minus real host
 * cash out (platform fee, cleaning labor, fixed monthly costs, optional mgmt fee)
 * minus CR rental income tax. VAT is guest-collected pass-through, reported not
 * subtracted.
 */
export function revenueProjection(opts: RevenueOpts = {}): RevenueProjection {
  const e = HOST_ECONOMICS
  const nightly = Math.max(0, num(opts.nightly, 0))
  const occupancy = clamp(num(opts.occupancy, e.occupancy), 0, 0.97)
  const avgStay = Math.max(1, num(opts.avgStayNights, e.avgStayNights))
  const cleaningFee = Math.max(0, num(opts.cleaningFeeUSD, e.cleaningFeeUSD))
  const cleaningCost = Math.max(0, num(opts.cleaningCostUSD, e.cleaningCostUSD))
  const platformFeePct = clamp(num(opts.platformFeePct, e.platformFeePct), 0, 0.5)
  const mgmtFeePct = clamp(num(opts.mgmtFeePct, e.mgmtFeePct), 0, 0.5)
  const incomeTaxRate = clamp(num(opts.incomeTaxRate, e.incomeTaxRate), 0, 0.6)
  const deemedDeductionPct = clamp(num(opts.deemedDeductionPct, e.deemedDeductionPct), 0, 1)
  const vatRatePct = clamp(num(opts.vatRatePct, e.vatRatePct), 0, 0.5)

  const fixed = { ...e.fixed, ...(opts.fixed || {}) }
  const monthlyFixed = Object.values(fixed).reduce((a, v) => a + Math.max(0, num(v)), 0)

  const rateCurve = seasonalRateCurve()
  const occCurve = seasonalOccCurve()

  const months: RevenueMonth[] = DAYS_IN_MONTH.map((days, m) => {
    const monthRate = nightly * rateCurve[m]
    const monthOcc = clamp(occupancy * occCurve[m], 0, 0.97)
    const nightsBooked = days * monthOcc
    const turnovers = nightsBooked / avgStay

    const roomRevenue = monthRate * nightsBooked
    const cleaningCollected = cleaningFee * turnovers
    const guestTotal = roomRevenue + cleaningCollected
    const vatCollected = guestTotal * vatRatePct // passed through from guest

    const platformFee = guestTotal * platformFeePct
    const mgmtFee = roomRevenue * mgmtFeePct
    const cleaningSpend = cleaningCost * turnovers

    const taxableBase = (roomRevenue + cleaningCollected) * (1 - deemedDeductionPct)
    const crTax = Math.max(0, taxableBase) * incomeTaxRate

    const cashIn = roomRevenue + cleaningCollected
    const cashOut = platformFee + mgmtFee + cleaningSpend + monthlyFixed + crTax
    const net = cashIn - cashOut

    return {
      month: m,
      nightlyRate: monthRate,
      occupancy: monthOcc,
      nightsBooked,
      turnovers,
      roomRevenue,
      cleaningCollected,
      vatCollected,
      platformFee,
      mgmtFee,
      cleaningSpend,
      fixedCosts: monthlyFixed,
      crTax,
      net
    }
  })

  const sum = (k: keyof RevenueMonth): number => months.reduce((a, mo) => a + mo[k], 0)
  const grossRoom = sum('roomRevenue')
  const grossTotal = grossRoom + sum('cleaningCollected')
  const totalNet = sum('net')
  const totalTax = sum('crTax')

  const annual = {
    grossRoom,
    grossTotal, // room + cleaning collected (guest-paid, ex-VAT)
    vatCollected: sum('vatCollected'),
    platformFees: sum('platformFee'),
    mgmtFees: sum('mgmtFee'),
    cleaningSpend: sum('cleaningSpend'),
    fixedCosts: monthlyFixed * 12,
    crTax: totalTax,
    netAfterTax: totalNet,
    nightsBooked: sum('nightsBooked'),
    occupancyRealized: sum('nightsBooked') / 365
  }

  return {
    months,
    annual,
    monthlyNet: totalNet / 12,
    effectiveTaxRate: grossTotal > 0 ? totalTax / grossTotal : 0,
    netMarginPct: grossTotal > 0 ? totalNet / grossTotal : 0
  }
}

export type Unit = Listing & {
  id?: number | string
  name?: string
  nightlyOverride?: number | string | null
  occupancy?: number | string | null
  avgStayNights?: number | string | null
  cleaningFeeUSD?: number | string | null
  platformFeePct?: number | string | null
  mgmtFeePct?: number | string | null
}

export type UnitEconomics = {
  suggestion: SuggestNightlyResult
  nightly: number
  proj: RevenueProjection
  monthlyNet: number
  annualNet: number
  annualGross: number
}

/** Economics for a single rental unit: suggested price + full revenue projection. */
export function unitEconomics(unit: Unit = {}, comps: Comp[] = []): UnitEconomics {
  const suggestion = suggestNightly(comps, unit)
  const nightly =
    Number(unit.nightlyOverride) > 0 ? Number(unit.nightlyOverride) : suggestion.suggested || 0
  const proj = revenueProjection({
    nightly,
    occupancy: Number(unit.occupancy),
    avgStayNights: Number(unit.avgStayNights),
    cleaningFeeUSD: Number(unit.cleaningFeeUSD),
    platformFeePct: Number(unit.platformFeePct),
    mgmtFeePct: Number(unit.mgmtFeePct)
  })
  return {
    suggestion,
    nightly,
    proj,
    monthlyNet: proj.monthlyNet,
    annualNet: proj.annual.netAfterTax,
    annualGross: proj.annual.grossTotal
  }
}

export type PropertyTotals = {
  per: Array<{ id: number | string | undefined; name: string | undefined } & UnitEconomics>
  monthlyNet: number
  annualNet: number
  annualGross: number
}

/** Sum unit economics across a property's units → combined plan-facing totals. */
export function propertyTotals(units: Unit[] = [], comps: Comp[] = []): PropertyTotals {
  const per = units.map((u) => ({ id: u.id, name: u.name, ...unitEconomics(u, comps) }))
  return {
    per,
    monthlyNet: per.reduce((a, u) => a + u.monthlyNet, 0),
    annualNet: per.reduce((a, u) => a + u.annualNet, 0),
    annualGross: per.reduce((a, u) => a + u.annualGross, 0)
  }
}

/** Detect and normalize an Airbnb listing URL → { valid, roomId, cleanUrl }. */
export function parseAirbnbUrl(raw: unknown): {
  valid: boolean
  roomId: string | null
  cleanUrl: string
} {
  const url = String(raw || '').trim()
  if (!url) return { valid: false, roomId: null, cleanUrl: '' }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`)
  } catch {
    return { valid: false, roomId: null, cleanUrl: url }
  }

  const isAirbnb = /(^|\.)airbnb\.[a-z.]+$/i.test(parsedUrl.hostname)
  const idMatch = isAirbnb ? parsedUrl.pathname.match(/\/rooms\/(?:plus\/)?(\d+)/i) : null
  const roomId = idMatch ? idMatch[1] : null
  const cleanUrl = roomId ? `https://www.airbnb.com/rooms/${roomId}` : url
  return { valid: isAirbnb, roomId, cleanUrl }
}
