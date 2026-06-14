/**
 * Tests for the Storehouse overview aggregator (Phase 9.6).
 * Pure `buildStorehouseSummary(db, today)` over real in-memory SQLite, with an
 * injected `today` so renewal-window math is deterministic.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { buildStorehouseSummary } from './storehouse'

let sqlite: Database.Database
const db = () => drizzle(sqlite, { schema })
const TODAY = new Date(2026, 5, 14) // 2026-06-14 (local)

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
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
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'other',
      name TEXT NOT NULL, value REAL, provider TEXT, reference TEXT, renewal_date TEXT,
      status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
})

afterEach(() => sqlite.close())

function seed(): void {
  const c = sqlite.prepare('INSERT INTO contacts (external_id, display_name) VALUES (?, ?)')
  c.run('c1', 'Ada')
  c.run('c2', 'Alan')

  const s = sqlite.prepare(
    'INSERT INTO subscriptions (external_id, name, cost, cadence, status, next_renewal) VALUES (?, ?, ?, ?, ?, ?)'
  )
  s.run('m:1', 'Netflix', 20, 'monthly', 'active', '2026-06-24') // +10d → annual 240
  s.run('m:2', 'Domain', 100, 'yearly', 'active', '2026-12-01') // far → annual 100
  s.run('m:3', 'Old', 9, 'monthly', 'cancelled', null) // excluded from active

  const a = sqlite.prepare(
    'INSERT INTO assets (external_id, type, name, value, status, renewal_date) VALUES (?, ?, ?, ?, ?, ?)'
  )
  a.run('a:1', 'property', 'Lake House', 300000, 'active', null)
  a.run('a:2', 'vehicle', 'Car', 20000, 'active', '2026-06-19') // +5d
  a.run('a:3', 'vehicle', 'Old Truck', 5000, 'sold', null) // excluded from active value
}

describe('buildStorehouseSummary', () => {
  it('returns zeroed sections when empty', () => {
    const sum = buildStorehouseSummary(db(), TODAY)
    expect(sum.contacts.count).toBe(0)
    expect(sum.subscriptions).toEqual({ activeCount: 0, annualTotal: 0 })
    expect(sum.assets).toEqual({ count: 0, totalValue: 0, byType: [] })
    expect(sum.upcomingRenewals).toEqual([])
  })

  it('aggregates counts, totals, and by-type breakdown', () => {
    seed()
    const sum = buildStorehouseSummary(db(), TODAY)
    expect(sum.contacts.count).toBe(2)
    expect(sum.subscriptions).toEqual({ activeCount: 2, annualTotal: 340 }) // 240 + 100
    expect(sum.assets.count).toBe(3) // includes the sold one
    expect(sum.assets.totalValue).toBe(320000) // active only: 300k + 20k
    expect(sum.assets.byType).toEqual([
      { type: 'property', count: 1, value: 300000 },
      { type: 'vehicle', count: 1, value: 20000 }
    ])
  })

  it('lists upcoming renewals within 60 days, soonest first, excluding far/none', () => {
    seed()
    const sum = buildStorehouseSummary(db(), TODAY)
    expect(sum.upcomingRenewals).toEqual([
      { source: 'asset', name: 'Car', date: '2026-06-19', daysUntil: 5 },
      { source: 'subscription', name: 'Netflix', date: '2026-06-24', daysUntil: 10 }
    ])
  })
})
