/**
 * Calendar → travel-segment projector — the long-reserved `source='calendar'`
 * feed (Phase 11.5 kept the enum slot; this fills it). Mirrors
 * location-residency.ts exactly: derived rows carry `source='calendar'`, a
 * re-derivation replaces ONLY those rows (manual / location / i94 untouched),
 * and the residency math is unchanged — it already treats overlapping
 * segments as unique days, so calendar + location + manual coexist safely.
 *
 * The heuristic is deliberately CONSERVATIVE — a wrong trip corrupts
 * days-in-country math, a missed one just stays manual:
 *   - only MULTI-DAY events qualify (all-day spans use the Calendar API's
 *     exclusive end date; timed events need start/end on different days)
 *   - the event's location (preferred) or title must contain a curated,
 *     word-bounded country/city alias — never a guess, never a default
 *   - the home country is dropped (matching pointsToSegments)
 *   - ambiguous homographs (Turkey, Georgia, Jordan, Chad…) are deliberately
 *     absent from the alias table: a "Thanksgiving turkey prep" block must
 *     never become a trip. Extend the table as real trips demand.
 *
 * Note the live Google sync only pulls a two-week forward window, so this
 * feed mostly captures PLANNED trips (useful for residency projections);
 * imported .ics history lands on the records spine, not calendar_events.
 */

import { getRawSqlite } from '../db/client'
import { afterDomainWrite } from '../ipc/storehouse-sync'
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

const DAY_MS = 86_400_000

/**
 * Curated alias → ISO-3166 alpha-2 table. Lowercase; matched word-bounded
 * against the event location/title. Only unambiguous names: no homograph
 * countries (Turkey/Georgia/Jordan/Chad/China…), no city names that are also
 * common in other countries (San José, Cordoba…).
 */
const TRIP_ALIASES: ReadonlyArray<[string, string]> = [
  // Countries (common English names)
  ['costa rica', 'CR'],
  ['united states', 'US'],
  ['usa', 'US'],
  ['mexico', 'MX'],
  ['guatemala', 'GT'],
  ['panama', 'PA'],
  ['nicaragua', 'NI'],
  ['colombia', 'CO'],
  ['ecuador', 'EC'],
  ['peru', 'PE'],
  ['chile', 'CL'],
  ['argentina', 'AR'],
  ['brazil', 'BR'],
  ['canada', 'CA'],
  ['spain', 'ES'],
  ['portugal', 'PT'],
  ['france', 'FR'],
  ['italy', 'IT'],
  ['germany', 'DE'],
  ['netherlands', 'NL'],
  ['belgium', 'BE'],
  ['switzerland', 'CH'],
  ['austria', 'AT'],
  ['united kingdom', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['ireland', 'IE'],
  ['iceland', 'IS'],
  ['norway', 'NO'],
  ['sweden', 'SE'],
  ['denmark', 'DK'],
  ['finland', 'FI'],
  ['greece', 'GR'],
  ['croatia', 'HR'],
  ['czech republic', 'CZ'],
  ['japan', 'JP'],
  ['south korea', 'KR'],
  ['taiwan', 'TW'],
  ['thailand', 'TH'],
  ['vietnam', 'VN'],
  ['singapore', 'SG'],
  ['indonesia', 'ID'],
  ['philippines', 'PH'],
  ['australia', 'AU'],
  ['new zealand', 'NZ'],
  ['morocco', 'MA'],
  ['south africa', 'ZA'],
  // Unambiguous major cities
  ['san josé', 'CR'], // accented form is unambiguous; plain "san jose" is not (CA)
  ['mexico city', 'MX'],
  ['cdmx', 'MX'],
  ['cancun', 'MX'],
  ['oaxaca', 'MX'],
  ['bogota', 'CO'],
  ['bogotá', 'CO'],
  ['medellin', 'CO'],
  ['medellín', 'CO'],
  ['madrid', 'ES'],
  ['barcelona', 'ES'],
  ['lisbon', 'PT'],
  ['paris', 'FR'],
  ['rome', 'IT'],
  ['milan', 'IT'],
  ['berlin', 'DE'],
  ['munich', 'DE'],
  ['amsterdam', 'NL'],
  ['zurich', 'CH'],
  ['london', 'GB'],
  ['dublin', 'IE'],
  ['reykjavik', 'IS'],
  ['copenhagen', 'DK'],
  ['stockholm', 'SE'],
  ['oslo', 'NO'],
  ['athens', 'GR'],
  ['tokyo', 'JP'],
  ['kyoto', 'JP'],
  ['osaka', 'JP'],
  ['seoul', 'KR'],
  ['bangkok', 'TH'],
  ['hanoi', 'VN'],
  ['sydney', 'AU'],
  ['melbourne', 'AU'],
  ['auckland', 'NZ'],
  ['toronto', 'CA'],
  ['vancouver', 'CA'],
  ['montreal', 'CA']
]

const ALIAS_MATCHERS: ReadonlyArray<{ re: RegExp; country: string }> = TRIP_ALIASES.map(
  ([alias, country]) => ({
    // Word-bounded, case-insensitive; aliases may contain spaces/accents so
    // boundaries are hand-rolled (\b misfires around non-ASCII letters).
    re: new RegExp(
      `(^|[^\\p{L}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`,
      'iu'
    ),
    country
  })
)

/** Detect a trip country from free text — null when nothing (or home) matches. */
export function detectTripCountry(text: string | null | undefined): string | null {
  if (!text?.trim()) return null
  for (const { re, country } of ALIAS_MATCHERS) {
    if (re.test(text)) return country
  }
  return null
}

/** One calendar event reduced to the fields the heuristic consumes. */
export interface CalendarEventForTrips {
  title: string
  location: string | null
  startAt: number | null
  endAt: number | null
  allDay: boolean
}

export interface CalendarTripSegment {
  country: string
  startDate: string // local-day ISO, inclusive
  endDate: string // local-day ISO, inclusive
  title: string
}

/**
 * Pure heuristic: multi-day events whose location (preferred) or title names
 * a known country/city, excluding the home country. All-day `endAt` is the
 * API's EXCLUSIVE end date; timed events use their end instant's local day.
 */
export function eventsToSegments(
  events: CalendarEventForTrips[],
  opts: { homeCountry: string; localDayOf?: (ms: number) => string }
): CalendarTripSegment[] {
  const dayOf = opts.localDayOf ?? localYmd
  const out: CalendarTripSegment[] = []
  for (const ev of events) {
    if (ev.startAt == null || ev.endAt == null) continue
    const country = detectTripCountry(ev.location) ?? detectTripCountry(ev.title)
    if (!country || country === opts.homeCountry) continue
    const startDate = dayOf(ev.startAt)
    const endDate = ev.allDay ? dayOf(ev.endAt - DAY_MS) : dayOf(ev.endAt)
    if (endDate <= startDate) continue // single-day events never qualify
    out.push({ country, startDate, endDate, title: ev.title })
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate))
}

export type DeriveResult = { derived: number; removed: number }

/**
 * Re-derive calendar-sourced travel segments from `calendar_events`. Replaces
 * every `source='calendar'` row (leaving manual/location/i94 rows intact)
 * with a fresh set. Idempotent — a pure function of the event set.
 */
export function deriveCalendarSegments(
  sqlite: SqliteForFx,
  now: number = Date.now()
): DeriveResult {
  const rows = sqlite
    .prepare(
      `SELECT title, location, start_at AS startAt, end_at AS endAt, all_day AS allDay
         FROM calendar_events WHERE start_at IS NOT NULL AND end_at IS NOT NULL`
    )
    .all() as Array<{
    title: string
    location: string | null
    startAt: number
    endAt: number
    allDay: number
  }>
  const home = getResidencyConfig(sqlite).homeCountry
  const segments = eventsToSegments(
    rows.map((r) => ({ ...r, allDay: !!r.allDay })),
    { homeCountry: home }
  )

  const insert = sqlite.prepare(
    "INSERT INTO travel_segments (country, start_date, end_date, notes, source, created_at) VALUES (?, ?, ?, ?, 'calendar', ?)"
  )
  sqlite.prepare('BEGIN').run()
  try {
    const removed = sqlite
      .prepare("DELETE FROM travel_segments WHERE source = 'calendar'")
      .run().changes
    for (const s of segments) {
      insert.run(s.country, s.startDate, s.endDate, `auto · calendar: ${s.title}`, now)
    }
    sqlite.prepare('COMMIT').run()
    return { derived: segments.length, removed: Number(removed) }
  } catch (err) {
    sqlite.prepare('ROLLBACK').run()
    throw err
  }
}

/**
 * Post-sync hook: re-derive calendar segments after a calendar sync lands.
 * Best-effort — never throws, so it can't fail the sync that triggered it
 * (the same contract as afterLocationImport).
 */
export function afterCalendarSync(): void {
  try {
    deriveCalendarSegments(getRawSqlite())
    // Derived segments live on the records spine (source 'travel') — re-project
    // so the timeline reflects the fresh trips.
    afterDomainWrite({ entities: true })
  } catch (err) {
    console.error('[calendar-residency] derive failed', err)
  }
}
