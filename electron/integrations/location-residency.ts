/**
 * Location → travel-segment projector (Phase 10.8 — "Location → Residency autopilot").
 *
 * Turns the raw `location_points` (ingested from an OwnTracks/GPX/Google export) into
 * `travel_segments` rows so the existing residency engine (`residency.ts`) — days-in-
 * country, US substantial-presence, CR 183-day — becomes AUTOMATIC instead of hand-
 * entered. The residency math is unchanged: it already reads whatever is in
 * `travel_segments` and treats overlaps as unique days, so derived + manual segments
 * coexist safely.
 *
 * Coexistence: derived rows carry `source='location'`; a re-derivation replaces ONLY
 * those rows (manual entries are never touched). The projection is a pure function of
 * the point set, so it's idempotent — running it twice yields the same segments.
 *
 * Runs as a best-effort post-import hook (`afterLocationImport`), mirroring the finance
 * `afterFinanceSync` storehouse projector: it never throws, so a derivation hiccup can
 * never fail the underlying file import.
 */

import { getRawSqlite } from '../db/client'
import { afterDomainWrite } from '../ipc/storehouse-sync'
import { type LocPoint, pointsToSegments } from '../lib/location-country'
import type { SqliteForFx } from './finance-fx'
import { getResidencyConfig } from './residency'

/** Format an epoch-ms instant as a LOCAL-day 'YYYY-MM-DD' (travel_segments dates are local-day). */
function localYmd(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export type DeriveResult = { derived: number; removed: number }

/**
 * Re-derive location-sourced travel segments from `location_points`. Replaces every
 * `source='location'` row (leaving manual/calendar/i94 rows intact) with a fresh set
 * collapsed from the point trail. Returns how many were written vs. removed.
 */
export function deriveLocationSegments(
  sqlite: SqliteForFx,
  now: number = Date.now()
): DeriveResult {
  const rows = sqlite
    .prepare('SELECT occurred_at AS at, lat, lng FROM location_points ORDER BY occurred_at')
    .all() as Array<{ at: number; lat: number; lng: number }>
  const points: LocPoint[] = rows.map((r) => ({ at: Number(r.at), lat: r.lat, lng: r.lng }))

  const home = getResidencyConfig(sqlite).homeCountry
  const segments = pointsToSegments(points, { homeCountry: home, localDayOf: localYmd })

  // Replace-in-place: only the derived rows (manual rows are never touched),
  // wrapped in a transaction so a failure between the delete and the inserts
  // can't leave the user with NO derived segments — and one fsync, not one per row.
  const insert = sqlite.prepare(
    "INSERT INTO travel_segments (country, start_date, end_date, notes, source, created_at) VALUES (?, ?, ?, ?, 'location', ?)"
  )
  sqlite.prepare('BEGIN').run()
  try {
    const removed = sqlite
      .prepare("DELETE FROM travel_segments WHERE source = 'location'")
      .run().changes
    for (const s of segments) {
      insert.run(s.country, s.startDate, s.endDate, `auto · ${s.pointCount} points`, now)
    }
    sqlite.prepare('COMMIT').run()
    return { derived: segments.length, removed: Number(removed) }
  } catch (err) {
    sqlite.prepare('ROLLBACK').run()
    throw err
  }
}

/**
 * Post-import hook: re-derive location segments after a location export lands.
 * Best-effort — never throws, so it can't fail the file import that triggered it
 * (the same contract as the knowledge/derived-entity refreshes in `records.ts`).
 */
export function afterLocationImport(): void {
  try {
    deriveLocationSegments(getRawSqlite())
    // Derived segments live on the records spine (source 'travel') — re-project
    // so the timeline reflects the fresh trips. Raw points never enter records.
    afterDomainWrite({ entities: true })
  } catch (err) {
    console.error('[location-residency] derive failed', err)
  }
}
