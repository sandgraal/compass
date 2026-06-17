/**
 * Tests for the browser-history SQLite recognizers (Phase 10.4). Builds a tiny
 * in-memory fixture DB per browser and checks detection + the three visit-time
 * epoch conversions.
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { recognizeSqlite } from './recognizers'

describe('browser history recognizers', () => {
  it('Chrome (urls/visits) — microseconds since 1601', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)')
    db.exec('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)')
    db.prepare('INSERT INTO urls (id, url, title) VALUES (1, ?, ?)').run(
      'https://example.com/x',
      'Example'
    )
    db.prepare('INSERT INTO visits (url, visit_time) VALUES (1, ?)').run(13350000000000000)

    const rec = recognizeSqlite(db)
    expect(rec?.id).toBe('chrome')
    const out = rec?.parse(db) ?? []
    db.close()

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'browser',
      type: 'visit',
      title: 'Example',
      body: 'example.com'
    })
    expect(out[0].occurredAt).toBe(13350000000000000 / 1000 - 11644473600000)
  })

  it('Firefox (moz_places/moz_historyvisits) — microseconds since 1970', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT)')
    db.exec(
      'CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER)'
    )
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (1, ?, ?)').run(
      'https://ff.org/p',
      'FF'
    )
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (1, ?)').run(
      1767225600000000
    )

    const rec = recognizeSqlite(db)
    expect(rec?.id).toBe('firefox')
    const out = rec?.parse(db) ?? []
    db.close()
    expect(out[0].occurredAt).toBe(1767225600000000 / 1000)
    expect(out[0].body).toBe('ff.org')
  })

  it('Safari (history_items/history_visits) — seconds since 2001', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT)')
    db.exec(
      'CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, title TEXT, visit_time REAL)'
    )
    db.prepare('INSERT INTO history_items (id, url) VALUES (1, ?)').run('https://apple.com/s')
    db.prepare('INSERT INTO history_visits (history_item, title, visit_time) VALUES (1, ?, ?)').run(
      'Apple',
      760000000
    )

    const rec = recognizeSqlite(db)
    expect(rec?.id).toBe('safari')
    const out = rec?.parse(db) ?? []
    db.close()
    expect(out[0].occurredAt).toBe((760000000 + 978307200) * 1000)
    expect(out[0].title).toBe('Apple')
  })

  it('returns null for an unrecognized schema', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE foo (id INTEGER)')
    expect(recognizeSqlite(db)).toBeNull()
    db.close()
  })
})
