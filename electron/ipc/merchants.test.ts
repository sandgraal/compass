/**
 * merchants IPC — tracked list w/ live ledger stats, the full profile
 * aggregation, validated updates, and the untrack → un-promote contract,
 * over a real in-memory DB (including records FTS for the activity feed).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { MerchantProfile, TrackedMerchant } from './merchants'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
const invoke = (channel: string, ...args: unknown[]): unknown => handlers[channel]({}, ...args)

const DDL = `
  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
    name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER, meta TEXT
  );
  CREATE TABLE finance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', description TEXT NOT NULL,
    account_id INTEGER, category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
    geo TEXT NOT NULL DEFAULT 'US', purpose TEXT, tax_tag TEXT NOT NULL DEFAULT 'tax:none',
    tax_tag_source TEXT NOT NULL DEFAULT 'auto', tax_year INTEGER,
    normalized_merchant TEXT, source_file TEXT, ingested_at INTEGER
  );
  CREATE TABLE derived_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL,
    name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]',
    first_seen INTEGER, last_seen INTEGER, attrs TEXT, promoted_kind TEXT, promoted_id INTEGER,
    refreshed_at INTEGER
  );
  CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
    status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, payment_account TEXT,
    cancel_url TEXT, notes TEXT, source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
    mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL UNIQUE, stored_path TEXT NOT NULL,
    extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE document_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id),
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER
  );
  CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
    occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
    dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
  );
  CREATE VIRTUAL TABLE records_fts USING fts5(
    title, body, payload, content='records', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
  END;
`

let seq = 0
function seedTxn(over: {
  date: string
  amount: number
  merchant: string
  description?: string
  currency?: string
  taxTag?: string
  taxYear?: number
}): void {
  seq++
  sqlite
    .prepare(
      `INSERT INTO finance_transactions
         (hash, date, amount, currency, description, tax_tag, tax_year, normalized_merchant)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `h${seq}`,
      over.date,
      over.amount,
      over.currency ?? 'USD',
      over.description ?? over.merchant,
      over.taxTag ?? 'tax:none',
      over.taxYear ?? null,
      over.merchant
    )
}

function seedPlace(over?: { externalId?: string; name?: string; kind?: string }): number {
  const res = sqlite
    .prepare(
      `INSERT INTO places (external_id, kind, name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'derived', 0, 0)`
    )
    .run(
      over?.externalId ?? 'derived:merchant:blue bottle',
      over?.kind ?? 'merchant',
      over?.name ?? 'Blue Bottle'
    )
  return Number(res.lastInsertRowid)
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
  for (const k of Object.keys(handlers)) delete handlers[k]
  const mod = await import('./merchants')
  mod.registerMerchantsHandlers(fakeIpcMain as IpcMain)
})
afterEach(() => sqlite.close())

describe('merchants:list-tracked', () => {
  it('returns merchant places with dominant-currency live ledger stats, skipping kind=place', () => {
    seedPlace()
    seedPlace({ externalId: 'derived:place:central park', name: 'Central Park', kind: 'place' })
    seedTxn({ date: '2026-01-05', amount: -10, merchant: 'blue bottle' })
    seedTxn({ date: '2026-02-05', amount: -12.5, merchant: 'blue bottle' })
    seedTxn({ date: '2026-02-06', amount: 3, merchant: 'blue bottle' }) // refund excluded from spend
    seedTxn({ date: '2026-02-07', amount: -5000, merchant: 'blue bottle', currency: 'CRC' })

    const list = invoke('merchants:list-tracked') as TrackedMerchant[]
    expect(list).toHaveLength(1)
    expect(list[0].matchKey).toBe('blue bottle')
    expect(list[0].live).toEqual({
      totalSpend: 22.5,
      txnCount: 4,
      lastTxnDate: '2026-02-07',
      currency: 'USD'
    })
  })

  it('a merchant with no ledger rows gets live: null', () => {
    seedPlace({ externalId: 'derived:merchant:ghost shop', name: 'Ghost Shop' })
    const list = invoke('merchants:list-tracked') as TrackedMerchant[]
    expect(list[0].live).toBeNull()
  })

  it('manual merchants match transactions via their normalized name', () => {
    seedPlace({ externalId: 'manual:abc', name: 'Payment to Blue Bottle Inc' })
    seedTxn({ date: '2026-01-05', amount: -10, merchant: 'blue bottle' })
    const list = invoke('merchants:list-tracked') as TrackedMerchant[]
    expect(list[0].matchKey).toBe('blue bottle')
    expect(list[0].live?.txnCount).toBe(1)
  })
})

describe('merchants:profile', () => {
  it('aggregates stats, buckets, transactions, subscription, documents, and tax', () => {
    const id = seedPlace()
    seedTxn({ date: '2026-01-05', amount: -10, merchant: 'blue bottle' })
    seedTxn({ date: '2026-02-05', amount: -12.5, merchant: 'blue bottle' })
    seedTxn({
      date: '2026-03-05',
      amount: -20,
      merchant: 'blue bottle',
      taxTag: 'tax:schedule-c-expense',
      taxYear: 2026
    })
    seedTxn({ date: '2026-03-06', amount: -99, merchant: 'other shop' }) // must not leak in

    sqlite
      .prepare(
        `INSERT INTO subscriptions (external_id, name, cost, cadence, status, cancel_url)
         VALUES ('detected:blue bottle::Amex', 'blue bottle', 12.5, 'monthly', 'active', 'https://x.test/cancel')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO documents (title, file_name, sha256, stored_path, doc_date, mime_type)
         VALUES ('Receipt March', 'r.pdf', 'sha', 'docs/r.pdf', '2026-03-05', 'application/pdf')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO document_links (document_id, target_kind, target_id)
         VALUES (1, 'merchant', 'derived:merchant:blue bottle')`
      )
      .run()

    const p = invoke('merchants:profile', id) as MerchantProfile
    expect(p.matchKey).toBe('blue bottle')
    expect(p.stats.totalSpend).toBe(42.5)
    expect(p.stats.txnCount).toBe(3)
    expect(p.monthly).toEqual([
      { month: '2026-01', spend: 10, count: 1 },
      { month: '2026-02', spend: 12.5, count: 1 },
      { month: '2026-03', spend: 20, count: 1 }
    ])
    expect(p.transactions).toHaveLength(3)
    expect(p.transactions[0].date).toBe('2026-03-05') // newest first
    expect(p.subscription).toMatchObject({
      name: 'blue bottle',
      cancelUrl: 'https://x.test/cancel'
    })
    expect(p.documents).toEqual([
      {
        linkId: 1,
        documentId: 1,
        title: 'Receipt March',
        docDate: '2026-03-05',
        mimeType: 'application/pdf'
      }
    ])
    expect(p.tax).toEqual([
      { taxTag: 'tax:schedule-c-expense', taxYear: 2026, total: 20, count: 1 }
    ])
  })

  it('activity surfaces timeline hits but filters ledger (finance) records', () => {
    const id = seedPlace()
    sqlite
      .prepare(
        `INSERT INTO records (source, type, occurred_at, title, dedup_hash)
         VALUES ('email-receipt', 'order', 1700000000000, 'Blue Bottle order #1', 'd1'),
                ('finance', 'transaction', 1700000000001, 'Blue Bottle charge', 'd2')`
      )
      .run()
    const p = invoke('merchants:profile', id) as MerchantProfile
    expect(p.activity).toHaveLength(1)
    expect(p.activity[0]).toMatchObject({ source: 'email-receipt', title: 'Blue Bottle order #1' })
  })

  it('throws for an unknown id', () => {
    expect(() => invoke('merchants:profile', 999)).toThrow()
  })
})

describe('merchants:update', () => {
  it('persists editable fields + meta.support and bumps updatedAt', () => {
    const id = seedPlace()
    invoke('merchants:update', id, {
      category: 'Coffee',
      url: 'https://bluebottle.com',
      notes: 'the good stuff',
      meta: { support: { email: 'help@bluebottle.com', phone: '555-0100' } }
    })
    const row = sqlite.prepare('SELECT * FROM places WHERE id = ?').get(id) as {
      category: string
      url: string
      notes: string
      meta: string
      updated_at: number
    }
    expect(row.category).toBe('Coffee')
    expect(row.url).toBe('https://bluebottle.com')
    expect(row.notes).toBe('the good stuff')
    expect(JSON.parse(row.meta)).toEqual({
      support: { email: 'help@bluebottle.com', phone: '555-0100' }
    })
    expect(row.updated_at).toBeGreaterThan(0)
  })

  it('rejects a non-http url and an empty name', () => {
    const id = seedPlace()
    expect(() => invoke('merchants:update', id, { url: 'javascript:alert(1)' })).toThrow()
    expect(() => invoke('merchants:update', id, { name: '   ' })).toThrow()
  })

  it('clearing a field with null nulls the column', () => {
    const id = seedPlace()
    invoke('merchants:update', id, { category: 'Coffee' })
    invoke('merchants:update', id, { category: null })
    const row = sqlite.prepare('SELECT category FROM places WHERE id = ?').get(id) as {
      category: string | null
    }
    expect(row.category).toBeNull()
  })
})

describe('merchants:untrack', () => {
  it('deletes the place and clears the projection promoted flags', () => {
    const id = seedPlace()
    sqlite
      .prepare(
        `INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id)
         VALUES ('merchant', 'blue bottle', 'Blue Bottle', 'place', ?)`
      )
      .run(id)

    invoke('merchants:untrack', id)
    expect(sqlite.prepare('SELECT COUNT(*) n FROM places').get()).toEqual({ n: 0 })
    const de = sqlite
      .prepare('SELECT promoted_kind AS pk, promoted_id AS pid FROM derived_entities')
      .get() as { pk: string | null; pid: number | null }
    expect(de.pk).toBeNull()
    expect(de.pid).toBeNull()
  })

  it('untracking a manual merchant (no projection row) is fine', () => {
    const id = seedPlace({ externalId: 'manual:xyz', name: 'Corner Store' })
    expect(invoke('merchants:untrack', id)).toEqual({ success: true })
  })
})
