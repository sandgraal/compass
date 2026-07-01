/**
 * Static reference constants for the retirement engine (Phase 11.4 — ported from
 * the standalone retire-early-hub `data/taxBrackets.js`).
 *
 * These are PUBLIC reference figures (IRS brackets, IRS RMD/SEPP context, CR
 * territorial-tax schedule), not personal data. All personal seed values that the
 * standalone app kept in a gitignored `personal.local.js` are DROPPED here — in
 * Compass the real numbers come from the DB (net-worth snapshot, property config,
 * app_settings), so the engine defaults are neutral (see `finance-retire-engine`).
 *
 * TAX-YEAR CAVEAT: the brackets/deductions below are 2025 statics. They are
 * inflation-indexed, so by a late-2020s retirement year they will be materially
 * higher — re-verify annually. Sources are cited inline.
 */

export type FilingStatus = 'single' | 'mfj'

export type TaxBracket = { min: number; max: number; rate: number }
export type CrTaxBracket = TaxBracket & { label: string }

// 2025 US Federal ordinary-income brackets.
export const BRACKETS_2025: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 11_925, rate: 0.1 },
    { min: 11_925, max: 48_475, rate: 0.12 },
    { min: 48_475, max: 103_350, rate: 0.22 },
    { min: 103_350, max: 197_300, rate: 0.24 },
    { min: 197_300, max: 250_525, rate: 0.32 },
    { min: 250_525, max: 626_350, rate: 0.35 },
    { min: 626_350, max: Number.POSITIVE_INFINITY, rate: 0.37 }
  ],
  mfj: [
    { min: 0, max: 23_850, rate: 0.1 },
    { min: 23_850, max: 96_950, rate: 0.12 },
    { min: 96_950, max: 206_700, rate: 0.22 },
    { min: 206_700, max: 394_600, rate: 0.24 },
    { min: 394_600, max: 501_050, rate: 0.32 },
    { min: 501_050, max: 751_600, rate: 0.35 },
    { min: 751_600, max: Number.POSITIVE_INFINITY, rate: 0.37 }
  ]
}

// 2025 standard deduction AS AMENDED by the One Big Beautiful Bill Act
// (P.L. 119-21): $15,750 single / $31,500 MFJ. Inflation-indexed — re-verify.
// Source: IRS (https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors)
export const STANDARD_DEDUCTION_2025: Record<FilingStatus, number> = {
  single: 15_750,
  mfj: 31_500
}

// 2025 Long-Term Capital Gains brackets.
export const LTCG_BRACKETS_2025: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 48_350, rate: 0.0 },
    { min: 48_350, max: 533_400, rate: 0.15 },
    { min: 533_400, max: Number.POSITIVE_INFINITY, rate: 0.2 }
  ],
  mfj: [
    { min: 0, max: 96_700, rate: 0.0 },
    { min: 96_700, max: 600_050, rate: 0.15 },
    { min: 600_050, max: Number.POSITIVE_INFINITY, rate: 0.2 }
  ]
}

// Net Investment Income Tax — 3.8% on investment income above the threshold.
export const NIIT = {
  rate: 0.038,
  thresholdSingle: 200_000,
  thresholdMFJ: 250_000
} as const

// Florida (and most no-income-tax states relevant to an expat) — 0%.
export const FL_STATE_TAX_RATE = 0

// Costa Rica — territorial taxation: foreign-sourced income (US pension/401k/SS/
// US investment income) is NOT taxed by CR; CR-sourced income (rental, business)
// IS. The schedule below is CR-SOURCED only.
// Source: PwC Tax Summaries, FY2026 (https://taxsummaries.pwc.com/costa-rica/individual/taxes-on-personal-income)
export const CR_TAX: {
  territorial: boolean
  foreignIncomeExempt: boolean
  crSourcedBrackets: CrTaxBracket[]
  vatRate: number
  note: string
} = {
  territorial: true,
  foreignIncomeExempt: true,
  crSourcedBrackets: [
    { min: 0, max: 4_094_000, rate: 0.0, label: '0% (≈$8,100 USD)' }, // CRC/year
    { min: 4_094_000, max: 6_115_000, rate: 0.1, label: '10%' },
    { min: 6_115_000, max: 10_200_000, rate: 0.15, label: '15%' },
    { min: 10_200_000, max: 20_442_000, rate: 0.2, label: '20%' },
    { min: 20_442_000, max: Number.POSITIVE_INFINITY, rate: 0.25, label: '25%' }
  ],
  vatRate: 0.13,
  note: 'CR territorial system: US-sourced income (401k, SS, dividends from US stocks) generally not taxed by CR.'
}

// IRMAA 2025 (Medicare Part B/D surcharge) — surfaced for context when 401k
// distributions raise MAGI at 65+.
export const IRMAA_2025 = {
  single: [
    { maxMAGI: 106_000, partBPremium: 185.0, surcharge: 0 },
    { maxMAGI: 133_000, partBPremium: 259.0, surcharge: 74 },
    { maxMAGI: 167_000, partBPremium: 370.0, surcharge: 185 },
    { maxMAGI: 200_000, partBPremium: 480.9, surcharge: 295.9 },
    { maxMAGI: 500_000, partBPremium: 591.9, surcharge: 406.9 },
    { maxMAGI: Number.POSITIVE_INFINITY, partBPremium: 628.9, surcharge: 443.9 }
  ]
} as const

// ─── 401k statutory limits (public) ──────────────────────────────────────────
// Only the public IRS limits + a neutral default employer-match assumption. The
// user's actual balance/salary come from the DB, never from here.
export const K401_LIMITS = {
  annualLimit2025: 23_500,
  catchUpLimit2025: 7_500,
  totalAnnualMax: 31_000,
  defaultEmployerMatchPct: 0.04
} as const

// ─── Neutral market assumptions (generic; used as engine input defaults) ──────
// These are assumption defaults (return/inflation), NOT personal data — safe to
// ship. The user can override every one via the retirement config.
export const ASSUMPTIONS = {
  usInflation: 0.03,
  crInflation: 0.04,
  stockReturn: 0.085, // accumulation (pre-retirement) nominal
  postRetireReturn: 0.06, // conservative post-retirement nominal
  bondReturn: 0.045,
  safeWithdrawalRate: 0.04
} as const
