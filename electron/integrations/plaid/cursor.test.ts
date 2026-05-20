/**
 * Tests for cursor read/write helpers.
 *
 * These run against an in-memory better-sqlite3 with the minimum schema
 * needed (`plaid_items`) rather than the full migrations folder. Keeps the
 * tests fast and isolated from drift in unrelated tables.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema'

let sqlite: Database.Database

vi.mock('../../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
  // Tiny schema slice — just enough for cursor.ts to insert/update/select.
  sqlite.exec(`
    CREATE TABLE plaid_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL UNIQUE,
      institution_id TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      cursor TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );
  `)
})

afterEach(() => {
  sqlite.close()
})

function seedItem(itemId: string, cursor: string | null = null): void {
  sqlite
    .prepare(
      'INSERT INTO plaid_items (item_id, institution_id, institution_name, cursor) VALUES (?, ?, ?, ?)'
    )
    .run(itemId, 'ins_3', 'Chase', cursor)
}

describe('getCursor', () => {
  it('returns null when the Item has never been synced', async () => {
    seedItem('item-A', null)
    const { getCursor } = await import('./cursor')
    expect(getCursor('item-A')).toBeNull()
  })

  it('returns the stored cursor when present', async () => {
    seedItem('item-A', 'cursor-page-42')
    const { getCursor } = await import('./cursor')
    expect(getCursor('item-A')).toBe('cursor-page-42')
  })

  it('returns null when the Item is unknown (no throw)', async () => {
    // No row seeded for "item-ghost". A missing Item shouldn't crash the
    // read path — callers handle null as "treat as never-synced".
    const { getCursor } = await import('./cursor')
    expect(getCursor('item-ghost')).toBeNull()
  })
})

describe('setCursor', () => {
  it('persists the cursor on an existing Item', async () => {
    seedItem('item-A', null)
    const { setCursor, getCursor } = await import('./cursor')
    setCursor('item-A', 'cursor-page-1')
    expect(getCursor('item-A')).toBe('cursor-page-1')
  })

  it('overwrites a prior cursor (subsequent pages)', async () => {
    seedItem('item-A', 'cursor-page-1')
    const { setCursor, getCursor } = await import('./cursor')
    setCursor('item-A', 'cursor-page-2')
    expect(getCursor('item-A')).toBe('cursor-page-2')
  })

  it('is idempotent — setting the same cursor twice is a no-op-equivalent', async () => {
    seedItem('item-A', null)
    const { setCursor, getCursor } = await import('./cursor')
    setCursor('item-A', 'cursor-stable')
    setCursor('item-A', 'cursor-stable')
    expect(getCursor('item-A')).toBe('cursor-stable')
  })

  it('throws loudly when the Item does not exist', async () => {
    // Catching this in tests prevents the silent "stale cursor lost in the
    // void" failure mode in production — a missing Item row means the
    // surrounding code passed a bogus itemId.
    const { setCursor } = await import('./cursor')
    expect(() => setCursor('item-ghost', 'cursor-x')).toThrow(/no plaid_items row/)
  })
})
