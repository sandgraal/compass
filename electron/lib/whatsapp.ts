/**
 * WhatsApp chat-export recognizer (Phase 10 — "The Acquisition Engine").
 *
 * A dropped "WhatsApp Chat with X.txt" (in-app Export Chat, text-only) becomes a
 * daily messaging-activity timeline — one record per day, "23 messages with X" —
 * exactly like the iMessage recognizer.
 *
 * CONTENT-FREE by design: no message text, only per-day counts + the chat name
 * (from the filename). Matches the established privacy posture for personal
 * messaging (iMessage, email headers). Emitting `type: 'messages'` with the
 * "N messages with <chat>" title means the existing `extractPersonName` +
 * People directory pick up the conversation partner for free.
 *
 * FORMAT CAVEAT: WhatsApp's line format varies by platform + locale (iOS
 * `[M/D/YY, h:mm:ss AM/PM] Sender:` vs Android `M/D/YY, h:mm - Sender:`), and the
 * date is parsed as US M/D/Y (via the shared `parseWhen`) — a D/M/Y-locale export
 * may bucket some messages on the wrong day. Unvalidated against every locale;
 * sharpen when a non-US real export lands.
 */

import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

// A message line STARTS with a timestamp. iOS wraps it in [ … ]; Android uses a
// trailing " - ". Continuation lines of a multi-line message have no timestamp
// and are skipped, so each counted line is exactly one message.
const IOS_LINE = /^‎?\[(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\]/i
const ANDROID_LINE =
  /^(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\s+-\s+/i

/** Extract the chat partner from "WhatsApp Chat with Alice.txt" → "Alice". */
function chatFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const m = base.match(/whatsapp chat with\s+(.+)$/i)
  if (m) return m[1].trim()
  if (/^_?chat$/i.test(base)) return 'WhatsApp' // generic in-app export name
  return base
}

/** Pull the leading 'M/D/YY' (or 'M.D.YY') date from a message line, or null. */
function lineDate(line: string): string | null {
  const m = line.match(/^‎?\[?(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/)
  if (!m) return null
  return m[1].replace(/\./g, '/')
}

export const WHATSAPP_RECOGNIZER: Recognizer = {
  id: 'whatsapp',
  label: 'WhatsApp chat export',
  detect: (f) => {
    if (f.ext !== 'txt') return false
    if (/whatsapp/i.test(f.name)) return true
    // Sniff the first few non-empty lines for the WhatsApp line shape.
    const lines = f.text.split('\n').slice(0, 10)
    return lines.some((l) => IOS_LINE.test(l) || ANDROID_LINE.test(l))
  },
  parse: (f) => {
    const chat = chatFromName(f.name)
    const perDay = new Map<string, { count: number; when: number | null }>()
    for (const line of f.text.split('\n')) {
      if (!IOS_LINE.test(line) && !ANDROID_LINE.test(line)) continue // continuation / blank
      const rawDate = lineDate(line)
      if (!rawDate) continue
      const when = parseWhen(rawDate)
      // Bucket by the parsed calendar day (or the raw token when unparseable, so
      // counts still aggregate rather than scattering one-per-line).
      const key = when != null ? new Date(when).toISOString().slice(0, 10) : rawDate
      const bucket = perDay.get(key)
      if (bucket) bucket.count++
      else perDay.set(key, { count: 1, when })
    }

    const out: RecordInput[] = []
    for (const [day, { count, when }] of perDay) {
      out.push({
        source: 'whatsapp',
        type: 'messages',
        occurredAt: when,
        title: `${count} message${count === 1 ? '' : 's'} with ${chat}`,
        payload: { day, conversation: chat, count },
        naturalKey: `${day}|${chat}`
      })
    }
    return out
  }
}
