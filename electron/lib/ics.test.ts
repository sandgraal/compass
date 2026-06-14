import { describe, expect, it } from 'vitest'
import { parseIcsFile } from '../integrations/apple-calendar'
import { type IcsEventInput, serializeIcs } from './ics'

describe('serializeIcs', () => {
  it('serializes a timed event that the real parser reads back identically', () => {
    const start = new Date(Date.UTC(2026, 5, 15, 14, 0, 0))
    const end = new Date(Date.UTC(2026, 5, 15, 15, 0, 0))
    const events: IcsEventInput[] = [
      {
        externalId: 'evt-1',
        title: 'Strategy sync',
        startAt: start,
        endAt: end,
        location: 'Room 4',
        description: 'Quarterly planning'
      }
    ]
    const ics = serializeIcs(events)
    const [parsed] = parseIcsFile(ics, 'Export')
    expect(parsed.uid).toBe('evt-1')
    expect(parsed.title).toBe('Strategy sync')
    expect(parsed.location).toBe('Room 4')
    expect(parsed.description).toBe('Quarterly planning')
    expect(parsed.startAt?.getTime()).toBe(start.getTime())
    expect(parsed.endAt?.getTime()).toBe(end.getTime())
  })

  it('serializes an all-day event as a DATE value', () => {
    const events: IcsEventInput[] = [
      { externalId: 'all-1', title: 'Holiday', startAt: Date.UTC(2026, 6, 4), allDay: true }
    ]
    const ics = serializeIcs(events)
    expect(ics).toContain('DTSTART;VALUE=DATE:20260704')
    const [parsed] = parseIcsFile(ics, 'Export')
    expect(parsed.allDay).toBe(true)
    expect(parsed.title).toBe('Holiday')
  })

  it('accepts epoch-ms timestamps as well as Date objects', () => {
    const ms = Date.UTC(2026, 0, 1, 9, 30, 0)
    const ics = serializeIcs([{ externalId: 'ms-1', title: 'NY', startAt: ms }])
    const [parsed] = parseIcsFile(ics, 'Export')
    expect(parsed.startAt?.getTime()).toBe(ms)
  })

  it('escapes commas and semicolons in SUMMARY', () => {
    const ics = serializeIcs([
      { externalId: 'e', title: 'Lunch, then; review', startAt: Date.UTC(2026, 1, 2, 12) }
    ])
    expect(ics).toContain('SUMMARY:Lunch\\, then\\; review')
    const [parsed] = parseIcsFile(ics, 'Export')
    expect(parsed.title).toBe('Lunch, then; review')
  })

  it('skips events without a start time and wraps in VCALENDAR', () => {
    const ics = serializeIcs([{ externalId: 'no-start', title: 'Ghost', startAt: null }])
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('END:VCALENDAR')
    expect(parseIcsFile(ics, 'Export')).toHaveLength(0)
  })
})
