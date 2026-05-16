/**
 * Tests for the minimal RRULE expander. Two layers:
 *   - Parser tests lock in how each RRULE token maps onto the
 *     `ParsedRrule` shape — including the unsupported-token bag the
 *     reader uses to short-circuit to base-only.
 *   - Expander tests use a fixed `start` + window and compare against
 *     local-time calendar fields (`.getMonth()`, `.getDate()`,
 *     `.getHours()`) rather than `toISOString()` so they're stable
 *     across runs / timezones.
 *
 * No real Calendar.app data is touched here; the bigger end-to-end
 * tests for `readAppleCalendars` cover the file-walk path.
 */

import { describe, expect, it } from 'vitest'
import { expandRrule, parseIcsDate, parseRrule } from './apple-rrule'

// Local-time constructor — the expander uses local calendar arithmetic
// (DST-safe wall-clock preservation), so the tests must too. Assertions
// compare local-time fields, never `toISOString()`.
const D = (y: number, m: number, d: number, h = 0, mi = 0): Date => new Date(y, m - 1, d, h, mi)

const WINDOW_START = D(2026, 1, 1)
const WINDOW_END = D(2026, 12, 31, 23, 59)

// Helper: extract [month, day] tuples so timezone never enters the assertion.
const md = (occurrences: Date[]): Array<[number, number]> =>
  occurrences.map((d) => [d.getMonth(), d.getDate()] as [number, number])

describe('parseRrule', () => {
  it('parses FREQ + INTERVAL + COUNT', () => {
    const r = parseRrule('FREQ=DAILY;INTERVAL=2;COUNT=5')
    expect(r.freq).toBe('DAILY')
    expect(r.interval).toBe(2)
    expect(r.count).toBe(5)
    expect(r.until).toBeNull()
  })

  it('parses UNTIL as a UTC date-time', () => {
    const r = parseRrule('FREQ=WEEKLY;UNTIL=20260301T000000Z')
    expect(r.until).toEqual(new Date(Date.UTC(2026, 2, 1, 0, 0, 0)))
  })

  it('parses UNTIL as a date-only', () => {
    const r = parseRrule('FREQ=DAILY;UNTIL=20260301')
    expect(r.until).toEqual(new Date(2026, 2, 1))
  })

  it('parses BYDAY for WEEKLY and drops numeric prefixes (redundant there)', () => {
    const r = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR,1TU')
    expect(r.byDay).toEqual(['MO', 'WE', 'FR', 'TU'])
    expect(r.unsupportedTokens).not.toContain('BYDAY')
  })

  it('parses BYDAY for DAILY (weekday filter)', () => {
    const r = parseRrule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR')
    expect(r.byDay).toEqual(['MO', 'TU', 'WE', 'TH', 'FR'])
    expect(r.unsupportedTokens).not.toContain('BYDAY')
  })

  it('marks BYDAY as UNSUPPORTED on MONTHLY (positional semantics)', () => {
    const r = parseRrule('FREQ=MONTHLY;BYDAY=1MO')
    expect(r.unsupportedTokens).toContain('BYDAY')
  })

  it('marks BYDAY as UNSUPPORTED on YEARLY', () => {
    const r = parseRrule('FREQ=YEARLY;BYDAY=1MO')
    expect(r.unsupportedTokens).toContain('BYDAY')
  })

  it('coerces unknown FREQ to UNSUPPORTED', () => {
    const r = parseRrule('FREQ=SECONDLY;INTERVAL=10')
    expect(r.freq).toBe('UNSUPPORTED')
  })

  it('collects recognised-but-unimplemented tokens', () => {
    const r = parseRrule('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=TU')
    expect(r.unsupportedTokens).toContain('BYSETPOS')
    expect(r.unsupportedTokens).toContain('BYDAY')
  })

  it('flags BYMONTHDAY / BYMONTH / BYWEEKNO as unsupported', () => {
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=15').unsupportedTokens).toContain('BYMONTHDAY')
    expect(parseRrule('FREQ=YEARLY;BYMONTH=3').unsupportedTokens).toContain('BYMONTH')
    expect(parseRrule('FREQ=YEARLY;BYWEEKNO=20').unsupportedTokens).toContain('BYWEEKNO')
  })

  it('defaults INTERVAL to 1', () => {
    expect(parseRrule('FREQ=YEARLY').interval).toBe(1)
  })
})

describe('parseIcsDate', () => {
  it('parses date-only', () => {
    expect(parseIcsDate('20260115')).toEqual(new Date(2026, 0, 15))
  })
  it('parses local datetime', () => {
    expect(parseIcsDate('20260115T143000')).toEqual(new Date(2026, 0, 15, 14, 30, 0))
  })
  it('parses Z-suffixed UTC datetime', () => {
    expect(parseIcsDate('20260115T143000Z')).toEqual(new Date(Date.UTC(2026, 0, 15, 14, 30, 0)))
  })
  it('returns null on garbage', () => {
    expect(parseIcsDate('not-a-date')).toBeNull()
  })
})

describe('expandRrule — daily', () => {
  it('emits N consecutive days', () => {
    const rule = parseRrule('FREQ=DAILY;COUNT=4')
    const out = expandRrule(D(2026, 1, 10, 9, 0), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(md(out.occurrences)).toEqual([
      [0, 10],
      [0, 11],
      [0, 12],
      [0, 13]
    ])
  })

  it('honours INTERVAL > 1', () => {
    const rule = parseRrule('FREQ=DAILY;INTERVAL=3;COUNT=3')
    const out = expandRrule(D(2026, 1, 10), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([10, 13, 16])
  })

  it('honours BYDAY as a weekday filter (every weekday rule)', () => {
    // Jan 5 2026 is a Monday. FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR — the
    // first 7 occurrences should be Mon-Fri, Mon-Tue (skipping Sat+Sun).
    const rule = parseRrule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=7')
    const out = expandRrule(D(2026, 1, 5), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 6, 7, 8, 9, 12, 13])
  })

  it('preserves wall-clock time across DST (US spring-forward)', () => {
    // 2026-03-08 is the US DST transition (02:00 → 03:00). A 09:00
    // local daily event for 3 days should stay 09:00 local on Mar 7/8/9.
    const rule = parseRrule('FREQ=DAILY;COUNT=3')
    const out = expandRrule(D(2026, 3, 7, 9, 0), rule, {
      windowStart: D(2026, 3, 1),
      windowEnd: D(2026, 3, 31)
    })
    expect(out.occurrences.length).toBe(3)
    for (const occ of out.occurrences) {
      expect(occ.getHours()).toBe(9)
      expect(occ.getMinutes()).toBe(0)
    }
  })

  it('stops at UNTIL (inclusive)', () => {
    const rule = parseRrule('FREQ=DAILY;UNTIL=20260112')
    const out = expandRrule(D(2026, 1, 10), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.length).toBe(3) // 10, 11, 12
  })

  it('excludes EXDATE matches', () => {
    const rule = parseRrule('FREQ=DAILY;COUNT=4')
    const out = expandRrule(D(2026, 1, 10), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      exDates: [D(2026, 1, 11)]
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([10, 12, 13])
  })

  it('emits in-window occurrences when DTSTART is years before the window', () => {
    // Previous safety cap killed this case — a 5-year-old daily
    // recurrence still needs to surface its in-window occurrences.
    const rule = parseRrule('FREQ=DAILY')
    const out = expandRrule(D(2021, 1, 1, 9, 0), rule, {
      windowStart: D(2026, 5, 1),
      windowEnd: D(2026, 5, 15)
    })
    expect(out.occurrences.length).toBe(14)
  })
})

describe('expandRrule — weekly', () => {
  it('plain weekly (no BYDAY) steps by 7 days', () => {
    const rule = parseRrule('FREQ=WEEKLY;COUNT=3')
    const out = expandRrule(D(2026, 1, 5), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 12, 19])
  })

  it('weekly + BYDAY emits each listed weekday', () => {
    const rule = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5')
    const out = expandRrule(D(2026, 1, 5), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 7, 9, 12, 14])
  })

  it('weekly + INTERVAL=2 skips alternate weeks', () => {
    const rule = parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3')
    const out = expandRrule(D(2026, 1, 5), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(md(out.occurrences)).toEqual([
      [0, 5],
      [0, 19],
      [1, 2]
    ])
  })

  it('preserves wall-clock time across DST in weekly BYDAY', () => {
    const rule = parseRrule('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4')
    const out = expandRrule(D(2026, 3, 3, 9, 0), rule, {
      windowStart: D(2026, 3, 1),
      windowEnd: D(2026, 3, 31)
    })
    expect(out.occurrences.length).toBe(4)
    for (const occ of out.occurrences) {
      expect(occ.getHours()).toBe(9)
    }
  })

  it('emits in-window weekly occurrences when DTSTART is years before the window', () => {
    const rule = parseRrule('FREQ=WEEKLY;BYDAY=MO')
    const out = expandRrule(D(2020, 1, 6, 9, 0), rule, {
      windowStart: D(2026, 5, 1),
      windowEnd: D(2026, 5, 31)
    })
    // Mondays in May 2026: 4, 11, 18, 25 → 4 occurrences
    expect(out.occurrences.length).toBe(4)
  })
})

describe('expandRrule — monthly + yearly', () => {
  it('monthly steps the calendar month', () => {
    const rule = parseRrule('FREQ=MONTHLY;COUNT=4')
    const out = expandRrule(D(2026, 1, 15), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(md(out.occurrences)).toEqual([
      [0, 15],
      [1, 15],
      [2, 15],
      [3, 15]
    ])
  })

  it('monthly skips months that lack the start day (Jan 31 → no Feb, then Mar 31)', () => {
    const rule = parseRrule('FREQ=MONTHLY;COUNT=4')
    const out = expandRrule(D(2026, 1, 31), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    // COUNT=4 → 4 generated candidates: Jan/Feb/Mar/Apr 31.
    // Only Jan 31 and Mar 31 exist; Feb and Apr 31 roll → skipped.
    expect(md(out.occurrences)).toEqual([
      [0, 31],
      [2, 31]
    ])
  })

  it('yearly steps the calendar year', () => {
    const rule = parseRrule('FREQ=YEARLY;COUNT=3')
    const out = expandRrule(D(2026, 6, 15), rule, {
      windowStart: D(2026, 1, 1),
      windowEnd: D(2030, 1, 1)
    })
    expect(out.occurrences.map((d) => d.getFullYear())).toEqual([2026, 2027, 2028])
  })

  it('yearly Feb 29 skips non-leap years', () => {
    const rule = parseRrule('FREQ=YEARLY;COUNT=5')
    const out = expandRrule(D(2024, 2, 29), rule, {
      windowStart: D(2024, 1, 1),
      windowEnd: D(2030, 1, 1)
    })
    // 5 generated candidates (2024..2028); only 2024 + 2028 are leap years.
    expect(out.occurrences.map((d) => d.getFullYear())).toEqual([2024, 2028])
    for (const occ of out.occurrences) {
      expect(occ.getMonth()).toBe(1) // Feb
      expect(occ.getDate()).toBe(29)
    }
  })
})

describe('expandRrule — UNSUPPORTED short-circuit', () => {
  it('returns empty when FREQ is unsupported (caller falls back to base)', () => {
    const rule = parseRrule('FREQ=SECONDLY;COUNT=10')
    expect(
      expandRrule(D(2026, 1, 1), rule, { windowStart: WINDOW_START, windowEnd: WINDOW_END })
        .occurrences
    ).toEqual([])
  })

  it('returns empty when an unsupported modifier (e.g. BYSETPOS) is present', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=TU')
    expect(
      expandRrule(D(2026, 1, 1), rule, { windowStart: WINDOW_START, windowEnd: WINDOW_END })
        .occurrences
    ).toEqual([])
  })

  it('returns empty when BYDAY is on MONTHLY (positional)', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYDAY=1MO')
    expect(
      expandRrule(D(2026, 1, 1), rule, { windowStart: WINDOW_START, windowEnd: WINDOW_END })
        .occurrences
    ).toEqual([])
  })
})

describe('expandRrule — bounds + edge cases', () => {
  it('respects the hard cap and reports truncation', () => {
    const rule = parseRrule('FREQ=DAILY')
    const out = expandRrule(D(2026, 1, 1), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      hardCap: 7
    })
    expect(out.occurrences.length).toBe(7)
    expect(out.truncated).toBe(true)
  })

  it('skips occurrences before windowStart', () => {
    const rule = parseRrule('FREQ=DAILY;COUNT=10')
    const out = expandRrule(D(2026, 1, 1), rule, {
      windowStart: D(2026, 1, 5),
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 6, 7, 8, 9, 10])
  })

  it('stops emitting at windowEnd (exclusive)', () => {
    const rule = parseRrule('FREQ=DAILY')
    const out = expandRrule(D(2026, 1, 1), rule, {
      windowStart: WINDOW_START,
      windowEnd: D(2026, 1, 5)
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([1, 2, 3, 4])
  })
})
