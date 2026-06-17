/**
 * Tests for the iMessage history recognizer (Phase 10.5). Builds a synthetic
 * chat.db and checks the daily (day, conversation) aggregation + both date formats.
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { recognizeSqlite } from './recognizers'

// Nanoseconds-since-2001 (modern macOS) for a given UTC day/hour. Returns BigInt —
// the real values exceed Number.MAX_SAFE_INTEGER, so the fixture binds exact ints.
function ns(day: number, hour: number): bigint {
  const secondsSince2001 = Date.UTC(2026, 0, day, hour, 0, 0) / 1000 - 978307200
  return BigInt(secondsSince2001) * 1000000000n
}

function newChatDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER)')
  db.exec('CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT)')
  db.exec('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)')
  return db
}

describe('iMessage recognizer', () => {
  it('aggregates messages per day + conversation (content-free)', () => {
    const db = newChatDb()
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (1, ?, NULL)').run(
      'alice@example.com'
    )
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (2, ?, ?)').run(
      'chat-xyz',
      'Family'
    )
    const msg = db.prepare('INSERT INTO message (ROWID, date) VALUES (?, ?)')
    const join = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)')
    // Jan 2 (midday UTC): 2 with Alice + 1 with Family; Jan 3: 1 with Alice.
    msg.run(1, ns(2, 12))
    join.run(1, 1)
    msg.run(2, ns(2, 13))
    join.run(1, 2)
    msg.run(3, ns(2, 14))
    join.run(2, 3)
    msg.run(4, ns(3, 12))
    join.run(1, 4)

    const rec = recognizeSqlite(db)
    expect(rec?.id).toBe('imessage')
    const out = rec?.parse(db) ?? []
    db.close()

    expect(out).toHaveLength(3) // (Jan2, Alice) (Jan2, Family) (Jan3, Alice)
    const titles = out.map((r) => r.title)
    expect(titles).toContain('2 messages with alice@example.com')
    expect(titles).toContain('1 message with Family')
    expect(out.every((r) => r.source === 'imessage' && typeof r.occurredAt === 'number')).toBe(true)
    // content-free — no message body is ever read or stored
    expect(out.every((r) => r.body === undefined)).toBe(true)
  })

  it('handles the legacy seconds-since-2001 date format', () => {
    const db = newChatDb()
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (1, ?, NULL)').run(
      'old@x.com'
    )
    const secs = Date.UTC(2025, 5, 15, 12, 0, 0) / 1000 - 978307200 // seconds since 2001 (small int)
    db.prepare('INSERT INTO message (ROWID, date) VALUES (1, ?)').run(secs)
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)').run()

    const out = recognizeSqlite(db)?.parse(db) ?? []
    db.close()
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('1 message with old@x.com')
    expect(typeof out[0].occurredAt).toBe('number')
  })
})
