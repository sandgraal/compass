/**
 * Geographic + purpose tagging for finance transactions.
 *
 * Two facts get attached to each ingested transaction's `notes` column as
 * pipe-delimited `key:value` tokens:
 *   - `geo:CR | geo:US | geo:COLOMBIA | …` — country of the merchant
 *   - `purpose:capex | purpose:operating | purpose:household | purpose:travel`
 *      — only for CR transactions; what the spend was FOR
 *
 * Storing in the existing `notes` column means no schema migration. The trade
 * is that queries that want to filter by geo/purpose have to do a `LIKE` on
 * notes — fine for this dataset's size; revisit if it ever needs to be a
 * proper indexed column.
 *
 * The classifier is intentionally substring-based and dumb. A merchant string
 * containing "cartago" almost always means the merchant is in Cartago province,
 * Costa Rica — the exception (people named "Cartago" in the US, etc.) is rare
 * enough that a few false positives are acceptable. US patterns are checked
 * FIRST so a CR-aliased Florida merchant gets the right country.
 */

import type { RawTxn } from './finance'

// Cities/regions that mark a merchant as Costa Rican.
const CR_PATTERNS = [
  'cartago',
  'san jose',
  'jimenez',
  'turrialba',
  'alajuelita',
  'tres rios',
  'san sebastian',
  'paraiso',
  'alajuela',
  'heredia',
  'limon',
  'puntarenas',
  'la suiza',
  'pejibaye',
  'pejivalle'
]

// Spanish merchant tokens commonly seen in CR descriptions.
const CR_SPANISH = [
  'supermercado',
  'panaderia',
  'carniceria',
  'ferreteria',
  'farmacia',
  'restaurante',
  'almacen',
  'soda ',
  'estacion de servicio',
  'servicentro',
  'mini super',
  'maxipali',
  'automercado',
  'perimercados',
  'musmanni',
  'banco popular',
  'scotiabank cost',
  'bac credomatic',
  'davivienda'
]

// Tokens that override CR_PATTERNS — the merchant is actually in the US.
// (e.g. "Pai ATM" appears in West Palm Beach withdrawals.)
const US_PATTERNS = [
  'west palm bea',
  'delray beach',
  'boynton beach',
  'boca raton',
  'miami',
  'fort lauderdale',
  'lake worth',
  'palm beach',
  'pai atm',
  'pai iso',
  ' fl ',
  ' ca ',
  ' ny ',
  ' tx '
]

// Other countries the user has spent in (Spain trips, Colombia transit, etc.)
const OTHER_COUNTRIES: Record<string, string[]> = {
  SPAIN: ['alcobendas', 'barcelona', 'madrid', 'ibis alcobendas'],
  COLOMBIA: ['bogota', 'medellin', 'antioquia', 'bancolombia'],
  PANAMA: ['panama c', ' pa ']
}

export type Geo = 'CR' | 'US' | 'SPAIN' | 'COLOMBIA' | 'PANAMA' | 'OTHER'
export type Purpose = 'capex' | 'household' | 'operating' | 'travel' | 'other' | ''

export function classifyGeo(description: string): Geo {
  const d = description.toLowerCase()
  if (US_PATTERNS.some((p) => d.includes(p))) return 'US'
  if (CR_PATTERNS.some((p) => d.includes(p))) return 'CR'
  if (CR_SPANISH.some((p) => d.includes(p))) return 'CR'
  for (const [country, pats] of Object.entries(OTHER_COUNTRIES)) {
    if (pats.some((p) => d.includes(p))) return country as Geo
  }
  return 'US' // default — most spend is US-based
}

// Categories whose presence on a CR transaction implies "this went into the build."
const CAPEX_CATEGORIES = new Set([
  'Property|Construction — materials',
  'Property|Construction — labor (est)',
  'Property|Furnishings',
  'Property|Supplies',
  'Property|Garden',
  'Property|Services'
])

// CapEx description hints that override category (helpful when the categorizer
// hasn't learned a particular CR hardware merchant yet).
const CAPEX_DESC_HINTS = ['ferreteria', 'judal steel', 'epa ', 'el lagar', 'ferreterias']

const HOUSEHOLD_CATEGORIES = new Set([
  'Food & Drink|Groceries',
  'Food & Drink|Restaurants',
  'Food & Drink|Coffee',
  'Personal|Care',
  'Health|Pharmacy',
  'Health|Vision',
  'Pets|Vet'
])

const OPERATING_CATEGORIES = new Set([
  'Transportation|Gas',
  'Transportation|Tolls',
  'Housing|Utilities',
  'Housing|Phone',
  'Housing|Internet',
  'Cash|ATM withdrawal',
  'Cash|Personal — split sibling'
])

export function classifyPurpose(
  geo: Geo,
  category: string | undefined,
  subcategory: string | undefined,
  description: string
): Purpose {
  if (geo !== 'CR') return ''
  const key = `${category ?? ''}|${subcategory ?? ''}`
  if (CAPEX_CATEGORIES.has(key)) return 'capex'
  const dl = description.toLowerCase()
  if (CAPEX_DESC_HINTS.some((h) => dl.includes(h))) return 'capex'
  if (HOUSEHOLD_CATEGORIES.has(key)) return 'household'
  if (OPERATING_CATEGORIES.has(key)) return 'operating'
  if ((category ?? '') === 'Travel') return 'travel'
  return 'other'
}

/**
 * Read existing geo/purpose tags from a notes string. Used by query layers
 * that want to filter without re-classifying.
 */
export function parseNotesTags(notes: string | null | undefined): {
  geo: Geo | null
  purpose: Purpose | null
  rest: string
} {
  if (!notes) return { geo: null, purpose: null, rest: '' }
  let geo: Geo | null = null
  let purpose: Purpose | null = null
  const rest: string[] = []
  for (const tok of notes.split('|')) {
    const t = tok.trim()
    if (t.startsWith('geo:')) {
      geo = t.slice(4) as Geo
    } else if (t.startsWith('purpose:')) {
      purpose = t.slice(8) as Purpose
    } else if (t) {
      rest.push(t)
    }
  }
  return { geo, purpose, rest: rest.join(' | ') }
}

/**
 * Idempotent: replaces any existing geo:/purpose: tokens in `notes` with the
 * given values. Preserves all other free-form notes content.
 */
export function upsertNotesTags(
  notes: string | null | undefined,
  geo: Geo,
  purpose: Purpose
): string {
  const { rest } = parseNotesTags(notes)
  const parts = rest ? [rest] : []
  parts.push(`geo:${geo}`)
  if (purpose) parts.push(`purpose:${purpose}`)
  return parts.join(' | ')
}

/**
 * Tag a batch of (already-categorized) transactions with geo + purpose.
 * Sets `geo` and `purpose` directly on the returned RawTxn objects.
 * Idempotent — safe to call multiple times on the same batch.
 */
export function tagGeoAndPurpose(txns: RawTxn[]): RawTxn[] {
  return txns.map((t) => {
    const geo = classifyGeo(t.description)
    const purpose = classifyPurpose(geo, t.category, t.subcategory, t.description)
    return { ...t, geo, purpose: purpose || undefined }
  })
}

/**
 * Re-run the migration 0004 backfill against existing rows whose `notes`
 * still carry `geo:X` / `purpose:X` tokens (from the pre-Phase-4.2 writer)
 * but whose indexed `geo` / `purpose` columns never got updated.
 *
 * The migration's UPDATEs only ran once at migration time; if rows were
 * re-ingested or imported after, or if `classifyGeo` couldn't infer the
 * country from `description` alone (e.g. "FERRETERIA SANTA ROSJIMENEZ CA"),
 * the column stayed at the schema default 'US' while notes carried the
 * historical truth. This helper closes that gap idempotently — safe to
 * call on every init.
 *
 * Returns the number of rows updated, broken down by tag.
 */
export function backfillGeoFromNotes(
  db: import('better-sqlite3').Database
): Record<string, number> {
  const geoValues = ['CR', 'SPAIN', 'COLOMBIA', 'PANAMA', 'OTHER'] as const
  const purposeValues = ['capex', 'household', 'operating', 'travel', 'other'] as const
  const counts: Record<string, number> = {}

  const hasTaggedNotes = db
    .prepare(
      `SELECT 1 AS found
         FROM finance_transactions
        WHERE notes LIKE '%geo:%' OR notes LIKE '%purpose:%'
        LIMIT 1`
    )
    .get() as { found: number } | undefined

  if (!hasTaggedNotes) return counts

  const collectCounts = (kind: 'geo' | 'purpose', values: readonly string[]) => {
    const selectSql = `SELECT
${values
  .map(
    (value) =>
      `  SUM(CASE WHEN notes LIKE '%${kind}:${value}%' AND (${kind} IS NULL OR ${kind} != '${value}') THEN 1 ELSE 0 END) AS "${kind}:${value}"`
  )
  .join(',\n')}
FROM finance_transactions
WHERE notes LIKE '%${kind}:%'`

    const row = db.prepare(selectSql).get() as Record<string, number | null> | undefined
    if (!row) return

    for (const value of values) {
      const key = `${kind}:${value}`
      const count = Number(row[key] ?? 0)
      if (count > 0) counts[key] = count
    }
  }

  const applyBackfill = (kind: 'geo' | 'purpose', values: readonly string[]) => {
    // `purpose` is nullable so `purpose != 'capex'` is UNKNOWN (not true) when
    // the column is NULL — three-valued SQL would skip those rows. Wrap with
    // `IS NULL OR …` so the WHERE matches initial-state rows too. `geo` is
    // NOT NULL but applying the same shape keeps both branches consistent.
    //
    // The original implementation applied tags sequentially, so later entries
    // won when a note happened to contain multiple tokens. Reverse the CASE
    // order to preserve that "last matching tag wins" behavior.
    const updateSql = `UPDATE finance_transactions
SET ${kind} = CASE
${[...values]
  .reverse()
  .map((value) => `  WHEN notes LIKE '%${kind}:${value}%' THEN '${value}'`)
  .join('\n')}
  ELSE ${kind}
END
WHERE notes LIKE '%${kind}:%'
  AND (
${values
  .map(
    (value) =>
      `    (notes LIKE '%${kind}:${value}%' AND (${kind} IS NULL OR ${kind} != '${value}'))`
  )
  .join('\n    OR\n')}
  )`

    db.prepare(updateSql).run()
  }

  collectCounts('geo', geoValues)
  collectCounts('purpose', purposeValues)
  applyBackfill('geo', geoValues)
  applyBackfill('purpose', purposeValues)

  return counts
}
