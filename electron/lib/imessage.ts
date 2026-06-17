/**
 * iMessage history recognizer (Phase 10.6 — "The Acquisition Engine").
 *
 * A dropped `chat.db` (the Messages database) is opened READ-ONLY and aggregated
 * into a daily messaging-activity timeline — one record per (day, conversation),
 * e.g. "23 messages with Alice".
 *
 * CONTENT-FREE: no message text / `attributedBody` / attachments — only counts +
 * conversation identifiers + dates (privacy-aligned, like email's headers-only).
 * Decoding message text from the `attributedBody` typedstream blob is a follow-up.
 *
 * The fiddly bits run IN SQL (SQLite int64, exact — so the nanosecond timestamps
 * never reach JS as a lossy Number, per the #201 review): the 2001 Cocoa epoch,
 * the nanoseconds-vs-seconds `date` format, and the per-day/per-conversation count.
 */

import type Database from 'better-sqlite3'
import type { RecordInput, SqliteRecognizer } from './recognizers'

const LIMIT = 200000

/** True when every named table exists in the DB. */
function hasTables(db: Database.Database, ...tables: string[]): boolean {
  const inList = tables.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${inList})`)
    .get(...tables) as { n: number }
  return row.n === tables.length
}

/** Local midnight (epoch ms) for a 'YYYY-MM-DD' string; null if unparseable. */
function dayMidnight(day: string): number | null {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

type DayRow = { day: string | null; chatId: number; conversation: string; n: number }

export const IMESSAGE_RECOGNIZER: SqliteRecognizer = {
  id: 'imessage',
  label: 'iMessage history',
  detect: (db) => hasTables(db, 'message', 'chat', 'chat_message_join'),
  parse: (db) => {
    const rows = db
      .prepare(
        "SELECT strftime('%Y-%m-%d', " +
          // chat.db `date` is nanoseconds-since-2001 on modern macOS, seconds-since-2001 on
          // older versions — normalise to seconds, then add the 2001→1970 offset.
          '(CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000 ELSE m.date END) + 978307200, ' +
          "'unixepoch', 'localtime') AS day, " +
          'c.ROWID AS chatId, ' +
          "COALESCE(c.display_name, c.chat_identifier, '?') AS conversation, " +
          'COUNT(*) AS n ' +
          'FROM message m ' +
          'JOIN chat_message_join cmj ON cmj.message_id = m.ROWID ' +
          'JOIN chat c ON c.ROWID = cmj.chat_id ' +
          'WHERE m.date > 0 ' +
          'GROUP BY day, c.ROWID ' +
          'ORDER BY day DESC LIMIT ?'
      )
      .all(LIMIT) as DayRow[]

    const out: RecordInput[] = []
    for (const r of rows) {
      if (!r.day) continue
      const occurredAt = dayMidnight(r.day)
      if (occurredAt == null) continue
      const conversation = r.conversation || '?'
      out.push({
        source: 'imessage',
        type: 'messages',
        occurredAt,
        title: `${r.n} message${r.n === 1 ? '' : 's'} with ${conversation}`,
        payload: { day: r.day, conversation, count: r.n },
        // Dedup on the chat's stable primary key, not the display label — labels
        // aren't unique and can be '?', which would collide distinct chats.
        naturalKey: `${r.day}|${r.chatId}`
      })
    }
    return out
  }
}
