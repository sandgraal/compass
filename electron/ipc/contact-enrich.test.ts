/**
 * Tests for the contact-enrichment orchestrator (cheap cache tier + deep FTS
 * tier + the activity feed). Real in-memory SQLite with the same `records_fts`
 * external-content index the app builds, plus contacts + derived_entities.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
vi.mock('../knowledge/contacts-extractor', () => ({ writeRelationships: vi.fn() }))

const CONTACTS_DDL = `CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT, org TEXT, job_title TEXT,
  phones TEXT, emails TEXT, addresses TEXT, birthday TEXT, url TEXT, relationship TEXT, notes TEXT, photo TEXT,
  source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT, enrichment TEXT, created_at INTEGER, updated_at INTEGER
);`
const DERIVED_DDL = `CREATE TABLE derived_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
  attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
);`
const RECORDS_DDL = `CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
  title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
);`
const FTS_DDL = `
CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN INSERT INTO records_fts(records_fts,rowid,title,body,payload) VALUES('delete',old.id,old.title,old.body,old.payload); INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
`

function addContact(externalId: string, displayName: string, emails: string[] = []): number {
  const info = sqlite
    .prepare('INSERT INTO contacts (external_id, display_name, emails, source) VALUES (?,?,?,?)')
    .run(externalId, displayName, JSON.stringify(emails.map((value) => ({ value }))), 'google')
  return Number(info.lastInsertRowid)
}

function addPerson(
  name: string,
  matchKey: string,
  count: number,
  sources: string[],
  firstSeen: number,
  lastSeen: number
): void {
  sqlite
    .prepare(
      'INSERT INTO derived_entities (kind, match_key, name, count, sources, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)'
    )
    .run('person', matchKey, name, count, JSON.stringify(sources), firstSeen, lastSeen)
}

function addRecord(
  source: string,
  type: string,
  title: string,
  body: string,
  occurredAt: number
): void {
  sqlite
    .prepare(
      'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(source, type, occurredAt, title, body, `${source}|${title}`)
}

function readEnrichment(id: number): {
  crossSource?: {
    sources: string[]
    touchpointCount: number
    matchedBy: string[]
    lastActivity: unknown
  }
} | null {
  const row = sqlite.prepare('SELECT enrichment FROM contacts WHERE id = ?').get(id) as
    | { enrichment: string | null }
    | undefined
  return row?.enrichment ? JSON.parse(row.enrichment) : null
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(CONTACTS_DDL)
  sqlite.exec(DERIVED_DDL)
  sqlite.exec(RECORDS_DDL)
  sqlite.exec(FTS_DDL)
})
afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('enrichContactsFromCache', () => {
  it('writes a crossSource summary for a name-matched contact and skips unmatched ones', async () => {
    const jane = addContact('people/c1', 'Jane Doe', ['jane@example.com'])
    addContact('people/c2', 'Nobody Here')
    addPerson('Jane Doe', 'jane doe', 3, ['linkedin', 'gmail'], 100, 900)
    const { enrichContactsFromCache } = await import('./contact-enrich')

    expect(enrichContactsFromCache()).toBe(1)
    const enr = readEnrichment(jane)
    expect(enr?.crossSource?.sources).toEqual(['gmail', 'linkedin'])
    expect(enr?.crossSource?.touchpointCount).toBe(3)
    expect(enr?.crossSource?.matchedBy).toEqual(['name'])
    expect(enr?.crossSource?.lastActivity).toBeNull()
    // The unmatched contact was left alone.
    const none = sqlite
      .prepare('SELECT enrichment FROM contacts WHERE display_name = ?')
      .get('Nobody Here') as { enrichment: string | null }
    expect(none.enrichment).toBeNull()
  })
})

describe('enrichAllContactsDeep', () => {
  it('adds an email-only match with lastActivity and is idempotent', async () => {
    const bob = addContact('people/c3', 'Bob Roe', ['bob@roe.com'])
    addRecord('gmail', 'email', 'Re: hi', 'note from bob@roe.com about lunch', 500)
    const { enrichAllContactsDeep } = await import('./contact-enrich')

    expect(enrichAllContactsDeep()).toBe(1)
    const enr = readEnrichment(bob)
    expect(enr?.crossSource?.sources).toEqual(['gmail'])
    expect(enr?.crossSource?.matchedBy).toEqual(['email'])
    expect(enr?.crossSource?.touchpointCount).toBe(1)
    expect(enr?.crossSource?.lastActivity).toMatchObject({ source: 'gmail', occurredAt: 500 })

    // Re-running with no new data is a no-op (skip-if-unchanged → no write).
    expect(enrichAllContactsDeep()).toBe(0)
  })
})

describe('computeContactActivity', () => {
  it('returns records matched by name and email, newest first', async () => {
    const carol = addContact('people/c4', 'Carol Vane', ['carol@x.com'])
    addRecord('imessage', 'message', 'Lunch with Carol Vane', 'see you then', 200)
    addRecord('gmail', 'email', 'Invoice', 'sent to carol@x.com', 400)
    const { computeContactActivity } = await import('./contact-enrich')

    const hits = computeContactActivity(carol)
    expect(hits.map((h) => h.occurredAt)).toEqual([400, 200]) // newest first, deduped
    expect(hits.map((h) => h.source)).toContain('gmail')
    expect(hits.map((h) => h.source)).toContain('imessage')
  })

  it('returns [] for a missing contact', async () => {
    const { computeContactActivity } = await import('./contact-enrich')
    expect(computeContactActivity(999)).toEqual([])
  })
})

describe('enrichOneContactDeep (rich promote)', () => {
  it('backfills a name-matching email from the timeline and writes the crossSource summary', async () => {
    // A name-only contact, as produced by promoting a derived person.
    const carol = addContact('derived:person:carol vane', 'Carol Vane')
    addPerson('Carol Vane', 'carol vane', 3, ['linkedin'], 100, 900)
    addRecord('gmail', 'email', 'Note', 'from carol.vane@example.com about the plan', 500)
    const { enrichOneContactDeep } = await import('./contact-enrich')

    enrichOneContactDeep(carol)

    const row = sqlite.prepare('SELECT emails FROM contacts WHERE id = ?').get(carol) as {
      emails: string | null
    }
    const emails = JSON.parse(row.emails ?? '[]') as { value: string }[]
    expect(emails.map((e) => e.value)).toContain('carol.vane@example.com') // backfilled

    const enr = readEnrichment(carol)
    expect(enr?.crossSource?.sources).toEqual(['gmail', 'linkedin']) // name entity + email match
    expect(enr?.crossSource?.matchedBy).toEqual(['name', 'email'])
  })

  it('does not attach an unrelated email that does not match the name', async () => {
    const dan = addContact('derived:person:dan ives', 'Dan Ives')
    addPerson('Dan Ives', 'dan ives', 1, ['linkedin'], 10, 20)
    // A record mentioning Dan but only carrying a newsletter address (name mismatch).
    addRecord('gmail', 'email', 'Re: Dan Ives intro', 'noreply@marketing.example sent this', 300)
    const { enrichOneContactDeep } = await import('./contact-enrich')

    enrichOneContactDeep(dan)

    const row = sqlite.prepare('SELECT emails FROM contacts WHERE id = ?').get(dan) as {
      emails: string | null
    }
    expect(JSON.parse(row.emails ?? '[]')).toEqual([]) // nothing attached
    // Still enriched by the name-key entity.
    expect(readEnrichment(dan)?.crossSource?.sources).toEqual(['linkedin'])
  })
})

describe('materializeGooglePhotos', () => {
  function addContactWithPhotoUrl(externalId: string, name: string, photoUrl: string): number {
    const info = sqlite
      .prepare(
        'INSERT INTO contacts (external_id, display_name, source, enrichment) VALUES (?,?,?,?)'
      )
      .run(externalId, name, 'google', JSON.stringify({ google: { photoUrl } }))
    return Number(info.lastInsertRowid)
  }

  it('fetches googleusercontent photos into a data URI but SKIPS non-allowlisted hosts', async () => {
    const ok = addContactWithPhotoUrl(
      'people/p1',
      'Ok Person',
      'https://lh3.googleusercontent.com/abc'
    )
    const evil = addContactWithPhotoUrl(
      'people/p2',
      'Evil Person',
      'https://internal.attacker.example/x'
    )
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    })) as unknown as typeof fetch
    const { materializeGooglePhotos } = await import('./contact-enrich')

    const done = await materializeGooglePhotos(fetchImpl)
    expect(done).toBe(1) // only the allowlisted one
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const okPhoto = sqlite.prepare('SELECT photo FROM contacts WHERE id = ?').get(ok) as {
      photo: string | null
    }
    expect(okPhoto.photo?.startsWith('data:image/png;base64,')).toBe(true)
    const evilPhoto = sqlite.prepare('SELECT photo FROM contacts WHERE id = ?').get(evil) as {
      photo: string | null
    }
    expect(evilPhoto.photo).toBeNull()
  })
})
