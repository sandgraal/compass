/**
 * Generic-row reclassification planner (Timeline 2.0, PR 2).
 *
 * The user's full Amazon export (~217 CSVs, 170k rows) predates the dedicated
 * recognizers in `amazon-export.ts`, so it sits on the timeline as source
 * 'generic' — with wrong titles (artist instead of track) and wrong dates
 * (`SecondsWatched` mis-picked as the date column). Every generic row kept its
 * original CSV row in `payload` and its filename in `provenance`, so the
 * signal families can be re-derived losslessly.
 *
 * This module is the PURE planner: given generic rows, it returns which rows
 * should become properly-sourced records (delete generic row + insert the
 * mapper's output) and which must move to `location_points` (Amazon device
 * geolocation — raw coordinates must never sit on the records spine). Rows no
 * mapper claims are left untouched; source-tiers collapses them as firehose.
 * The IPC layer (`records.ts`) executes the plan through the production
 * `insertRecords` / `insertLocationPoints` paths so hashing, truncation, FTS
 * triggers, and the date guardrail all apply — a future re-import of the same
 * file dedupes against the reclassified rows instead of duplicating them.
 */

import { AMAZON_REFILE_FAMILIES, type RefileFamily } from './amazon-export'
import type { RecordInput } from './recognizers'

export type GenericRowLite = {
  id: number
  provenance: string | null
  payload: string | null
}

export type ReclassifyPlan = {
  /** Generic rows to re-insert as properly-sourced records, then delete. */
  records: Array<{ deleteId: number; provenance: string; input: RecordInput }>
  /** Generic rows to move to location_points, then delete. */
  locations: Array<{ deleteId: number; provenance: string; input: RecordInput }>
}

const FAMILIES: readonly RefileFamily[] = AMAZON_REFILE_FAMILIES

export function planReclassify(rows: Iterable<GenericRowLite>): ReclassifyPlan {
  const plan: ReclassifyPlan = { records: [], locations: [] }
  for (const row of rows) {
    const { provenance, payload } = row
    if (!provenance || !payload) continue
    const family = FAMILIES.find((f) => f.matches(provenance))
    if (!family) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const input = family.map(parsed as Record<string, unknown>)
    if (!input) continue // mapper declined (missing title/coords) — stays generic
    ;(family.location ? plan.locations : plan.records).push({
      deleteId: row.id,
      provenance,
      input
    })
  }
  return plan
}
