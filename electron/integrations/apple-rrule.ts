/**
 * Minimal RFC 5545 RRULE expander — Phase 5.13, the promised follow-up
 * from PR #74's Apple Calendar reader.
 *
 * Why we built our own (vs. `rrule.js`):
 *   - The Apple Calendar sync's only real recurring patterns are
 *     daily/weekly/monthly/yearly with INTERVAL, COUNT, UNTIL, and
 *     BYDAY. A focused implementation is faster to audit than a
 *     ~3000-line library, and gives us a clean abort point for the
 *     truly pathological recurrences (BYSETPOS, RDATE-only, etc.).
 *   - We materialize a bounded window (default 14 days). Anything that
 *     would emit beyond the window or beyond `hardCap` short-circuits.
 *
 * Correctness notes (addressing PR #80 review):
 *   - Daily / weekly advance via calendar-day arithmetic, not fixed-ms,
 *     so DST transitions don't drift the wall-clock time of floating /
 *     TZID-as-local events. We rebuild Dates from Y/M/D + the source's
 *     time-of-day fields, which is what Apple Calendar.app does for
 *     floating recurrences.
 *   - Monthly / yearly skip occurrences where `setMonth`/`setFullYear`
 *     would roll over (Jan 31 → Mar 3, Feb 29 → Mar 1). The skipped
 *     occurrences DO consume a COUNT slot, matching RFC 5545 §3.3.10
 *     ("if no occurrence exists … skip"). EXDATE handling lives in the
 *     caller side.
 *   - BYDAY is honoured for DAILY (as a weekday filter) AND WEEKLY.
 *     On MONTHLY/YEARLY it's positional (1MO = "first Monday of the
 *     month") — we explicitly reject and surface as UNSUPPORTED so the
 *     reader falls back to base-instance-only instead of emitting
 *     wrong dates.
 *   - Loop bounds key on windowEnd / UNTIL / COUNT, not a fixed
 *     iteration cap. A daily rule with a DTSTART years before the
 *     window still emits the in-window occurrences (previous code
 *     truncated at idx > cap * 10).
 *
 * Supported:
 *   - FREQ=DAILY|WEEKLY|MONTHLY|YEARLY (others → UNSUPPORTED)
 *   - INTERVAL=N (default 1)
 *   - COUNT=N (cap on TOTAL generated occurrences, before window clip)
 *   - UNTIL=YYYYMMDDTHHMMSSZ | YYYYMMDD (inclusive upper bound)
 *   - BYDAY=MO,TU,WE,TH,FR,SA,SU on DAILY + WEEKLY
 *
 * Marked UNSUPPORTED (reader falls back to base-only + warns):
 *   - BYSETPOS / BYMONTHDAY / BYMONTH / BYWEEKNO / BYHOUR / BYMINUTE /
 *     BYSECOND / WKST / RDATE (RDATE isn't even an RRULE key but
 *     surfaces here defensively)
 *   - BYDAY with positional prefix (`1MO`) — we strip the prefix only
 *     when FREQ=WEEKLY (where it's redundant); on MONTHLY/YEARLY the
 *     prefix is meaningful and we mark unsupported.
 *   - BYDAY on FREQ=MONTHLY or FREQ=YEARLY (positional regardless)
 */

export interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'UNSUPPORTED'
  interval: number
  count: number | null
  until: Date | null
  byDay: WeekDay[] | null
  /** Anything we recognised the key of but couldn't act on — caller logs. */
  unsupportedTokens: string[]
}

type WeekDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
const WEEKDAYS: WeekDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
// JS Date.getDay(): 0=Sun. Map JS → ICS-2-letter so BYDAY filtering matches.
const JS_DAY_TO_RRULE: WeekDay[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

const SUPPORTED_FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const POSITIONAL_BYDAY_FREQS = new Set(['MONTHLY', 'YEARLY'])

/**
 * Parse an RRULE value (the part AFTER `RRULE:`). Unknown FREQ values
 * coerce to `UNSUPPORTED` so the caller short-circuits instead of
 * materializing nonsense.
 */
export function parseRrule(value: string): ParsedRrule {
  const out: ParsedRrule = {
    freq: 'UNSUPPORTED',
    interval: 1,
    count: null,
    until: null,
    byDay: null,
    unsupportedTokens: []
  }
  if (!value) return out

  // First pass: collect each token so we can resolve cross-token
  // semantics (e.g. BYDAY-on-MONTHLY is unsupported, BYDAY-on-WEEKLY
  // accepts a numeric prefix as redundant).
  const tokens = new Map<string, string>()
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    tokens.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim())
  }

  const rawFreq = (tokens.get('FREQ') ?? '').toUpperCase()
  out.freq = SUPPORTED_FREQS.has(rawFreq) ? (rawFreq as ParsedRrule['freq']) : 'UNSUPPORTED'

  const intervalRaw = tokens.get('INTERVAL')
  if (intervalRaw !== undefined) {
    const n = Number.parseInt(intervalRaw, 10)
    if (Number.isFinite(n) && n > 0) out.interval = n
  }

  const countRaw = tokens.get('COUNT')
  if (countRaw !== undefined) {
    const n = Number.parseInt(countRaw, 10)
    if (Number.isFinite(n) && n > 0) out.count = n
  }

  const untilRaw = tokens.get('UNTIL')
  if (untilRaw !== undefined) {
    out.until = parseIcsDate(untilRaw)
  }

  const byDayRaw = tokens.get('BYDAY')
  if (byDayRaw !== undefined) {
    // Positional prefixes (`1MO`, `-1TU`) only have meaning on MONTHLY /
    // YEARLY — and that's the variant we explicitly DON'T support. On
    // WEEKLY a numeric prefix is non-standard but we accept and ignore
    // it (Apple sometimes writes it). On DAILY any prefix is meaningless.
    if (POSITIONAL_BYDAY_FREQS.has(out.freq)) {
      out.unsupportedTokens.push('BYDAY')
    } else {
      const parts = byDayRaw.split(',').map((s) => s.trim().toUpperCase())
      const days: WeekDay[] = []
      let sawPrefix = false
      for (const p of parts) {
        const prefixMatch = p.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/)
        if (!prefixMatch) continue
        if (prefixMatch[1]) sawPrefix = true
        const dayCode = prefixMatch[2] as WeekDay
        if (WEEKDAYS.includes(dayCode)) days.push(dayCode)
      }
      // A positional BYDAY on WEEKLY is technically the same set of
      // days, so we keep them. On DAILY we also accept (a "MWF" daily
      // rule means: every day, but only on M/W/F). Flag the rare
      // prefix-on-WEEKLY for awareness.
      if (sawPrefix && out.freq === 'WEEKLY') {
        // Don't mark unsupported — the prefix was redundant.
      }
      if (days.length > 0) out.byDay = days
    }
  }

  // Recognised-but-not-implemented tokens — each forces a base-only
  // fallback in the reader to avoid emitting wrong dates.
  for (const key of [
    'BYMONTHDAY',
    'BYMONTH',
    'BYSETPOS',
    'BYWEEKNO',
    'BYYEARDAY',
    'BYHOUR',
    'BYMINUTE',
    'BYSECOND',
    'WKST',
    'RDATE'
  ]) {
    if (tokens.has(key)) out.unsupportedTokens.push(key)
  }

  return out
}

/**
 * Parse an ICS date-or-datetime token (the value after a `DTSTART:` or
 * `UNTIL=`). Falls back to local-time interpretation; the caller is
 * expected to be the Apple Calendar reader which already documents the
 * "floating local time" trade-off.
 */
export function parseIcsDate(raw: string): Date | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) {
    return new Date(Number(y), Number(mo) - 1, Number(d))
  }
  const yy = Number(y)
  const mm = Number(mo) - 1
  const dd = Number(d)
  const hh = Number(h)
  const mii = Number(mi)
  const ss = Number(s)
  if (z === 'Z') {
    return new Date(Date.UTC(yy, mm, dd, hh, mii, ss))
  }
  return new Date(yy, mm, dd, hh, mii, ss)
}

export interface ExpandOptions {
  /** Start of materialization window (inclusive). */
  windowStart: Date
  /** End of materialization window (exclusive). */
  windowEnd: Date
  /** EXDATE occurrences to skip. Compared by exact millisecond. */
  exDates?: Date[]
  /** Safety cap on EMITTED occurrences in the window. Default 366. */
  hardCap?: number
}

export interface Expansion {
  occurrences: Date[]
  /** True if the hard cap clipped the result — surfaces in logs. */
  truncated: boolean
}

/**
 * Materialize occurrences of an RRULE relative to `start` (the
 * event's DTSTART) that fall within `[windowStart, windowEnd)`.
 *
 * The base instance is included when it lands in range. EXDATE values
 * strip specific occurrences by exact-ms match. UNSUPPORTED FREQ
 * returns an empty list — the caller falls back to base-only.
 */
export function expandRrule(start: Date, rule: ParsedRrule, options: ExpandOptions): Expansion {
  if (rule.freq === 'UNSUPPORTED') {
    return { occurrences: [], truncated: false }
  }
  // Any recognised-but-unimplemented modifier means the rule's actual
  // semantics differ from "FREQ alone" — return empty so the caller
  // emits only the base instance instead of wrong occurrences.
  if (rule.unsupportedTokens.length > 0) {
    return { occurrences: [], truncated: false }
  }

  const cap = options.hardCap ?? 366
  const exSet = new Set((options.exDates ?? []).map((d) => d.getTime()))
  const windowStartMs = options.windowStart.getTime()
  const windowEndMs = options.windowEnd.getTime()
  const untilMs = rule.until ? rule.until.getTime() : Number.POSITIVE_INFINITY

  // Time-of-day components from start. Calendar-day arithmetic
  // rebuilds Dates with these values so wall-clock time is preserved
  // across DST transitions (a 09:00 meeting stays 09:00 in local).
  const tod = {
    h: start.getHours(),
    mi: start.getMinutes(),
    s: start.getSeconds(),
    ms: start.getMilliseconds()
  }

  const result: Date[] = []
  let generated = 0

  function shouldKeep(occ: Date): boolean {
    if (occ.getTime() > untilMs) return false
    if (occ.getTime() >= windowEndMs) return false
    if (occ.getTime() < windowStartMs) return false
    if (exSet.has(occ.getTime())) return false
    return true
  }

  function dayByOffset(daysFromStart: number): Date {
    // Calendar-day step from start.{Y,M,D}, with the source's local
    // time-of-day. JS Date constructor with overflow days handles
    // month-end correctly (Jan 32 → Feb 1).
    return new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + daysFromStart,
      tod.h,
      tod.mi,
      tod.s,
      tod.ms
    )
  }

  if (rule.freq === 'DAILY') {
    const byDaySet = rule.byDay ? new Set(rule.byDay) : null
    // Step by 1 day, count only days that match the optional weekday
    // filter. INTERVAL groups successive matched days: every INTERVAL-th
    // matching day is emitted (RFC 5545 §3.3.10 "FREQ=DAILY;BYDAY=MO,TU…
    // means every Nth matching day").
    let matchIdx = 0
    for (let dayOffset = 0; ; dayOffset++) {
      const occ = dayByOffset(dayOffset)
      if (occ.getTime() > untilMs) break
      if (occ.getTime() >= windowEndMs) break
      if (rule.count !== null && generated >= rule.count) break

      if (byDaySet) {
        const dayCode = JS_DAY_TO_RRULE[occ.getDay()]
        if (!byDaySet.has(dayCode)) continue
      }
      // matchIdx ticks once per BYDAY-matched candidate; INTERVAL
      // controls which matches are emitted (matchIdx % INTERVAL === 0).
      if (matchIdx % rule.interval === 0) {
        generated++
        if (shouldKeep(occ)) {
          result.push(occ)
          if (result.length >= cap) return { occurrences: result, truncated: true }
        }
      }
      matchIdx++
    }
    return { occurrences: result, truncated: false }
  }

  if (rule.freq === 'WEEKLY') {
    if (!rule.byDay) {
      // Plain weekly — step by INTERVAL weeks.
      for (let i = 0; ; i++) {
        const occ = dayByOffset(i * rule.interval * 7)
        if (occ.getTime() > untilMs) break
        if (occ.getTime() >= windowEndMs) break
        if (rule.count !== null && generated >= rule.count) break
        generated++
        if (shouldKeep(occ)) {
          result.push(occ)
          if (result.length >= cap) return { occurrences: result, truncated: true }
        }
      }
      return { occurrences: result, truncated: false }
    }
    // WEEKLY + BYDAY — walk day by day, restricted to matched weekdays,
    // grouped into INTERVAL-week blocks.
    const byDaySet = new Set(rule.byDay)
    const startWeek = weekIndex(start)
    for (let dayOffset = 0; ; dayOffset++) {
      const occ = dayByOffset(dayOffset)
      if (occ.getTime() > untilMs) break
      if (occ.getTime() >= windowEndMs) break
      if (rule.count !== null && generated >= rule.count) break

      const candWeek = weekIndex(occ)
      if ((candWeek - startWeek) % rule.interval !== 0) continue
      const dayCode = JS_DAY_TO_RRULE[occ.getDay()]
      if (!byDaySet.has(dayCode)) continue

      generated++
      if (shouldKeep(occ)) {
        result.push(occ)
        if (result.length >= cap) return { occurrences: result, truncated: true }
      }
    }
    return { occurrences: result, truncated: false }
  }

  // MONTHLY / YEARLY — increment the relevant calendar field, then
  // verify the result lands on the same day-of-month as the start.
  // If it didn't, the date rolled (e.g. Jan 31 → Mar 3 because Feb 31
  // doesn't exist). Skip that occurrence — RFC 5545 §3.3.10 says
  // "non-existent dates are skipped". COUNT still ticks for skipped
  // occurrences to match standard behaviour.
  const startDay = start.getDate()
  const startMonth = start.getMonth()
  for (let i = 0; ; i++) {
    const occ = new Date(
      rule.freq === 'YEARLY' ? start.getFullYear() + i * rule.interval : start.getFullYear(),
      rule.freq === 'YEARLY' ? startMonth : startMonth + i * rule.interval,
      startDay,
      tod.h,
      tod.mi,
      tod.s,
      tod.ms
    )
    if (occ.getTime() > untilMs) break
    if (occ.getTime() >= windowEndMs) break
    if (rule.count !== null && generated >= rule.count) break

    // Did the date roll? `Date` overflows silently; check the field we
    // expected to keep stable.
    const rolled =
      occ.getDate() !== startDay || (rule.freq === 'YEARLY' && occ.getMonth() !== startMonth)
    generated++
    if (!rolled && shouldKeep(occ)) {
      result.push(occ)
      if (result.length >= cap) return { occurrences: result, truncated: true }
    }
  }
  return { occurrences: result, truncated: false }
}

/** Monday-start week index — counts whole weeks since the epoch. */
function weekIndex(d: Date): number {
  // Jan 1 1970 was Thursday → +3 aligns Mon to start.
  const dayCount = Math.floor(d.getTime() / 86_400_000)
  return Math.floor((dayCount + 3) / 7)
}

// Exported for unit tests.
export const _internal = { weekIndex, JS_DAY_TO_RRULE }
