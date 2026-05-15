/**
 * Apple Calendar (iCal) local read — May 2026 strategic-review Tier 3 #10.
 *
 * macOS Calendar.app keeps a per-account on-disk cache at
 * `~/Library/Calendars/`. Each calendar is a `.calendar` package
 * containing `Info.plist` (the human title, color) + `Events/<uid>.ics`
 * (one VCALENDAR per event). We walk that tree, parse the ICS files,
 * and surface VEVENTs that overlap a configurable lookahead window —
 * no OAuth, no network, no permission prompt beyond Full Disk Access
 * for the running terminal/Electron app.
 *
 * Limitations of this first cut (deliberate, called out in the
 * Integrations card UI):
 *   - RRULE expansion is NOT implemented. The base instance is emitted
 *     when its DTSTART lands in the window; future occurrences of a
 *     recurring event aren't materialised. Follow-up PR can layer
 *     `rrule.js` on top of this.
 *   - TZID-with-VTIMEZONE bodies are read as floating local time. For
 *     the dashboard "what's coming up" use case this is acceptable —
 *     Apple Calendar.app shows the same conversion. Cross-zone correctness
 *     would also be a follow-up.
 *   - We only read events; nothing here writes back.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AppleCalendarEvent = {
  uid: string
  calendarName: string
  title: string
  startAt: Date | null
  endAt: Date | null
  allDay: boolean
  location: string | null
  description: string | null
  recurring: boolean
}

const APPLE_CALENDARS_DIR = join(homedir(), 'Library', 'Calendars')

/** Unfold RFC 5545 line continuations: any line starting with SPACE/TAB joins to the previous. */
function unfoldIcs(raw: string): string[] {
  const out: string[] = []
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    if (out.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

/** Decode RFC 5545 escapes used in TEXT fields (`\n`, `\,`, `\;`, `\\`). */
function unescapeText(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/**
 * Parse a DTSTART / DTEND value into a Date and an "allDay" flag.
 * Supports three forms:
 *   - DATE:           `20260515`                            (all-day, midnight local)
 *   - DATE-TIME UTC:  `20260515T140000Z`                    (Zulu)
 *   - DATE-TIME local/floating: `20260515T140000`           (parsed as local time)
 *   - TZID-prefixed:  `DTSTART;TZID=America/New_York:...`   (handled before this fn)
 */
function parseDateValue(value: string, isDate: boolean): Date | null {
  if (isDate) {
    if (!/^\d{8}$/.test(value)) return null
    const y = Number.parseInt(value.slice(0, 4), 10)
    const m = Number.parseInt(value.slice(4, 6), 10) - 1
    const d = Number.parseInt(value.slice(6, 8), 10)
    return new Date(y, m, d)
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  const [, yy, mm, dd, hh, mi, ss, tz] = m
  const y = Number.parseInt(yy, 10)
  const mo = Number.parseInt(mm, 10) - 1
  const d = Number.parseInt(dd, 10)
  const h = Number.parseInt(hh, 10)
  const mn = Number.parseInt(mi, 10)
  const sec = Number.parseInt(ss, 10)
  return tz === 'Z' ? new Date(Date.UTC(y, mo, d, h, mn, sec)) : new Date(y, mo, d, h, mn, sec)
}

/**
 * Strip the property-name plus any parameters off the prefix, returning
 * `[name, params, value]`. e.g. `DTSTART;TZID=America/New_York:20260515T100000`
 * → `["DTSTART", { TZID: "America/New_York" }, "20260515T100000"]`.
 */
function splitProperty(
  line: string
): { name: string; params: Record<string, string>; value: string } | null {
  const colonIdx = line.indexOf(':')
  if (colonIdx === -1) return null
  const lhs = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1)
  const parts = lhs.split(';')
  const name = parts.shift()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq === -1) continue
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1)
  }
  return { name: name.toUpperCase(), params, value }
}

/**
 * Parse a single .ics file into zero or more VEVENT rows. Multi-event
 * files (rare but legal) are supported. Returns events without filtering
 * — the caller decides which window they care about.
 */
export function parseIcsFile(content: string, calendarName: string): AppleCalendarEvent[] {
  const lines = unfoldIcs(content)
  const events: AppleCalendarEvent[] = []
  let current: Partial<AppleCalendarEvent> | null = null
  let allDay = false

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = { calendarName, recurring: false }
      allDay = false
      continue
    }
    if (line === 'END:VEVENT') {
      if (current?.uid && current.title) {
        events.push({
          uid: current.uid,
          calendarName,
          title: current.title,
          startAt: current.startAt ?? null,
          endAt: current.endAt ?? null,
          allDay,
          location: current.location ?? null,
          description: current.description ?? null,
          recurring: current.recurring ?? false
        })
      }
      current = null
      continue
    }
    if (!current) continue

    const prop = splitProperty(line)
    if (!prop) continue

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value
        break
      case 'SUMMARY':
        current.title = unescapeText(prop.value)
        break
      case 'LOCATION':
        current.location = unescapeText(prop.value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(prop.value)
        break
      case 'DTSTART': {
        const isDate = prop.params.VALUE === 'DATE'
        if (isDate) allDay = true
        current.startAt = parseDateValue(prop.value, isDate)
        break
      }
      case 'DTEND': {
        const isDate = prop.params.VALUE === 'DATE'
        current.endAt = parseDateValue(prop.value, isDate)
        break
      }
      case 'RRULE':
        // Mark and surface — full expansion is a follow-up.
        current.recurring = true
        break
    }
  }

  return events
}

/** Walk `dir` recursively and return paths of every `.ics` file. */
function listIcsFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      out.push(...listIcsFiles(full))
    } else if (stat.isFile() && entry.endsWith('.ics')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Extract the human calendar title from a `.calendar` package's
 * `Info.plist`. We don't take a plist parser dep — the data we need is
 * a single `<key>Title</key><string>…</string>` pair and a regex is
 * faster than dragging in `plist`/`bplist-parser` just for one field.
 * Falls back to the directory's basename when the plist is missing or
 * malformed.
 */
function readCalendarTitle(calendarDir: string): string {
  const plistPath = join(calendarDir, 'Info.plist')
  try {
    if (existsSync(plistPath)) {
      const xml = readFileSync(plistPath, 'utf8')
      const match = xml.match(/<key>Title<\/key>\s*<string>([^<]+)<\/string>/)
      if (match) return match[1].trim()
    }
  } catch {
    /* fall through */
  }
  return (
    calendarDir
      .split('/')
      .pop()
      ?.replace(/\.calendar$/, '') ?? 'Calendar'
  )
}

export interface AppleCalendarReadOptions {
  /** Override the root path — used by unit tests. Defaults to `~/Library/Calendars`. */
  root?: string
  /** Inclusive start of the window. Defaults to `now`. */
  windowStart?: Date
  /** Exclusive end of the window. Defaults to `now + 14 days`. */
  windowEnd?: Date
}

/**
 * Read every VEVENT under the Apple Calendar tree that overlaps the
 * configured window. Returns events sorted by start time.
 */
export function readAppleCalendars(options: AppleCalendarReadOptions = {}): AppleCalendarEvent[] {
  const root = options.root ?? APPLE_CALENDARS_DIR
  const start = (options.windowStart ?? new Date()).getTime()
  const end = (options.windowEnd ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)).getTime()
  if (!existsSync(root)) return []

  const events: AppleCalendarEvent[] = []
  let calendarDirs: string[]
  try {
    calendarDirs = readdirSync(root).filter((name) => name.endsWith('.calendar'))
  } catch {
    return []
  }
  for (const dirName of calendarDirs) {
    const calendarDir = join(root, dirName)
    const title = readCalendarTitle(calendarDir)
    const eventsDir = join(calendarDir, 'Events')
    const icsFiles = listIcsFiles(eventsDir)
    for (const icsPath of icsFiles) {
      let content: string
      try {
        content = readFileSync(icsPath, 'utf8')
      } catch {
        continue
      }
      const parsed = parseIcsFile(content, title)
      for (const ev of parsed) {
        // Window filter — must overlap [start, end). For all-day events
        // with no DTEND, treat the day as 24h long. Recurring events
        // appear if their base DTSTART falls in the window (RRULE
        // expansion is a follow-up).
        if (!ev.startAt) continue
        const evStart = ev.startAt.getTime()
        const evEnd = ev.endAt
          ? ev.endAt.getTime()
          : ev.allDay
            ? evStart + 24 * 60 * 60 * 1000
            : evStart + 60 * 60 * 1000
        if (evEnd <= start || evStart >= end) continue
        events.push(ev)
      }
    }
  }

  events.sort((a, b) => {
    const ax = a.startAt?.getTime() ?? 0
    const bx = b.startAt?.getTime() ?? 0
    return ax - bx
  })
  return events
}

// Exported for unit tests that want to exercise the helpers without an
// end-to-end disk walk.
export const _internal = { unfoldIcs, unescapeText, parseDateValue, splitProperty }
