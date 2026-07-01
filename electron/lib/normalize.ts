/**
 * Shared merchant / cadence normalizers — the pure helpers that both the finance
 * subscription audit (`electron/integrations/finance-subscriptions.ts`) and the
 * generic entity-derivation engine (`electron/lib/entities.ts`) key on.
 *
 * Lifted here (Phase 0 of the cross-reference work) so a merchant string
 * normalizes to the SAME key everywhere — which is what lets a records-derived
 * subscription candidate dedupe against a finance-audit one via the shared
 * `detected:<merchant>::<account>` external id.
 *
 * Behavior is byte-identical to the previous in-file definitions. Do NOT change
 * the output of `normalizeMerchant` without migrating existing `detected:` ids.
 */

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semi-annual' | 'yearly'

/** Charges per year for each cadence. */
export const PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  'semi-annual': 2,
  yearly: 1
}

/** Annualize a per-cadence cost. Unknown cadence falls back to monthly (×12). */
export function annualizeCost(cost: number, cadence: string): number {
  return Math.round(cost * (PER_YEAR[cadence as Cadence] ?? 12) * 100) / 100
}

/**
 * Collapse a raw transaction/counterparty description to a stable merchant key:
 * lowercased, stripped of "payment to" / Apple-Pay prefixes, transaction ids,
 * corporate suffixes, and TLD tokens, then the first ~4 words. Used as the merge
 * key for merchants and the `detected:` subscription external id.
 */
export function normalizeMerchant(desc: string): string {
  let d = desc.toLowerCase().trim()
  d = d.replace(/^payment to /, '')
  d = d.replace(/^aplpay\s+/, '')
  d = d.replace(/\b\d{4,}\b/g, '') // strip transaction IDs
  d = d.replace(/\b(inc|llc|ltd|corp|co)\.?\b/g, '')
  d = d.replace(/[*#]/g, ' ')
  d = d.replace(/\b(com|net|io|co|ai)\b/g, '')
  d = d.replace(/\s+/g, ' ').trim()
  d = d.replace(/^[,.\-/]+|[,.\-/]+$/g, '').trim()
  return d.split(' ').slice(0, 4).join(' ')
}

/** Median of a numeric list (average of the two middle values when even). */
export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Infer a recurring cadence from a sorted list of charge dates by the median gap
 * between consecutive dates. Returns null when there are <2 dates or the gap
 * doesn't fall in a recognized band ("irregular").
 */
export function detectCadence(dates: Date[]): Cadence | null {
  if (dates.length < 2) return null
  const gaps: number[] = []
  for (let i = 0; i < dates.length - 1; i++) {
    const ms = dates[i + 1].getTime() - dates[i].getTime()
    gaps.push(Math.round(ms / 86400000))
  }
  const med = median(gaps)
  if (med >= 25 && med <= 35) return 'monthly'
  if (med >= 6 && med <= 9) return 'weekly'
  if (med >= 12 && med <= 16) return 'biweekly'
  if (med >= 80 && med <= 100) return 'quarterly'
  if (med >= 175 && med <= 200) return 'semi-annual'
  if (med >= 350 && med <= 380) return 'yearly'
  return null
}
