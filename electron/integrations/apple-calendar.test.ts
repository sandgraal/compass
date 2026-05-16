/**
 * Apple Calendar (iCal) parser tests. We never touch the host
 * filesystem here — every test feeds a synthetic ICS string through
 * `parseIcsFile` or builds a temp dir for `readAppleCalendars`. The
 * real `~/Library/Calendars` integration is covered by the smoke test
 * in the PR plan.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internal, parseIcsFile, readAppleCalendars } from './apple-calendar'

const { unfoldIcs, unescapeText, parseDateValue, splitProperty } = _internal

const BASE_VEVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-123
SUMMARY:Standup
DTSTART:20260515T140000Z
DTEND:20260515T143000Z
LOCATION:Office
DESCRIPTION:Daily standup\\, no laptops
END:VEVENT
END:VCALENDAR`

describe('unfoldIcs', () => {
  it('joins continuation lines (leading space)', () => {
    const raw = 'DESCRIPTION:hello\n world'
    expect(unfoldIcs(raw)).toEqual(['DESCRIPTION:helloworld'])
  })

  it('joins continuation lines (leading tab)', () => {
    const raw = 'X-FOO:line1\n\tcontinued'
    expect(unfoldIcs(raw)).toEqual(['X-FOO:line1continued'])
  })

  it('handles CRLF line endings', () => {
    const raw = 'A\r\nB\r\n'
    expect(unfoldIcs(raw)).toEqual(['A', 'B', ''])
  })
})

describe('unescapeText', () => {
  it('decodes \\n, \\,, \\;, \\\\', () => {
    expect(unescapeText('a\\nb\\,c\\;d\\\\e')).toBe('a\nb,c;d\\e')
  })

  it('also accepts \\N (uppercase) for newline', () => {
    expect(unescapeText('a\\Nb')).toBe('a\nb')
  })
})

describe('parseDateValue', () => {
  it('parses a Z-suffixed UTC date-time', () => {
    const d = parseDateValue('20260515T140000Z', false)
    expect(d?.toISOString()).toBe('2026-05-15T14:00:00.000Z')
  })

  it('parses a DATE-only value as midnight local', () => {
    const d = parseDateValue('20260515', true)
    expect(d?.getFullYear()).toBe(2026)
    expect(d?.getMonth()).toBe(4) // zero-indexed → May
    expect(d?.getDate()).toBe(15)
    expect(d?.getHours()).toBe(0)
  })

  it('returns null for malformed values', () => {
    expect(parseDateValue('garbage', false)).toBeNull()
    expect(parseDateValue('2026-05-15', false)).toBeNull()
    expect(parseDateValue('garbage', true)).toBeNull()
  })
})

describe('splitProperty', () => {
  it('parses a bare property', () => {
    expect(splitProperty('SUMMARY:Hello world')).toEqual({
      name: 'SUMMARY',
      params: {},
      value: 'Hello world'
    })
  })

  it('parses TZID and other parameters', () => {
    expect(splitProperty('DTSTART;TZID=America/New_York:20260515T100000')).toEqual({
      name: 'DTSTART',
      params: { TZID: 'America/New_York' },
      value: '20260515T100000'
    })
  })

  it('returns null when there is no colon', () => {
    expect(splitProperty('NO_COLON_HERE')).toBeNull()
  })
})

describe('parseIcsFile', () => {
  it('parses a single VEVENT with escaped description', () => {
    const events = parseIcsFile(BASE_VEVENT, 'Work')
    expect(events).toHaveLength(1)
    expect(events[0].uid).toBe('event-123')
    expect(events[0].title).toBe('Standup')
    expect(events[0].calendarName).toBe('Work')
    expect(events[0].location).toBe('Office')
    expect(events[0].description).toBe('Daily standup, no laptops')
    expect(events[0].allDay).toBe(false)
    expect(events[0].recurring).toBe(false)
    expect(events[0].startAt?.toISOString()).toBe('2026-05-15T14:00:00.000Z')
    expect(events[0].endAt?.toISOString()).toBe('2026-05-15T14:30:00.000Z')
  })

  it('flags all-day events from DTSTART;VALUE=DATE', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:allday
SUMMARY:Holiday
DTSTART;VALUE=DATE:20260704
END:VEVENT
END:VCALENDAR`
    const [ev] = parseIcsFile(ics, 'Personal')
    expect(ev.allDay).toBe(true)
    expect(ev.title).toBe('Holiday')
  })

  it('flags recurring events when RRULE is present', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly
SUMMARY:Team sync
DTSTART:20260515T140000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`
    const [ev] = parseIcsFile(ics, 'Work')
    expect(ev.recurring).toBe(true)
  })

  it('returns multiple events from a single file', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
SUMMARY:A
DTSTART:20260515T140000Z
END:VEVENT
BEGIN:VEVENT
UID:b
SUMMARY:B
DTSTART:20260516T140000Z
END:VEVENT
END:VCALENDAR`
    const events = parseIcsFile(ics, 'Work')
    expect(events.map((e) => e.uid)).toEqual(['a', 'b'])
  })

  it('skips events missing UID but keeps untitled events', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260515T140000Z
END:VEVENT
BEGIN:VEVENT
UID:has-uid-no-summary
DTSTART:20260515T140000Z
END:VEVENT
END:VCALENDAR`
    const events = parseIcsFile(ics, 'X')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ uid: 'has-uid-no-summary', title: '' })
  })
})

describe('readAppleCalendars', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'compass-cal-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeCalendar(name: string, title: string, events: string): void {
    const calDir = join(tmp, `${name}.calendar`)
    const eventsDir = join(calDir, 'Events')
    mkdirSync(eventsDir, { recursive: true })
    writeFileSync(
      join(calDir, 'Info.plist'),
      `<plist><dict><key>Title</key><string>${title}</string></dict></plist>`
    )
    writeFileSync(join(eventsDir, 'event.ics'), events)
  }

  it('returns events within the configured window', () => {
    makeCalendar('Work', 'Work', BASE_VEVENT)
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-05-01T00:00:00Z'),
      windowEnd: new Date('2026-05-31T00:00:00Z')
    })
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('Standup')
    expect(events[0].calendarName).toBe('Work')
  })

  it('filters events outside the window', () => {
    makeCalendar('Work', 'Work', BASE_VEVENT)
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-15T00:00:00Z')
    })
    expect(events).toHaveLength(0)
  })

  it('returns an empty array for a missing root', () => {
    expect(readAppleCalendars({ root: join(tmp, 'does-not-exist') })).toEqual([])
  })

  it('sorts events by start time', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:b
SUMMARY:B
DTSTART:20260520T140000Z
DTEND:20260520T150000Z
END:VEVENT
BEGIN:VEVENT
UID:a
SUMMARY:A
DTSTART:20260515T140000Z
DTEND:20260515T150000Z
END:VEVENT
END:VCALENDAR`
    makeCalendar('Mix', 'Mix', ics)
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-05-01T00:00:00Z'),
      windowEnd: new Date('2026-05-31T00:00:00Z')
    })
    expect(events.map((e) => e.uid)).toEqual(['a', 'b'])
  })

  it('reads the calendar title from Info.plist', () => {
    makeCalendar('home-7C5', 'Home', BASE_VEVENT)
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-05-01T00:00:00Z'),
      windowEnd: new Date('2026-05-31T00:00:00Z')
    })
    expect(events[0].calendarName).toBe('Home')
  })

  // ── RRULE expansion (Phase 5.13) ────────────────────────────────────────
  // End-to-end: a recurring event in an .ics file should materialise into
  // one row per occurrence inside the window, each with a unique uid so
  // the DB upsert keys don't collide.

  it('materializes a daily recurrence within the window', () => {
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-1
SUMMARY:Standup
DTSTART:20260601T140000Z
DTEND:20260601T143000Z
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T00:00:00Z')
    })
    expect(events).toHaveLength(5)
    expect(events.every((e) => e.recurring)).toBe(true)
    // Per-occurrence uid keeps DB upserts unique. The base occurrence
    // reuses the bare uid (so pre-RRULE-PR rows upsert in place);
    // subsequent occurrences get a `::ISO` suffix.
    const uids = events.map((e) => e.uid)
    expect(new Set(uids).size).toBe(5)
    expect(uids[0]).toBe('daily-1')
    for (const u of uids.slice(1)) {
      expect(u).toMatch(/^daily-1::/)
    }
  })

  it('honours EXDATE when materializing', () => {
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-2
SUMMARY:Standup
DTSTART:20260601T140000Z
DTEND:20260601T143000Z
RRULE:FREQ=DAILY;COUNT=5
EXDATE:20260602T140000Z
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T00:00:00Z')
    })
    // 5 occurrences − 1 EXDATE = 4
    expect(events).toHaveLength(4)
  })

  it('only emits occurrences inside the window, not the whole recurrence', () => {
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-3
SUMMARY:Standup
DTSTART:20260101T140000Z
DTEND:20260101T143000Z
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-08T00:00:00Z')
    })
    // 7-day window of a forever-daily recurrence → 7 rows.
    expect(events).toHaveLength(7)
  })

  it('merges RDATE additional occurrences alongside the RRULE expansion', () => {
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:rdate-1
SUMMARY:Standup with bonus day
DTSTART:20260601T140000Z
DTEND:20260601T143000Z
RRULE:FREQ=DAILY;COUNT=2
RDATE:20260604T140000Z
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T00:00:00Z')
    })
    // RRULE COUNT=2 → June 1, 2. RDATE adds June 4. Total 3.
    expect(events).toHaveLength(3)
    const dates = events.map((e) => (e.startAt as Date).toISOString().slice(0, 10)).sort()
    expect(dates).toEqual(['2026-06-01', '2026-06-02', '2026-06-04'])
  })

  it('falls back to base instance only when RRULE has unsupported tokens', () => {
    // BYSETPOS triggers the unsupported-token short-circuit. The user
    // still sees one row (the base) so the event isn't silently dropped.
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:positional-1
SUMMARY:Last Tuesday of the month
DTSTART:20260601T140000Z
DTEND:20260601T143000Z
RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T00:00:00Z')
    })
    expect(events).toHaveLength(1)
    expect(events[0].uid).toBe('positional-1')
  })

  it('preserves duration on materialized occurrences', () => {
    makeCalendar(
      'Work',
      'Work',
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Long meeting
DTSTART:20260601T140000Z
DTEND:20260601T160000Z
RRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
END:VCALENDAR`
    )
    const events = readAppleCalendars({
      root: tmp,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T00:00:00Z')
    })
    expect(events).toHaveLength(2)
    for (const ev of events) {
      expect(ev.endAt && ev.startAt).toBeTruthy()
      const durMs = (ev.endAt as Date).getTime() - (ev.startAt as Date).getTime()
      expect(durMs).toBe(2 * 60 * 60 * 1000)
    }
  })
})
