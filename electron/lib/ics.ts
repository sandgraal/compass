/**
 * iCalendar (ICS) serializer (Phase 9 — "The Storehouse", Wave 1).
 *
 * The inverse of the read-only ICS parser in
 * `electron/integrations/apple-calendar.ts`. That module turns `.ics` files into
 * rows; this one turns `calendar_events` rows back into a single portable
 * `VCALENDAR` so the Export Center can hand the user a file every calendar app
 * can re-import. Round-trip is verified against the real parser in the tests.
 *
 * This cut emits non-recurring VEVENTs (one row = one event); the synced rows we
 * export have already had any recurrence expanded into individual instances.
 */

export interface IcsEventInput {
  externalId: string
  title: string
  startAt: Date | number | null
  endAt?: Date | number | null
  allDay?: boolean | null
  location?: string | null
  description?: string | null
}

/** Escape an iCalendar TEXT value (RFC 5545 §3.3.11). */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Fold a content line at 75 octets (continuation lines start with a space). */
function foldLine(line: string): string {
  const MAX = 75
  if (Buffer.byteLength(line, 'utf8') <= MAX) return line
  const segments: string[] = []
  let cur = ''
  let curBytes = 0
  let first = true
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    const limit = first ? MAX : MAX - 1
    if (curBytes + chBytes > limit) {
      segments.push(cur)
      first = false
      cur = ch
      curBytes = chBytes
    } else {
      cur += ch
      curBytes += chBytes
    }
  }
  segments.push(cur)
  return segments.map((seg, i) => (i === 0 ? seg : ` ${seg}`)).join('\r\n')
}

function toDate(v: Date | number | null | undefined): Date | null {
  if (v == null) return null
  return v instanceof Date ? v : new Date(v)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Format a timed value as a UTC date-time: `YYYYMMDDTHHMMSSZ`. */
function fmtUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

/** Format an all-day value as a floating DATE: `YYYYMMDD` (UTC calendar day). */
function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

/**
 * Serialize events into one VCALENDAR string. Events without a start time are
 * skipped (nothing to anchor them to).
 */
export function serializeIcs(
  events: IcsEventInput[],
  opts: { calendarName?: string } = {}
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Compass//Storehouse Export//EN',
    'CALSCALE:GREGORIAN'
  ]
  if (opts.calendarName) lines.push(foldLine(`X-WR-CALNAME:${escapeText(opts.calendarName)}`))

  for (const ev of events) {
    const start = toDate(ev.startAt)
    if (!start) continue
    const end = toDate(ev.endAt)
    lines.push('BEGIN:VEVENT')
    lines.push(foldLine(`UID:${ev.externalId}`))
    lines.push(foldLine(`SUMMARY:${escapeText(ev.title ?? '')}`))
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(start)}`)
      if (end) lines.push(`DTEND;VALUE=DATE:${fmtDate(end)}`)
    } else {
      lines.push(`DTSTART:${fmtUtc(start)}`)
      if (end) lines.push(`DTEND:${fmtUtc(end)}`)
    }
    if (ev.location) lines.push(foldLine(`LOCATION:${escapeText(ev.location)}`))
    if (ev.description) lines.push(foldLine(`DESCRIPTION:${escapeText(ev.description)}`))
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
