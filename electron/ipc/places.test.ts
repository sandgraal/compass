/**
 * places IPC — list/delete + the `promoteDerivedPlace` writer over an in-memory DB.
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
const invoke = (channel: string, ...args: unknown[]): unknown => handlers[channel]({}, ...args)

let promoteDerivedPlace: typeof import('./places').promoteDerivedPlace

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE places (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
      name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  const mod = await import('./places')
  mod.registerPlacesHandlers(fakeIpcMain as IpcMain)
  promoteDerivedPlace = mod.promoteDerivedPlace
})
afterEach(() => sqlite.close())

describe('promoteDerivedPlace', () => {
  it('inserts a merchant idempotently by its derived external id', () => {
    const a = promoteDerivedPlace('merchant', 'Amazon', 'amazon', { totalSpend: 42 })
    expect(a.alreadyExisted).toBe(false)
    const b = promoteDerivedPlace('merchant', 'Amazon', 'amazon')
    expect(b.alreadyExisted).toBe(true)
    expect(b.id).toBe(a.id)
    const rows = sqlite.prepare('SELECT COUNT(*) c FROM places').get() as { c: number }
    expect(rows.c).toBe(1)
  })
})

describe('places:list / places:delete', () => {
  it('lists then deletes a place', () => {
    const { id } = promoteDerivedPlace('place', 'Central Park', 'central park')
    const list = invoke('places:list') as Array<{ id: number; name: string; kind: string }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, name: 'Central Park', kind: 'place' })

    invoke('places:delete', id)
    expect(invoke('places:list')).toEqual([])
  })

  it('rejects a non-integer delete id', () => {
    expect(() => invoke('places:delete', 'nope')).toThrow()
  })
})
