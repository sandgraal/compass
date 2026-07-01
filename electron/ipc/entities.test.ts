/**
 * entities IPC (list + promote). Real in-memory SQLite with the records +
 * derived-entity projection + owned contacts/subscriptions tables. Seeds records,
 * builds the projection, then asserts `entities:list` reads it and
 * `entities:promote` materializes into the owned tables (reusing the real
 * contact/subscription writers) idempotently and flips the projection row.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { refreshDerivedEntities } from '../lib/entities-projection'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
const invoke = (channel: string, ...args: unknown[]): unknown => handlers[channel]({}, ...args)

function addRecord(
  source: string,
  type: string,
  title: string,
  body: string | null,
  occurredAt: number | null
): void {
  sqlite
    .prepare(
      'INSERT INTO records (source,type,title,body,occurred_at,dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(source, type, title, body, occurredAt, `${source}|${title}|${occurredAt}`)
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT, org TEXT, job_title TEXT,
      phones TEXT, emails TEXT, addresses TEXT, birthday TEXT, url TEXT, relationship TEXT, notes TEXT, photo TEXT,
      source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
      status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, payment_account TEXT, cancel_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
    CREATE UNIQUE INDEX derived_entities_kind_key ON derived_entities (kind, match_key);
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  const mod = await import('./entities')
  mod.registerEntitiesHandlers(fakeIpcMain as IpcMain)
})
afterEach(() => sqlite.close())

const day = (iso: string) => new Date(iso).getTime()

describe('entities:list', () => {
  it('returns the derived people, newest/most-touched first', () => {
    addRecord('linkedin', 'connection', 'Connected with Jane Doe', null, day('2026-01-01'))
    addRecord('facebook', 'connection', 'Became friends with Jane Doe', null, day('2026-02-01'))
    refreshDerivedEntities(drizzle(sqlite, { schema }))

    const people = invoke('entities:list', { kind: 'person' }) as Array<{
      name: string
      count: number
      sources: string[]
    }>
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('Jane Doe')
    expect(people[0].count).toBe(2)
    expect(people[0].sources).toEqual(['facebook', 'linkedin'])
  })

  it('rejects an unknown kind', () => {
    expect(() => invoke('entities:list', { kind: 'nope' })).toThrow()
  })

  it('filters by a query substring', () => {
    addRecord('linkedin', 'connection', 'Connected with Jane Doe', null, day('2026-01-01'))
    addRecord('linkedin', 'connection', 'Connected with Bob Smith', null, day('2026-01-02'))
    refreshDerivedEntities(drizzle(sqlite, { schema }))
    const hits = invoke('entities:list', { kind: 'person', q: 'jane' }) as Array<{ name: string }>
    expect(hits.map((h) => h.name)).toEqual(['Jane Doe'])
  })
})

describe('entities:refresh', () => {
  it('rebuilds the projection on demand and reports the count', () => {
    addRecord('linkedin', 'connection', 'Connected with Jane Doe', null, day('2026-01-01'))
    const res = invoke('entities:refresh') as { count: number }
    expect(res.count).toBeGreaterThan(0)
    const listed = invoke('entities:list', { kind: 'person' }) as unknown[]
    expect(listed).toHaveLength(1)
  })
})

describe('entities:promote', () => {
  it('promotes a person into contacts and flips the projection row', () => {
    addRecord('imessage', 'messages', '9 messages with Bob Smith', null, day('2026-01-01'))
    refreshDerivedEntities(drizzle(sqlite, { schema }))

    const res = invoke('entities:promote', { kind: 'person', key: 'bob smith' }) as {
      success: boolean
      promotedKind: string
      promotedId: number
    }
    expect(res.success).toBe(true)
    expect(res.promotedKind).toBe('contact')

    const contact = sqlite
      .prepare('SELECT display_name, external_id, source FROM contacts WHERE id = ?')
      .get(res.promotedId) as { display_name: string; external_id: string; source: string }
    expect(contact.display_name).toBe('Bob Smith')
    expect(contact.external_id).toBe('derived:person:bob smith')
    expect(contact.source).toBe('derived')

    // The projection row now reports it as promoted.
    const row = sqlite
      .prepare("SELECT promoted_kind, promoted_id FROM derived_entities WHERE kind='person'")
      .get() as { promoted_kind: string; promoted_id: number }
    expect(row.promoted_kind).toBe('contact')
    expect(row.promoted_id).toBe(res.promotedId)
  })

  it('is idempotent — promoting the same person twice yields one contact', () => {
    addRecord('imessage', 'messages', '9 messages with Bob Smith', null, day('2026-01-01'))
    refreshDerivedEntities(drizzle(sqlite, { schema }))
    invoke('entities:promote', { kind: 'person', key: 'bob smith' })
    invoke('entities:promote', { kind: 'person', key: 'bob smith' })
    const n = sqlite.prepare('SELECT COUNT(*) c FROM contacts').get() as { c: number }
    expect(n.c).toBe(1)
  })

  it('promotes a subscription candidate into the subscriptions table', () => {
    for (const d of ['2026-01-15', '2026-02-15', '2026-03-15'])
      addRecord('paypal', 'payment', 'Netflix', '-15.99 USD', day(d))
    refreshDerivedEntities(drizzle(sqlite, { schema }))

    const res = invoke('entities:promote', {
      kind: 'subscription-candidate',
      key: 'netflix'
    }) as { success: boolean; promotedKind: string; promotedId: number }
    expect(res.success).toBe(true)
    expect(res.promotedKind).toBe('subscription')

    const sub = sqlite
      .prepare('SELECT external_id, cadence, cost, source FROM subscriptions WHERE id = ?')
      .get(res.promotedId) as { external_id: string; cadence: string; cost: number; source: string }
    expect(sub.external_id).toBe('detected:netflix::paypal')
    expect(sub.cadence).toBe('monthly')
    expect(sub.cost).toBeCloseTo(15.99, 2)
    expect(sub.source).toBe('detected')
  })

  it('throws when the entity is not in the projection', () => {
    expect(() => invoke('entities:promote', { kind: 'person', key: 'ghost' })).toThrow()
  })

  it('does not support promoting a merchant yet', () => {
    addRecord('amazon', 'order', 'Widget', '$9.99', day('2026-01-01'))
    refreshDerivedEntities(drizzle(sqlite, { schema }))
    const res = invoke('entities:promote', { kind: 'merchant', key: 'amazon' }) as {
      success: boolean
      error: string
    }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/merchant/)
  })
})
