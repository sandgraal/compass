import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { normalizeNylasContacts } from './nylas'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))
// Don't touch the real knowledge base when upsertContacts regenerates relationships.
vi.mock('../knowledge/contacts-extractor', () => ({ writeRelationships: vi.fn() }))

const NYLAS = {
  data: [
    {
      id: 'nyl-1',
      grant_id: 'gr-1',
      given_name: 'Ada',
      surname: 'Lovelace',
      company_name: 'Analytical Engine Co',
      job_title: 'Mathematician',
      emails: [{ email: 'ada@example.com', type: 'work' }],
      phone_numbers: [{ number: '+1 555 0100', type: 'mobile' }]
    },
    { id: 'nyl-2', emails: [{ email: 'grace@example.com' }] }, // email-only → name = email
    { id: 'nyl-3' } // no name, no email → skipped
  ]
}

describe('normalizeNylasContacts', () => {
  it('maps Nylas contacts to ContactInput (source nylas, prefixed externalId)', () => {
    const out = normalizeNylasContacts(NYLAS)
    expect(out).toHaveLength(2) // nyl-3 skipped
    expect(out[0]).toMatchObject({
      externalId: 'nylas:nyl-1',
      displayName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      org: 'Analytical Engine Co',
      jobTitle: 'Mathematician',
      emails: [{ type: 'work', value: 'ada@example.com' }],
      phones: [{ type: 'mobile', value: '+1 555 0100' }],
      source: 'nylas'
    })
    expect(out[1]).toMatchObject({
      externalId: 'nylas:nyl-2',
      displayName: 'grace@example.com',
      source: 'nylas'
    })
  })

  it('skips malformed input safely', () => {
    expect(normalizeNylasContacts({})).toEqual([])
    expect(normalizeNylasContacts({ data: 'nope' })).toEqual([])
    expect(normalizeNylasContacts({ data: [{ id: 'x' }] })).toEqual([]) // no name/email
  })

  it('skips contacts without a stable id (would otherwise duplicate on every sync)', () => {
    // A named contact with NO id → dropped, since upsertContacts would mint a fresh uuid.
    expect(normalizeNylasContacts({ data: [{ given_name: 'No', surname: 'Id' }] })).toEqual([])
  })
})

describe('Nylas → owned contacts (real DB)', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT,
        org TEXT, job_title TEXT,
        phones TEXT, emails TEXT, addresses TEXT,
        birthday TEXT, url TEXT, relationship TEXT, notes TEXT, photo TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        search_blob TEXT,
        enrichment TEXT,
        created_at INTEGER, updated_at INTEGER
      );
    `)
  })

  it('upserts Nylas contacts into the shared contacts table (source=nylas), idempotently', async () => {
    const { upsertContacts } = await import('../ipc/contacts')
    expect(upsertContacts(normalizeNylasContacts(NYLAS)).imported).toBe(2)

    const rows = sqlite
      .prepare(
        'SELECT external_id AS externalId, display_name AS displayName, source FROM contacts ORDER BY external_id'
      )
      .all()
    expect(rows).toEqual([
      { externalId: 'nylas:nyl-1', displayName: 'Ada Lovelace', source: 'nylas' },
      { externalId: 'nylas:nyl-2', displayName: 'grace@example.com', source: 'nylas' }
    ])

    // A re-sync updates in place (imported=0), never duplicates.
    expect(upsertContacts(normalizeNylasContacts(NYLAS)).imported).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM contacts').get()).toEqual({ n: 2 })
  })
})
