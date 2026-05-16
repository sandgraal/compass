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
 * Limitations of this cut:
 *   - **RRULE expansion is supported** (Phase 5.13) via the in-house
 *     `apple-rrule.ts` expander for the common DAILY/WEEKLY/MONTHLY/
 *     YEARLY + INTERVAL/COUNT/UNTIL/BYDAY/EXDATE subset. Unsupported
 *     tokens fall through to "base instance only" with a console
 *     warning, so a third-Tuesday-of-the-month rule still surfaces
 *     its base event but won't materialize future occurrences.
 *   - TZID-with-VTIMEZONE bodies are read as floating local time. For
 *     the dashboard "what's coming up" use case this is acceptable —
 *     Apple Calendar.app shows the same conversion. Cross-zone correctness
 *     would also be a follow-up.
 *   - We only read events; nothing here writes back.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandRrule, parseRrule } from './apple-rrule'

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

/**
 * Internal-only — includes the raw recurrence tokens so the reader
 * can materialize occurrences. The `AppleCalendarEvent` type the
 * sync layer consumes doesn't expose them.
 */
type ParsedVEvent = AppleCalendarEvent & {
  _rrule?: string
  _exDates?: Date[]
  _rDates?: Date[]
  _durationMs?: number
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
  return parseIcsFileInternal(content, calendarName)
}

/**
 * Internal variant that also returns the raw `_rrule`/`_exDates` tokens.
 * `readAppleCalendars` uses this to materialize occurrences; external
 * callers (and the public `parseIcsFile` re-export) get the plain shape.
 */
function parseIcsFileInternal(content: string, calendarName: string): ParsedVEvent[] {
  const lines = unfoldIcs(content)
  const events: ParsedVEvent[] = []
  let current: Partial<ParsedVEvent> | null = null
  let allDay = false

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = { calendarName, recurring: false }
      allDay = false
      continue
    }
    if (line === 'END:VEVENT') {
      if (current?.uid) {
        // Derive a default duration so materialized occurrences keep
        // the same length as the base event. Defaults: 24h for all-day,
        // 1h otherwise.
        let durationMs: number | undefined
        if (current.startAt && current.endAt) {
          durationMs = current.endAt.getTime() - current.startAt.getTime()
        } else if (current.startAt) {
          durationMs = allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
        }
        events.push({
          uid: current.uid,
          calendarName,
          title: current.title ?? '',
          startAt: current.startAt ?? null,
          endAt: current.endAt ?? null,
          allDay,
          location: current.location ?? null,
          description: current.description ?? null,
          recurring: current.recurring ?? false,
          _rrule: current._rrule,
          _exDates: current._exDates,
          _rDates: current._rDates,
          _durationMs: durationMs
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
        current.recurring = true
        current._rrule = prop.value
        break
      case 'EXDATE': {
        // EXDATE may carry one or more comma-separated date(-time)s.
        // Each one is a specific occurrence to skip.
        const isDate = prop.params.VALUE === 'DATE'
        const stamps = prop.value
          .split(',')
          .map((s) => parseDateValue(s.trim(), isDate))
          .filter((d): d is Date => d instanceof Date)
        if (stamps.length > 0) {
          current._exDates = [...(current._exDates ?? []), ...stamps]
        }
        break
      }
      case 'RDATE': {
        // RDATE is a VEVENT-level property that adds extra occurrences
        // alongside any RRULE expansion. May be a comma-separated list
        // of dates or date-times. Period values (DTSTART/DURATION)
        // aren't supported — those rows fall through as unparseable.
        const isDate = prop.params.VALUE === 'DATE'
        const stamps = prop.value
          .split(',')
          .map((s) => parseDateValue(s.trim(), isDate))
          .filter((d): d is Date => d instanceof Date)
        if (stamps.length > 0) {
          current._rDates = [...(current._rDates ?? []), ...stamps]
        }
        break
      }
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
      const parsed = parseIcsFileInternal(content, title)
      for (const ev of parsed) {
        if (!ev.startAt) continue
        const durationMs = ev._durationMs ?? (ev.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000)

        if (ev._rrule || (ev._rDates && ev._rDates.length > 0)) {
          // Materialize each occurrence in the window. The expander
          // returns the base occurrence too (when in range), so we
          // don't separately push the parsed event. RDATE values are
          // merged in alongside the RRULE expansion — they're
          // additional occurrences regardless of the RRULE.
          const rule = ev._rrule
            ? parseRrule(ev._rrule)
            : {
                freq: 'UNSUPPORTED' as const,
                interval: 1,
                count: null,
                until: null,
                byDay: null,
                unsupportedTokens: []
              }
          const expansion = ev._rrule
            ? expandRrule(ev.startAt, rule, {
                windowStart: options.windowStart ?? new Date(start),
                windowEnd: options.windowEnd ?? new Date(end),
                exDates: ev._exDates
              })
            : { occurrences: [] as Date[], truncated: false }
          if (expansion.truncated) {
            console.warn(`[apple-calendar] RRULE expansion truncated at hard cap for ${ev.uid}`)
          }
          if (rule.unsupportedTokens.length > 0) {
            console.warn(
              `[apple-calendar] RRULE tokens not implemented (${rule.unsupportedTokens.join(', ')}) for ${ev.uid} — falling back to base instance only`
            )
          }

          // RDATE: additional explicit occurrences, filtered to window
          // and EXDATE-aware.
          const exSet = new Set((ev._exDates ?? []).map((d) => d.getTime()))
          const rDateOccs = (ev._rDates ?? []).filter((d) => {
            const t = d.getTime()
            if (exSet.has(t)) return false
            if (t < start) return false
            if (t >= end) return false
            return true
          })

          // De-dupe a date that appears in BOTH RRULE expansion AND
          // RDATE (rare but legal) by keying on exact ms.
          const seen = new Set<number>()
          const allOccs: Date[] = []
          for (const occ of [...expansion.occurrences, ...rDateOccs]) {
            const t = occ.getTime()
            if (seen.has(t)) continue
            seen.add(t)
            allOccs.push(occ)
          }

          for (const occStart of allOccs) {
            const occEnd = new Date(occStart.getTime() + durationMs)
            const occurrenceUid =
              occStart.getTime() === ev.startAt.getTime()
                ? ev.uid
                : `${ev.uid}::${occStart.toISOString()}`
            events.push({
              // Preserve the legacy base uid for the base occurrence so
              // existing synced rows continue to upsert in place. Use a
              // per-occurrence id for all other instances.
              uid: occurrenceUid,
              calendarName: title,
              title: ev.title,
              startAt: occStart,
              endAt: occEnd,
              allDay: ev.allDay,
              location: ev.location,
              description: ev.description,
              recurring: true
            })
          }

          // Fallback: if expansion produced nothing AND no RDATEs, but
          // the rule had recognised content, still surface the base so
          // the user sees "this event exists" (with a warning log via
          // unsupportedTokens above).
          if (allOccs.length === 0 && ev._rrule) {
            const evStart = ev.startAt.getTime()
            const evEnd = evStart + durationMs
            if (evEnd > start && evStart < end) {
              const { _rrule, _exDates, _rDates, _durationMs, ...rest } = ev
              events.push(rest)
            }
          }
          continue
        }

        // Non-recurring path — same window filter as before.
        const evStart = ev.startAt.getTime()
        const evEnd = ev.endAt ? ev.endAt.getTime() : evStart + durationMs
        if (evEnd <= start || evStart >= end) continue
        const { _rrule, _exDates, _rDates, _durationMs, ...rest } = ev
        events.push(rest)
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
