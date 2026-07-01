/**
 * people:list IPC. Real in-memory SQLite (records + contacts + the derived-entity
 * projection). people:list now READS the `kind='person'` projection the engine
 * builds, so each test seeds records, runs `refreshDerivedEntities`, then asserts
 * the handler maps the projection into the Person directory (timestamps, sources,
 * contact match). The derivation itself is covered in electron/lib/entities.test.ts.
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

function addRecord(source: string, type: string, title: string, occurredAt: number | null): void {
  sqlite
    .prepare('INSERT INTO records (source,type,occurred_at,title,dedup_hash) VALUES (?,?,?,?,?)')
    .run(source, type, occurredAt, title, `${source}|${title}`)
}

/** Rebuild the projection from the seeded records, then invoke people:list. */
async function listPeople(): Promise<Person[]> {
  refreshDerivedEntities(drizzle(sqlite, { schema }))
  return handlers['people:list']({}) as Promise<Person[]>
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT
    );
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
    CREATE UNIQUE INDEX derived_entities_kind_key ON derived_entities (kind, match_key);
    CREATE TABLE places (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
      name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  const mod = await import('./people')
  mod.registerPeopleHandlers(fakeIpcMain as IpcMain)
})
afterEach(() => sqlite.close())

type Person = { name: string; count: number; sources: string[]; contactId: number | null }

describe('people:list', () => {
  it('derives people from the people-bearing records, collapsing across sources', async () => {
    addRecord('linkedin', 'connection', 'Connected with John Doe', Date.UTC(2020, 0, 1))
    addRecord('facebook', 'connection', 'Became friends with John Doe', Date.UTC(2015, 0, 1))
    addRecord('linkedin', 'connection', 'Connected with Jane Roe', Date.UTC(2021, 0, 1))
    // Non-people-bearing rows must be ignored, even on the same sources.
    addRecord('linkedin', 'job', 'Engineer at Acme', Date.UTC(2022, 0, 1))
    addRecord('netflix', 'watch', 'The Matrix', Date.UTC(2023, 0, 1))

    sqlite
      .prepare("INSERT INTO contacts (external_id, display_name) VALUES ('u1', 'John Doe')")
      .run()

    const people = await listPeople()
    expect(people.map((p) => p.name)).toEqual(['John Doe', 'Jane Roe']) // John has 2 touchpoints → first
    const john = people[0]
    expect(john.count).toBe(2)
    expect(john.sources).toEqual(['facebook', 'linkedin'])
    expect(john.contactId).toBe(1) // matched the contact
    expect(people[1].contactId).toBeNull() // Jane isn't a contact
  })

  it('includes PayPal payees + message partners (people only) and skips merchants', async () => {
    addRecord('paypal', 'payment', 'Jane Doe', Date.UTC(2024, 0, 1)) // a person → kept
    addRecord('paypal', 'payment', 'Netflix', Date.UTC(2024, 1, 1)) // merchant → not a person
    addRecord('imessage', 'messages', '12 messages with Jane Doe', Date.UTC(2024, 2, 1)) // collapses w/ the payee
    addRecord('imessage', 'messages', '3 messages with +14155551234', Date.UTC(2024, 3, 1)) // phone → dropped

    const people = await listPeople()
    expect(people.map((p) => p.name)).toEqual(['Jane Doe']) // only the real person
    expect(people[0].count).toBe(2) // paypal + imessage touchpoints
    expect(people[0].sources).toEqual(['imessage', 'paypal'])
  })

  it('returns an empty list when there are no people-bearing records', async () => {
    addRecord('netflix', 'watch', 'The Matrix', Date.UTC(2023, 0, 1))
    expect(await listPeople()).toEqual([])
  })
})
