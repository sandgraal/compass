/**
 * Minimal RFC 5545 RRULE expander — Phase 5.13, the promised follow-up
 * from PR #74's Apple Calendar reader.
 *
 * Why we built our own (vs. `rrule.js`):
 *   - The Apple Calendar sync's only real recurring patterns are
 *     daily/weekly/monthly/yearly with INTERVAL, COUNT, UNTIL, and
 *     BYDAY. Apple stores BYMONTHDAY/BYSETPOS rarely. A 200-line
 *     subset implementation is faster to audit than a ~3000-line
 *     library, and gives us a clean abort point for the truly
 *     pathological recurrences (RDATE-only, BYWEEKNO, etc.).
 *   - We materialize a bounded window (default 14 days), so even if
 *     a rule says "every day forever" we stop at the window edge.
 *   - Easy to extend later: each unsupported token logs and falls
 *     through, so layering `rrule.js` for the long tail stays an
 *     option without rewriting callers.
 *
 * Supported:
 *   - FREQ=DAILY|WEEKLY|MONTHLY|YEARLY (others → empty expansion)
 *   - INTERVAL=N  (default 1)
 *   - COUNT=N  (cap on materialized occurrences)
 *   - UNTIL=YYYYMMDDTHHMMSSZ | YYYYMMDD  (inclusive upper bound)
 *   - BYDAY=MO,TU,WE,TH,FR,SA,SU  (for WEEKLY)
 *   - EXDATE list (excluded specific occurrences)
 *
 * Not yet supported (returns the base instance only + logs):
 *   - BYMONTHDAY / BYMONTH / BYSETPOS / BYWEEKNO / BYHOUR / etc.
 *   - WKST (we always assume Monday for the BYDAY positioning math)
 *   - RDATE / additional RRULEs
 */

const MS_PER_DAY = 86_400_000

export interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'UNSUPPORTED'
  interval: number
  count: number | null
  until: Date | null
  byDay: WeekDay[] | null
  /** Anything we recognised the key of but couldn't act on — surfaces in logs. */
  unsupportedTokens: string[]
}

type WeekDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
const WEEKDAYS: WeekDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
// JS Date.getDay(): 0=Sun. Map JS → ICS-2-letter so BYDAY filtering matches.
const JS_DAY_TO_RRULE: WeekDay[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

const SUPPORTED_FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

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
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toUpperCase()
    const raw = part.slice(eq + 1).trim()
    switch (key) {
      case 'FREQ':
        out.freq = SUPPORTED_FREQS.has(raw.toUpperCase())
          ? (raw.toUpperCase() as ParsedRrule['freq'])
          : 'UNSUPPORTED'
        break
      case 'INTERVAL': {
        const n = Number.parseInt(raw, 10)
        if (Number.isFinite(n) && n > 0) out.interval = n
        break
      }
      case 'COUNT': {
        const n = Number.parseInt(raw, 10)
        if (Number.isFinite(n) && n > 0) out.count = n
        break
      }
      case 'UNTIL':
        out.until = parseIcsDate(raw)
        break
      case 'BYDAY': {
        // Apple writes the plain `MO,TU,WE`. RFC also allows `1MO`
        // (first Monday) etc. — we drop the numeric prefix for the
        // weekly case (positional BYDAY in monthly/yearly is in the
        // unsupported set below).
        const days = raw
          .split(',')
          .map(
            (d) =>
              d
                .trim()
                .toUpperCase()
                .replace(/^[+-]?\d+/, '') as WeekDay
          )
          .filter((d) => WEEKDAYS.includes(d))
        if (days.length > 0) out.byDay = days
        break
      }
      // Recognised-but-not-implemented tokens — log so the user gets
      // a hint when their fortnightly-third-Tuesday event misses.
      case 'BYMONTHDAY':
      case 'BYMONTH':
      case 'BYSETPOS':
      case 'BYWEEKNO':
      case 'BYHOUR':
      case 'BYMINUTE':
      case 'BYSECOND':
      case 'WKST':
      case 'RDATE':
        out.unsupportedTokens.push(key)
        break
    }
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
  // Strip optional Z + handle the 8-char date-only form (YYYYMMDD).
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) {
    // Date-only — treat as start-of-day local.
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
  /** Safety cap on materialized occurrences. Default 366 — enough for
   *  a daily recurrence over a one-year window. */
  hardCap?: number
}

export interface Expansion {
  occurrences: Date[]
  /** True if the hard cap clipped the result — surfaces in logs. */
  truncated: boolean
}

/**
 * Materialize the occurrences of an RRULE relative to `start` (the
 * event's DTSTART) that fall within `[windowStart, windowEnd)`.
 *
 * Includes the base instance when it's in range. EXDATE values strip
 * specific occurrences (matched by exact ms).
 */
export function expandRrule(start: Date, rule: ParsedRrule, options: ExpandOptions): Expansion {
  const result: Date[] = []
  const cap = options.hardCap ?? 366
  const exSet = new Set((options.exDates ?? []).map((d) => d.getTime()))
  if (rule.freq === 'UNSUPPORTED') {
    // Caller still gets the base instance via the parser path; this
    // function returns nothing extra so we don't materialize phantom
    // dates.
    return { occurrences: [], truncated: false }
  }

  const windowStartMs = options.windowStart.getTime()
  const windowEndMs = options.windowEnd.getTime()

  let emitted = 0
  // For DAILY/WEEKLY we step by N days. For MONTHLY/YEARLY we increment
  // the calendar field directly so leap days + month-end land correctly.
  // The base instance (idx 0) is always considered.
  for (let idx = 0; ; idx++) {
    let occ: Date
    if (rule.freq === 'DAILY') {
      occ = new Date(start.getTime() + idx * rule.interval * MS_PER_DAY)
    } else if (rule.freq === 'WEEKLY') {
      // For WEEKLY without BYDAY we just step by N weeks from start.
      // With BYDAY we walk day by day and admit only the listed
      // weekdays, but still advance the WEEK counter by INTERVAL each
      // 7-day block.
      if (!rule.byDay) {
        occ = new Date(start.getTime() + idx * rule.interval * 7 * MS_PER_DAY)
      } else {
        // Day-by-day walk path — handled outside this for-loop. We
        // populate `result` directly and break.
        emitted = expandWeeklyByDay(start, rule, options, result, exSet, cap)
        break
      }
    } else if (rule.freq === 'MONTHLY') {
      occ = new Date(start)
      occ.setMonth(start.getMonth() + idx * rule.interval)
    } else {
      occ = new Date(start)
      occ.setFullYear(start.getFullYear() + idx * rule.interval)
    }

    if (rule.until && occ.getTime() > rule.until.getTime()) break
    if (rule.count !== null && emitted >= rule.count) break
    if (occ.getTime() >= windowEndMs) break

    if (occ.getTime() >= windowStartMs && !exSet.has(occ.getTime())) {
      result.push(occ)
    }
    emitted++

    if (result.length >= cap) {
      return { occurrences: result, truncated: true }
    }
    // Safety: regardless of cap, don't loop more than 10 * cap candidates.
    // Protects against pathological window+interval combos.
    if (idx > cap * 10) {
      return { occurrences: result, truncated: true }
    }
  }

  return { occurrences: result, truncated: result.length >= cap }
}

function expandWeeklyByDay(
  start: Date,
  rule: ParsedRrule,
  options: ExpandOptions,
  out: Date[],
  exSet: Set<number>,
  cap: number
): number {
  const byDay = new Set(rule.byDay ?? [])
  const windowEndMs = options.windowEnd.getTime()
  const windowStartMs = options.windowStart.getTime()
  let emitted = 0
  // Walk one day at a time. Skip days that aren't in the BYDAY set or
  // that fall in a "skipped week" (interval > 1).
  const startWeek = weekIndex(start)
  for (let dayOffset = 0; ; dayOffset++) {
    const cand = new Date(start.getTime() + dayOffset * MS_PER_DAY)
    if (rule.until && cand.getTime() > rule.until.getTime()) break
    if (cand.getTime() >= windowEndMs) break
    if (rule.count !== null && emitted >= rule.count) break

    const candWeek = weekIndex(cand)
    if ((candWeek - startWeek) % rule.interval !== 0) continue
    const dayCode = JS_DAY_TO_RRULE[cand.getDay()]
    if (!byDay.has(dayCode)) continue

    if (cand.getTime() >= windowStartMs && !exSet.has(cand.getTime())) {
      out.push(cand)
    }
    emitted++
    if (out.length >= cap) return emitted
    if (dayOffset > cap * 10) return emitted
  }
  return emitted
}

/** Monday-start week index — counts whole weeks since the epoch. */
function weekIndex(d: Date): number {
  // Shift so Monday is day 0, then divide.
  // JS getDay(): 0=Sun, 1=Mon ... → (day + 6) % 7 makes Mon = 0.
  const dayCount = Math.floor(d.getTime() / MS_PER_DAY)
  return Math.floor((dayCount + 3) / 7) // Jan 1 1970 was Thursday → +3 aligns Mon to start
}

// Exported for unit tests.
export const _internal = { weekIndex, JS_DAY_TO_RRULE }
