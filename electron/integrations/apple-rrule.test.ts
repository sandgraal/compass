/**
 * Tests for the minimal RRULE expander. Two layers:
 *   - Parser tests lock in how each RRULE token maps onto the
 *     `ParsedRrule` shape — including the unsupported-token bag the
 *     reader uses to warn on `BYSETPOS` etc.
 *   - Expander tests use a fixed `start` + window so the materialized
 *     occurrences are stable across runs / timezones.
 *
 * No real Calendar.app data is touched here; the bigger end-to-end
 * tests for `readAppleCalendars` already cover the file-walk path.
 */

import { describe, expect, it } from 'vitest'
import { expandRrule, parseIcsDate, parseRrule } from './apple-rrule'

const D = (y: number, m: number, d: number, h = 0, mi = 0): Date =>
  new Date(Date.UTC(y, m - 1, d, h, mi))

const WINDOW_START = D(2026, 1, 1)
const WINDOW_END = D(2026, 12, 31, 23, 59)

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

  it('parses BYDAY and drops numeric prefixes', () => {
    const r = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR,1TU')
    expect(r.byDay).toEqual(['MO', 'WE', 'FR', 'TU'])
  })

  it('coerces unknown FREQ to UNSUPPORTED', () => {
    const r = parseRrule('FREQ=SECONDLY;INTERVAL=10')
    expect(r.freq).toBe('UNSUPPORTED')
  })

  it('collects recognised-but-unimplemented tokens', () => {
    const r = parseRrule('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=TU')
    expect(r.unsupportedTokens).toContain('BYSETPOS')
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
    const start = D(2026, 1, 10, 9, 0)
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-01-10',
      '2026-01-11',
      '2026-01-12',
      '2026-01-13'
    ])
  })

  it('honours INTERVAL > 1', () => {
    const rule = parseRrule('FREQ=DAILY;INTERVAL=3;COUNT=3')
    const start = D(2026, 1, 10)
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    const days = out.occurrences.map((d) => d.getDate())
    expect(days).toEqual([10, 13, 16])
  })

  it('stops at UNTIL (inclusive)', () => {
    const rule = parseRrule('FREQ=DAILY;UNTIL=20260112')
    const start = D(2026, 1, 10)
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.length).toBe(3) // 10, 11, 12
  })

  it('excludes EXDATE matches', () => {
    const rule = parseRrule('FREQ=DAILY;COUNT=4')
    const start = D(2026, 1, 10)
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      exDates: [D(2026, 1, 11)]
    })
    const days = out.occurrences.map((d) => d.getDate())
    expect(days).toEqual([10, 12, 13])
  })
})

describe('expandRrule — weekly', () => {
  it('plain weekly (no BYDAY) steps by 7 days', () => {
    const rule = parseRrule('FREQ=WEEKLY;COUNT=3')
    const start = D(2026, 1, 5) // Monday
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 12, 19])
  })

  it('weekly + BYDAY emits each listed weekday', () => {
    // Start on a Monday so the first emitted MO matches start; then WE
    // and FR of the same week, then next MO/WE/FR. COUNT caps at 5.
    const rule = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5')
    const start = D(2026, 1, 5) // Monday
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 7, 9, 12, 14])
  })

  it('weekly + INTERVAL=2 skips alternate weeks', () => {
    const rule = parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3')
    const start = D(2026, 1, 5) // Monday
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 19, 2])
    // Last one is Feb 2 (month 1 indexed)
    expect(out.occurrences[2].getMonth()).toBe(1)
  })
})

describe('expandRrule — monthly + yearly', () => {
  it('monthly steps the calendar month', () => {
    const rule = parseRrule('FREQ=MONTHLY;COUNT=4')
    const start = D(2026, 1, 15)
    const out = expandRrule(start, rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences.map((d) => d.getMonth())).toEqual([0, 1, 2, 3])
    expect(out.occurrences.every((d) => d.getDate() === 15)).toBe(true)
  })

  it('yearly steps the calendar year', () => {
    const rule = parseRrule('FREQ=YEARLY;COUNT=3')
    const start = D(2026, 6, 15)
    const out = expandRrule(start, rule, {
      windowStart: D(2026, 1, 1),
      windowEnd: D(2030, 1, 1)
    })
    expect(out.occurrences.map((d) => d.getFullYear())).toEqual([2026, 2027, 2028])
  })
})

describe('expandRrule — safety + edge cases', () => {
  it('UNSUPPORTED FREQ returns empty', () => {
    const rule = parseRrule('FREQ=SECONDLY;COUNT=10')
    const out = expandRrule(D(2026, 1, 1), rule, {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END
    })
    expect(out.occurrences).toEqual([])
  })

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
    // First six occurrences (Jan 1-4) are before window, so window
    // emits Jan 5..10 (six dates).
    expect(out.occurrences.map((d) => d.getDate())).toEqual([5, 6, 7, 8, 9, 10])
  })

  it('stops emitting when windowEnd is reached', () => {
    const rule = parseRrule('FREQ=DAILY')
    const out = expandRrule(D(2026, 1, 1), rule, {
      windowStart: WINDOW_START,
      windowEnd: D(2026, 1, 5)
    })
    // Inclusive 1..4, exclusive 5
    expect(out.occurrences.map((d) => d.getDate())).toEqual([1, 2, 3, 4])
  })
})
