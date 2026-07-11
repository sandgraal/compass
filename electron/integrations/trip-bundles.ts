/**
 * Per-trip cost bundles — join each `travel_segments` row to the spend and
 * timeline activity that happened DURING it, so a trip stops being just a
 * country + date window and becomes "your Costa Rica trip cost $X, N events."
 *
 * Pure + SQLite-only (injectable) like the other finance aggregators. Reads
 * travel_segments × finance_transactions × records; each is guarded so an older
 * DB missing a table yields empty/zeroed bundles rather than throwing.
 */

import { type SqliteForFx, convert, getBaseCurrency, loadFxRates } from './finance-fx'

const NON_SPEND_CATEGORIES = new Set(['Transfers', 'Transfer'])

export interface TripBundle {
  id: number
  country: string
  countryName: string
  startDate: string
  endDate: string
  /** Inclusive day count of the trip. */
  days: number
  notes: string | null
  source: string
  /** Total discretionary spend during the trip, in the base currency (transfers excluded). */
  spend: number
  /** The base currency the `spend`/`topCategories` amounts are expressed in. */
  currency: string | null
  /** Timeline records that fell within the trip window. */
  recordCount: number
  topCategories: Array<{ category: string; amount: number }>
}

type Segment = {
  id: number
  country: string
  startDate: string
  endDate: string
  notes: string | null
  source: string
}

/** 'CR' → 'Costa Rica' (falls back to the raw code on anything unmappable). */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

function dayCount(startDate: string, endDate: string): number {
  const a = new Date(`${startDate}T00:00:00`).getTime()
  const b = new Date(`${endDate}T00:00:00`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1
  return Math.round((b - a) / 86_400_000) + 1
}

export function buildTripBundles(sqlite: SqliteForFx): TripBundle[] {
  let segments: Segment[] = []
  try {
    segments = sqlite
      .prepare(
        'SELECT id, country, start_date AS startDate, end_date AS endDate, notes, source FROM travel_segments ORDER BY start_date DESC'
      )
      .all() as Segment[]
  } catch {
    return [] // travel_segments absent → no trips
  }

  // Multi-currency (Phase 11.1): each txn `amount` is in its OWN currency, so we
  // convert every row to the user's BASE currency at the transaction-date rate
  // before summing (mirrors finance-property.ts). The bundle total/categories are
  // therefore all in one unit — the base currency.
  const base = getBaseCurrency(sqlite)
  const rates = loadFxRates(sqlite)

  // Prepared once, reused per segment.
  const spendStmt = safePrepare(
    sqlite,
    'SELECT amount, category, currency, date FROM finance_transactions WHERE date >= ? AND date <= ? AND amount < 0'
  )
  const recordStmt = safePrepare(
    sqlite,
    'SELECT COUNT(*) AS n FROM records WHERE occurred_at >= ? AND occurred_at <= ?'
  )

  return segments.map((s) => {
    let spend = 0
    const byCategory = new Map<string, number>()
    if (spendStmt) {
      const rows = spendStmt.all(s.startDate, s.endDate) as Array<{
        amount: number
        category: string | null
        currency: string | null
        date: string
      }>
      for (const r of rows) {
        const cat = r.category ?? 'Uncategorized'
        if (NON_SPEND_CATEGORIES.has(cat)) continue
        const from = r.currency || base
        const magnitude = Math.abs(r.amount)
        // No rate available → fall back to the raw magnitude (best-effort) rather
        // than dropping the row; single-currency users (from === base) hit rate 1.
        const inBase = convert(magnitude, from, base, rates, r.date) ?? magnitude
        spend += inBase
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + inBase)
      }
    }

    let recordCount = 0
    if (recordStmt) {
      const startMs = new Date(`${s.startDate}T00:00:00`).getTime()
      const endMs = new Date(`${s.endDate}T23:59:59`).getTime()
      recordCount = (recordStmt.get(startMs, endMs) as { n: number } | undefined)?.n ?? 0
    }

    const topCategories = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))

    return {
      id: s.id,
      country: s.country,
      countryName: countryName(s.country),
      startDate: s.startDate,
      endDate: s.endDate,
      days: dayCount(s.startDate, s.endDate),
      notes: s.notes,
      source: s.source,
      spend: Math.round(spend * 100) / 100,
      // Everything above is now expressed in the base currency.
      currency: base,
      recordCount,
      topCategories
    }
  })
}

/** Prepare a statement, returning null if the underlying table is absent. */
function safePrepare(sqlite: SqliteForFx, sql: string): ReturnType<SqliteForFx['prepare']> | null {
  try {
    return sqlite.prepare(sql)
  } catch {
    return null
  }
}
