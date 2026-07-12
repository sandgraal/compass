/**
 * Global-search tests — the scoring math plus the data-access-policy walls:
 * vault DOCUMENT categories are body-searchable (decrypt-per-query, mocked
 * here as JSON passthrough), while `credentials` stays title-only — a
 * password value must never come back through search. The records-spine and
 * contacts domains run against a real in-memory SQLite with the same FTS
 * schema `db/client.ts` creates.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

const dirs = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/compass-search-test-${process.pid}`
  return { vault: `${base}/vault`, knowledge: `${base}/kb`, data: `${base}/data`, base }
})

vi.mock('../paths', () => ({
  VAULT_DIR: dirs.vault,
  KNOWLEDGE_DIR: dirs.knowledge,
  DATA_DIR: dirs.data
}))

// Passthrough crypto: entries are written as plain JSON in the temp vault dir,
// so these tests exercise the search policy, not AES (crypto-vault has its own tests).
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => Buffer.alloc(32),
  decryptBlob: (blob: Buffer) => blob.toString('utf8')
}))

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))

import { _internal } from './search'

const { scoreMatch, searchVault, searchRecordsSpine, searchContacts, searchDocumentsHits } =
  _internal

function writeVaultCategory(category: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(join(dirs.vault, `${category}.enc`), JSON.stringify(entries))
}

beforeEach(() => {
  mkdirSync(dirs.vault, { recursive: true })
  mkdirSync(dirs.knowledge, { recursive: true })
  sqlite = new Database(':memory:')
  // Mirrors electron/db/client.ts ensureNewTables (records + records_fts + triggers).
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); END;
    CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT, org TEXT, job_title TEXT,
      phones TEXT, emails TEXT, addresses TEXT, birthday TEXT, url TEXT, relationship TEXT, notes TEXT,
      photo TEXT, source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT, enrichment TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL, stored_path TEXT NOT NULL,
      extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
      source TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE VIRTUAL TABLE documents_fts USING fts5(title, extracted_text, content='documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid,title,extracted_text) VALUES (new.id,new.title,new.extracted_text); END;
  `)
})

afterEach(() => {
  sqlite.close()
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('searchDocumentsHits — documents store is body-searchable', () => {
  it('finds a document by a word only in its extracted text', () => {
    sqlite
      .prepare(
        'INSERT INTO documents (title, file_name, sha256, stored_path, extracted_text) VALUES (?,?,?,?,?)'
      )
      .run('Lease 2026', 'lease.pdf', 'sha-1', '1.pdf', 'tenant obligations at Umbrella Plaza')
    const hits = searchDocumentsHits('umbrella')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'document', title: 'Lease 2026', fileName: 'lease.pdf' })
  })

  it('returns [] when documents_fts is absent (odd/old DB)', () => {
    sqlite.exec('DROP TRIGGER documents_ai; DROP TABLE documents_fts;')
    expect(searchDocumentsHits('anything')).toEqual([])
  })
})

describe('scoreMatch', () => {
  it('returns 0 when the needle is absent', () => {
    expect(scoreMatch('Hello world', 'foo')).toBe(0)
  })

  it('rewards earlier matches over later ones', () => {
    const early = scoreMatch('coffee at the cafe', 'coffee')
    const late = scoreMatch('we drove out for some coffee', 'coffee')
    expect(early).toBeGreaterThan(late)
  })

  it('rewards whole-word matches', () => {
    const whole = scoreMatch('budget for april', 'april')
    const partial = scoreMatch('aprilita is here', 'april')
    expect(whole).toBeGreaterThan(partial)
  })

  it('penalises long haystacks', () => {
    const short = scoreMatch('apple', 'apple')
    const long = scoreMatch(`apple ${'x '.repeat(200)}`, 'apple')
    expect(short).toBeGreaterThan(long)
  })

  it('is case-insensitive', () => {
    expect(scoreMatch('Hello WORLD', 'hello')).toBeGreaterThan(0)
    expect(scoreMatch('Hello WORLD', 'world')).toBeGreaterThan(0)
  })
})

describe('searchVault — document categories are body-searchable', () => {
  it('finds an identity entry by a body field value, with matched field + snippet', () => {
    writeVaultCategory('identity', [
      { id: 'e1', documentType: 'Passport', name: 'Chris', passportNumber: 'X1234567' }
    ])
    const hits = searchVault('x1234567')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      kind: 'vault',
      category: 'identity',
      id: 'e1',
      title: 'Passport',
      matchedField: 'passportNumber'
    })
    expect(hits[0].kind === 'vault' && hits[0].snippet).toContain('X1234567')
  })

  it('still finds entries by their title label (no snippet on a title match)', () => {
    writeVaultCategory('identity', [{ id: 'e1', documentType: 'Passport', name: 'Chris' }])
    const hits = searchVault('passport')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind === 'vault' && hits[0].snippet).toBeUndefined()
  })

  it('searches foreign-accounts (previously missing from the category list entirely)', () => {
    writeVaultCategory('foreign-accounts', [
      { id: 'f1', institution: 'BAC San José', country: 'CR', accountNumber: 'CR99-0001-4321' }
    ])
    expect(searchVault('bac')).toHaveLength(1) // title field
    const byNumber = searchVault('cr99')
    expect(byNumber).toHaveLength(1) // body field
    expect(byNumber[0]).toMatchObject({
      category: 'foreign-accounts',
      matchedField: 'accountNumber'
    })
  })
})

describe('searchVault — credentials stay sealed (title-only)', () => {
  beforeEach(() => {
    writeVaultCategory('credentials', [
      {
        id: 'c1',
        service: 'Netflix',
        username: 'chris@example.com',
        password: 'hunter2-secret-value',
        notes: 'shared with family'
      }
    ])
  })

  it('finds a credential by its service label, without any snippet', () => {
    const hits = searchVault('netflix')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind === 'vault' && hits[0].snippet).toBeUndefined()
    expect(hits[0].kind === 'vault' && hits[0].matchedField).toBeUndefined()
  })

  it('NEVER matches a password value', () => {
    expect(searchVault('hunter2')).toHaveLength(0)
  })

  it('NEVER matches a username (identifiers are sensitive in their own right)', () => {
    expect(searchVault('chris@example.com')).toHaveLength(0)
  })

  it('NEVER matches credential notes or any other body field', () => {
    expect(searchVault('shared with family')).toHaveLength(0)
  })
})

describe('searchRecordsSpine', () => {
  function insertRecord(source: string, type: string, title: string, body: string | null): void {
    sqlite
      .prepare(
        'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
      )
      .run(source, type, 1750000000000, title, body, `${source}|${title}`)
  }

  it('finds spine records across domains via FTS (medical included — full detail)', () => {
    insertRecord('medical', 'medication', 'Aspirin 81mg', 'active · RxNorm:243670')
    insertRecord('finance', 'txn', 'Starbucks', '-6.50 USD · Dining')
    insertRecord('habit', 'habit-check', 'Meditate', 'checked')

    const med = searchRecordsSpine('aspirin')
    expect(med).toHaveLength(1)
    expect(med[0]).toMatchObject({ kind: 'record', source: 'medical', title: 'Aspirin 81mg' })

    expect(searchRecordsSpine('starbucks')).toHaveLength(1)
    // Firehose-tier sources (habit checks, browser history) stay out of global
    // search — routine telemetry, not memories; tasks have their own lane.
    expect(searchRecordsSpine('meditate')).toHaveLength(0)
  })

  it('returns empty (not throwing) when the FTS table is missing', () => {
    sqlite.exec('DROP TRIGGER records_ai; DROP TABLE records_fts;')
    expect(searchRecordsSpine('anything')).toEqual([])
  })
})

describe('searchContacts', () => {
  function insertContact(displayName: string, org: string | null, blob: string): void {
    sqlite
      .prepare(
        'INSERT INTO contacts (external_id, display_name, org, search_blob) VALUES (?,?,?,?)'
      )
      .run(`c-${displayName}`, displayName, org, blob)
  }

  it('matches on the search blob (name, org, email, phone) and ranks name matches first', () => {
    insertContact('Jane Doe', 'Acme', 'jane doe acme jane@example.com')
    insertContact('Bob Smith', null, 'bob smith jane-referral@example.com')

    const hits = searchContacts('jane')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ kind: 'contact', displayName: 'Jane Doe', org: 'Acme' })
  })

  it('never returns photo or enrichment payloads', () => {
    insertContact('Jane Doe', null, 'jane doe')
    const [hit] = searchContacts('jane')
    expect(Object.keys(hit).sort()).toEqual([
      'displayName',
      'id',
      'kind',
      'org',
      'relationship',
      'score'
    ])
  })
})
