/**
 * people:list IPC. Real in-memory SQLite (records + contacts); asserts the handler
 * reads only the people-bearing (source,type) rows, converts timestamps, matches
 * contacts, and hands a correct directory back. The aggregation itself is covered
 * in electron/lib/people.test.ts.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => handlers[channel]({}, ...args))
}

function addRecord(source: string, type: string, title: string, occurredAt: number | null): void {
  sqlite
    .prepare('INSERT INTO records (source,type,occurred_at,title,dedup_hash) VALUES (?,?,?,?,?)')
    .run(source, type, occurredAt, title, `${source}|${title}`)
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

    const people = (await invoke('people:list')) as Person[]
    expect(people.map((p) => p.name)).toEqual(['John Doe', 'Jane Roe']) // John has 2 touchpoints → first
    const john = people[0]
    expect(john.count).toBe(2)
    expect(john.sources).toEqual(['facebook', 'linkedin'])
    expect(john.contactId).toBe(1) // matched the contact
    expect(people[1].contactId).toBeNull() // Jane isn't a contact
  })

  it('returns an empty list when there are no people-bearing records', async () => {
    addRecord('netflix', 'watch', 'The Matrix', Date.UTC(2023, 0, 1))
    expect(await invoke('people:list')).toEqual([])
  })
})
