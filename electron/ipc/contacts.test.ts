/**
 * Tests for the contacts:* IPC handlers (Phase 9 — "The Storehouse", Wave 1).
 *
 * Real in-memory SQLite (better-sqlite3 + drizzle) for true SQL semantics, with
 * only `electron`'s `dialog` mocked. Import/export tests write real temp files
 * so the vCard/CSV codecs are exercised end-to-end through the handlers.
 */

import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// Don't touch the real knowledge base while testing CRUD.
vi.mock('../knowledge/contacts-extractor', () => ({ writeRelationships: vi.fn() }))

const mockDialog = {
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}
vi.mock('electron', () => ({ dialog: mockDialog }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return Promise.resolve().then(() => h({}, ...args))
}

async function register(): Promise<void> {
  const mod = await import('./contacts')
  mod.registerContactsHandlers(fakeIpcMain as IpcMain)
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'compass-contacts-'))

beforeEach(async () => {
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
    CREATE TABLE curation_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER
    );
    CREATE UNIQUE INDEX curation_exclusions_kind_target ON curation_exclusions (kind, target);
    CREATE TABLE derived_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, match_key TEXT NOT NULL, name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', first_seen INTEGER, last_seen INTEGER,
      attrs TEXT, promoted_kind TEXT, promoted_id INTEGER, refreshed_at INTEGER
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  mockDialog.showOpenDialog.mockReset()
  mockDialog.showSaveDialog.mockReset()
  await register()
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('contacts CRUD', () => {
  it('creates a contact and reads it back with parsed arrays', async () => {
    const { id } = (await invoke('contacts:create', {
      displayName: 'Ada Lovelace',
      phones: [{ type: 'cell', value: '+1 555 0100' }],
      emails: [{ type: 'work', value: 'ada@example.com' }]
    })) as { id: number }
    const rec = (await invoke('contacts:get', id)) as ContactGet
    expect(rec?.displayName).toBe('Ada Lovelace')
    expect(rec?.phones).toEqual([{ type: 'cell', value: '+1 555 0100' }])
    expect(rec?.emails).toEqual([{ type: 'work', value: 'ada@example.com' }])
    expect(rec?.externalId).toMatch(/^urn:uuid:/)
  })

  it('lists alphabetically and filters by search blob', async () => {
    await invoke('contacts:create', { displayName: 'Zara', org: 'Acme' })
    await invoke('contacts:create', {
      displayName: 'Ada',
      emails: [{ value: 'ada@findme.com' }]
    })
    const all = (await invoke('contacts:list')) as ContactGet[]
    expect(all.map((c) => c.displayName)).toEqual(['Ada', 'Zara'])

    const byName = (await invoke('contacts:list', { search: 'zar' })) as ContactGet[]
    expect(byName.map((c) => c.displayName)).toEqual(['Zara'])

    const byEmail = (await invoke('contacts:list', { search: 'findme' })) as ContactGet[]
    expect(byEmail.map((c) => c.displayName)).toEqual(['Ada'])
  })

  it('list payload omits the photo, get includes it', async () => {
    const { id } = (await invoke('contacts:create', {
      displayName: 'Pic',
      photo: 'data:image/png;base64,aGVsbG8='
    })) as { id: number }
    const listed = (await invoke('contacts:list')) as ContactGet[]
    expect(listed[0].photo).toBeNull()
    const got = (await invoke('contacts:get', id)) as ContactGet
    expect(got.photo).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('update recomputes the search blob', async () => {
    const { id } = (await invoke('contacts:create', { displayName: 'Temp Name' })) as {
      id: number
    }
    await invoke('contacts:update', id, { displayName: 'Permanent Name' })
    const found = (await invoke('contacts:list', { search: 'permanent' })) as ContactGet[]
    expect(found).toHaveLength(1)
    const goneByOld = (await invoke('contacts:list', { search: 'temp' })) as ContactGet[]
    expect(goneByOld).toHaveLength(0)
  })

  it('deletes a contact', async () => {
    const { id } = (await invoke('contacts:create', { displayName: 'Doomed' })) as { id: number }
    await invoke('contacts:delete', id)
    expect((await invoke('contacts:list')) as ContactGet[]).toHaveLength(0)
  })

  it('rejects a non-integer id on get', async () => {
    await expect(invoke('contacts:get', 'abc')).rejects.toThrow(/integer id/)
  })

  it('caps an oversized photo to null', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(1_500_000)}`
    const { id } = (await invoke('contacts:create', {
      displayName: 'Huge',
      photo: huge
    })) as { id: number }
    const got = (await invoke('contacts:get', id)) as ContactGet
    expect(got.photo).toBeNull()
  })

  it('rejects a non-image photo string (only data:image or http(s))', async () => {
    const bad = (await invoke('contacts:create', {
      displayName: 'XSS',
      photo: 'data:text/html;base64,PHNjcmlwdD4='
    })) as { id: number }
    expect(((await invoke('contacts:get', bad.id)) as ContactGet).photo).toBeNull()

    const ok = (await invoke('contacts:create', {
      displayName: 'Linked',
      photo: 'https://example.com/me.jpg'
    })) as { id: number }
    expect(((await invoke('contacts:get', ok.id)) as ContactGet).photo).toBe(
      'https://example.com/me.jpg'
    )
  })
})

describe('contacts import / export', () => {
  it('imports a vCard and dedupes on re-import by externalId', async () => {
    const dir = tmp()
    const vcf = join(dir, 'in.vcf')
    writeFileSync(
      vcf,
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Grace Hopper',
        'TEL;TYPE=CELL:+1 555 0042',
        'UID:grace-1',
        'END:VCARD'
      ].join('\r\n')
    )
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [vcf] })

    const first = (await invoke('contacts:import-vcard')) as ImportRes
    expect(first).toMatchObject({ success: true, imported: 1, updated: 0 })

    const second = (await invoke('contacts:import-vcard')) as ImportRes
    expect(second).toMatchObject({ success: true, imported: 0, updated: 1 })

    expect((await invoke('contacts:list')) as ContactGet[]).toHaveLength(1)
  })

  it('imports a Google-style CSV mapping headers to fields', async () => {
    const dir = tmp()
    const csv = join(dir, 'in.csv')
    writeFileSync(
      csv,
      'First Name,Last Name,Organization Name,E-mail 1 - Value,Phone 1 - Value\n' +
        'Alan,Turing,Bletchley,alan@example.com,+1 555 1936\n'
    )
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [csv] })
    const res = (await invoke('contacts:import-csv')) as ImportRes
    expect(res).toMatchObject({ success: true, imported: 1 })

    const [c] = (await invoke('contacts:list')) as ContactGet[]
    expect(c.displayName).toBe('Alan Turing')
    const full = (await invoke('contacts:get', c.id)) as ContactGet
    expect(full.org).toBe('Bletchley')
    expect(full.emails).toEqual([{ value: 'alan@example.com' }])
    expect(full.phones).toEqual([{ value: '+1 555 1936' }])
  })

  it('does NOT collide two same-named, email-less CSV rows (phone disambiguates)', async () => {
    const dir = tmp()
    const csv = join(dir, 'dupes.csv')
    writeFileSync(csv, 'Name,Phone 1 - Value\nJohn Smith,+1 555 0001\nJohn Smith,+1 555 0002\n')
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [csv] })
    const res = (await invoke('contacts:import-csv')) as ImportRes
    expect(res).toMatchObject({ success: true, imported: 2 })
    expect((await invoke('contacts:list')) as ContactGet[]).toHaveLength(2)
  })

  it('exports contacts to a vCard file the parser can read back', async () => {
    await invoke('contacts:create', {
      displayName: 'Export Me',
      emails: [{ value: 'me@example.com' }]
    })
    const dir = tmp()
    const out = join(dir, 'out.vcf')
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: out })
    const res = (await invoke('contacts:export-vcard')) as { success: boolean; count: number }
    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    const written = readFileSync(out, 'utf-8')
    expect(written).toContain('FN:Export Me')
    expect(written).toContain('EMAIL')
  })

  it('returns canceled when the import dialog is dismissed', async () => {
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('contacts:import-vcard')).toMatchObject({ canceled: true })
  })

  it('imports a LinkedIn Connections.csv (skips Notes preamble, dedupes on re-import)', async () => {
    const dir = tmp()
    const csv = join(dir, 'Connections.csv')
    writeFileSync(
      csv,
      [
        'Notes:',
        '"Some preamble line about missing emails."',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        'Ada,Lovelace,https://linkedin.com/in/ada,ada@x.com,Analytical Engine,Mathematician,01 Jan 2024'
      ].join('\n')
    )
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [csv] })
    expect(await invoke('contacts:import-linkedin')).toMatchObject({ success: true, imported: 1 })
    expect(await invoke('contacts:import-linkedin')).toMatchObject({ success: true, updated: 1 })

    const [c] = (await invoke('contacts:list')) as ContactGet[]
    const full = (await invoke('contacts:get', c.id)) as ContactGet
    expect(full.org).toBe('Analytical Engine')
    expect(full.relationship).toBe('colleague')
  })

  it('imports Facebook friends.json', async () => {
    const dir = tmp()
    const jsonFile = join(dir, 'friends.json')
    writeFileSync(
      jsonFile,
      JSON.stringify({ friends_v2: [{ name: 'Grace Hopper', timestamp: 1577836800 }] })
    )
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [jsonFile] })
    expect(await invoke('contacts:import-facebook')).toMatchObject({ success: true, imported: 1 })
    const [c] = (await invoke('contacts:list')) as ContactGet[]
    expect(c.displayName).toBe('Grace Hopper')
  })

  it('imports Google Voice numbers from a Takeout folder of HTML', async () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'Mom - Text - 2024.html'),
      '<a class="tel" href="tel:+15550100"><abbr class="fn">Mom</abbr></a>'
    )
    writeFileSync(
      join(dir, '+15550199 - Text - 2024.html'),
      '<a class="tel" href="tel:+15550199"><abbr class="fn"></abbr></a>'
    )
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] })
    const res = (await invoke('contacts:import-gvoice')) as ImportRes
    expect(res).toMatchObject({ success: true, imported: 2 })
    const names = ((await invoke('contacts:list')) as ContactGet[]).map((c) => c.displayName)
    expect(names).toContain('Mom')
    expect(names).toContain('+15550199')
  })

  it('does not follow symlinks in the Google Voice folder (no infinite recursion)', async () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'Mom - Text.html'),
      '<a class="tel" href="tel:+15550100"><abbr class="fn">Mom</abbr></a>'
    )
    // A symlink pointing back at its own directory is a cycle if followed —
    // the walker must skip it (lstat) rather than recurse forever.
    symlinkSync(dir, join(dir, 'loop'))
    mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] })
    const res = (await invoke('contacts:import-gvoice')) as ImportRes
    expect(res).toMatchObject({ success: true, imported: 1 })
  })
})

describe('contacts enrichment', () => {
  it('upsert stores google enrichment; get includes it, list omits it', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([
      {
        externalId: 'people/c1',
        displayName: 'Robert Roe',
        source: 'google',
        enrichment: { google: { nicknames: ['Bob'], biography: 'Old friend' } }
      }
    ])
    const listed = (await invoke('contacts:list')) as Array<{ enrichment: unknown }>
    expect(listed[0].enrichment).toBeNull() // list payload stays light
    const id = (listed[0] as unknown as { id: number }).id
    const got = (await invoke('contacts:get', id)) as {
      enrichment: ContactEnrichmentShape
    }
    expect(got.enrichment?.google?.nicknames).toEqual(['Bob'])
    expect(got.enrichment?.google?.biography).toBe('Old friend')
  })

  it('search matches an enrichment nickname', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([
      {
        externalId: 'people/c2',
        displayName: 'Margaret Smith',
        source: 'google',
        enrichment: { google: { nicknames: ['Peggy'] } }
      }
    ])
    const hits = (await invoke('contacts:list', { search: 'peggy' })) as Array<{
      displayName: string
    }>
    expect(hits.map((h) => h.displayName)).toContain('Margaret Smith')
  })

  it('writeContactEnrichment adds crossSource without clobbering google, and skips no-op writes', async () => {
    const { upsertContacts, writeContactEnrichment } = await import('./contacts')
    upsertContacts([
      {
        externalId: 'people/c3',
        displayName: 'Carol Vane',
        source: 'google',
        enrichment: { google: { biography: 'Colleague' } }
      }
    ])
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    const id = listed[0].id
    const summary = {
      sources: ['gmail', 'gcal'],
      touchpointCount: 3,
      firstSeen: 100,
      lastSeen: 900,
      lastActivity: {
        source: 'gmail',
        type: 'email',
        title: 'Re: lunch',
        occurredAt: 900,
        recordId: 7
      },
      matchedBy: ['email'] as ('name' | 'email' | 'phone')[],
      refreshedAt: 1
    }
    expect(writeContactEnrichment(id, summary)).toBe(true)
    // Same content, different refreshedAt → no write.
    expect(writeContactEnrichment(id, { ...summary, refreshedAt: 2 })).toBe(false)
    const got = (await invoke('contacts:get', id)) as { enrichment: ContactEnrichmentShape }
    expect(got.enrichment?.google?.biography).toBe('Colleague') // preserved
    expect(got.enrichment?.crossSource?.sources).toEqual(['gmail', 'gcal'])
  })

  it('manual contacts:update does not clobber enrichment and keeps nickname search', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([
      {
        externalId: 'people/c4',
        displayName: 'Dan Ent',
        source: 'google',
        enrichment: { google: { nicknames: ['Danny'] } }
      }
    ])
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    const id = listed[0].id
    await invoke('contacts:update', id, { displayName: 'Daniel Ent' })
    const got = (await invoke('contacts:get', id)) as {
      displayName: string
      enrichment: ContactEnrichmentShape
    }
    expect(got.displayName).toBe('Daniel Ent')
    expect(got.enrichment?.google?.nicknames).toEqual(['Danny'])
    // A partial edit must NOT drop the nickname from the search blob.
    const hits = (await invoke('contacts:list', { search: 'danny' })) as Array<{ id: number }>
    expect(hits.map((h) => h.id)).toContain(id)
  })
})

describe('contact tombstones (delete = gone forever)', () => {
  it('delete writes a tombstone and upsert skips it (no resurrection)', async () => {
    const { upsertContacts } = await import('./contacts')
    const first = upsertContacts([
      { externalId: 'people/g1', displayName: 'Ghost Person', source: 'google' }
    ])
    expect(first.imported).toBe(1)
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    await invoke('contacts:delete', listed[0].id)
    expect((await invoke('contacts:list')) as unknown[]).toHaveLength(0)

    // The next "sync" re-sends the same external id → must be skipped, not re-created.
    const again = upsertContacts([
      { externalId: 'people/g1', displayName: 'Ghost Person', source: 'google' }
    ])
    expect(again).toMatchObject({ imported: 0, updated: 0, skipped: 1 })
    expect((await invoke('contacts:list')) as unknown[]).toHaveLength(0)
  })

  it('delete un-links the derived-entity row pointing at the contact', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([{ externalId: 'people/g2', displayName: 'Linked Person', source: 'google' }])
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    const id = listed[0].id
    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id) VALUES ('person','linked person','Linked Person','contact',?)"
      )
      .run(id)
    await invoke('contacts:delete', id)
    const row = sqlite
      .prepare(
        "SELECT promoted_kind AS pk, promoted_id AS pid FROM derived_entities WHERE match_key='linked person'"
      )
      .get() as { pk: string | null; pid: number | null }
    expect(row.pk).toBeNull()
    expect(row.pid).toBeNull()
  })

  it('promoteDerivedContact clears its own tombstone (explicit user intent wins)', async () => {
    const { promoteDerivedContact, upsertContacts } = await import('./contacts')
    // Promote, delete (tombstones derived:person:jane doe), promote again.
    const first = promoteDerivedContact('Jane Doe', 'jane doe')
    await invoke('contacts:delete', first.id)
    // Sanity: a plain upsert of the same external id is blocked...
    const blocked = upsertContacts([
      { externalId: 'derived:person:jane doe', displayName: 'Jane Doe', source: 'derived' }
    ])
    expect(blocked.skipped).toBe(1)
    // ...but an explicit re-promote clears the tombstone and re-creates.
    const second = promoteDerivedContact('Jane Doe', 'jane doe')
    expect(second.alreadyExisted).toBe(false)
    expect((await invoke('contacts:list')) as unknown[]).toHaveLength(1)
  })

  it('clearing tombstones restores importability', async () => {
    const { upsertContacts } = await import('./contacts')
    const { clearExclusions } = await import('../lib/curation')
    const { getDb } = await import('../db/client')
    upsertContacts([{ externalId: 'people/g3', displayName: 'Blocked Person', source: 'google' }])
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    await invoke('contacts:delete', listed[0].id)
    expect(
      upsertContacts([{ externalId: 'people/g3', displayName: 'Blocked Person' }]).skipped
    ).toBe(1)

    clearExclusions(getDb(), 'contact-tombstone')
    const after = upsertContacts([{ externalId: 'people/g3', displayName: 'Blocked Person' }])
    expect(after.imported).toBe(1)
  })
})

describe('contact dedupe (auto-merge + review queue)', () => {
  it('auto-merges same-email contacts arriving from two sources via upsertContacts', async () => {
    const { upsertContacts } = await import('./contacts')
    const first = upsertContacts([
      {
        externalId: 'people/d1',
        displayName: 'Mia Torres',
        source: 'google',
        emails: [{ value: 'mia@x.com' }],
        notes: 'met at conf'
      }
    ])
    expect(first.merged).toBe(0)
    const second = upsertContacts([
      {
        externalId: 'other/d1',
        displayName: 'Mia T.',
        source: 'google-other',
        emails: [{ value: 'MIA@X.COM' }],
        phones: [{ value: '+1 415 555 0100' }]
      }
    ])
    expect(second.merged).toBe(1)
    const listed = (await invoke('contacts:list')) as Array<{
      id: number
      displayName: string
      phones: Array<{ value: string }>
    }>
    expect(listed).toHaveLength(1)
    expect(listed[0].displayName).toBe('Mia Torres') // google survivor
    expect(listed[0].phones.map((p) => p.value)).toContain('+1 415 555 0100') // folded in
    // The loser's externalId is suppressed — re-syncing it does NOT resurrect a dupe.
    const resync = upsertContacts([
      {
        externalId: 'other/d1',
        displayName: 'Mia T.',
        source: 'google-other',
        emails: [{ value: 'mia@x.com' }]
      }
    ])
    expect(resync).toMatchObject({ imported: 0, skipped: 1 })
    expect(((await invoke('contacts:list')) as unknown[]).length).toBe(1)
  })

  it('mergeContacts remaps derived-entity promotion to the survivor', async () => {
    const { upsertContacts, mergeContacts } = await import('./contacts')
    upsertContacts([
      { externalId: 'a1', displayName: 'Ned Ott', source: 'google', emails: [] },
      { externalId: 'b1', displayName: 'Ned Ott Jr', source: 'csv', emails: [] }
    ])
    const listed = (await invoke('contacts:list')) as Array<{ id: number; displayName: string }>
    const survivor = listed.find((c) => c.displayName === 'Ned Ott') as { id: number }
    const loser = listed.find((c) => c.displayName === 'Ned Ott Jr') as { id: number }
    sqlite
      .prepare(
        "INSERT INTO derived_entities (kind, match_key, name, promoted_kind, promoted_id) VALUES ('person','ned ott','Ned Ott','contact',?)"
      )
      .run(loser.id)
    expect(mergeContacts(survivor.id, [loser.id])).toBe(true)
    const row = sqlite
      .prepare("SELECT promoted_id AS pid FROM derived_entities WHERE match_key='ned ott'")
      .get() as { pid: number }
    expect(row.pid).toBe(survivor.id)
    expect(((await invoke('contacts:list')) as unknown[]).length).toBe(1)
  })

  it('name-only pairs appear in contacts:duplicates and dismiss hides them permanently', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([
      { externalId: 'n1', displayName: 'Ola Vik', emails: [{ value: 'ola@a.com' }] },
      { externalId: 'n2', displayName: 'Ola Vik', emails: [{ value: 'ola@b.net' }] }
    ])
    const pairs = (await invoke('contacts:duplicates')) as Array<{
      a: { externalId: string }
      b: { externalId: string }
    }>
    expect(pairs).toHaveLength(1)
    await invoke('contacts:dismiss-duplicate', {
      aExternalId: pairs[0].a.externalId,
      bExternalId: pairs[0].b.externalId
    })
    expect((await invoke('contacts:duplicates')) as unknown[]).toHaveLength(0)
  })

  it('contacts:merge folds a reviewed pair', async () => {
    const { upsertContacts } = await import('./contacts')
    upsertContacts([
      {
        externalId: 'm1',
        displayName: 'Pia Q',
        emails: [{ value: 'p@a.com' }],
        notes: 'note A'
      },
      { externalId: 'm2', displayName: 'Pia Q', emails: [{ value: 'p@b.com' }], notes: 'note B' }
    ])
    const listed = (await invoke('contacts:list')) as Array<{ id: number }>
    const [s, l] = listed
    const r = (await invoke('contacts:merge', { survivorId: s.id, loserIds: [l.id] })) as {
      success: boolean
    }
    expect(r.success).toBe(true)
    const after = (await invoke('contacts:get', s.id)) as {
      emails: Array<{ value: string }>
      notes: string
    }
    expect(after.emails.map((e) => e.value).sort()).toEqual(['p@a.com', 'p@b.com'])
    expect(after.notes).toContain('note A')
    expect(after.notes).toContain('note B')
    expect(((await invoke('contacts:list')) as unknown[]).length).toBe(1)
  })
})

type ContactEnrichmentShape = {
  google?: { nicknames?: string[]; biography?: string | null }
  crossSource?: { sources?: string[] }
} | null

type ContactGet = {
  id: number
  displayName: string
  externalId: string
  org: string | null
  relationship: string | null
  photo: string | null
  phones: Array<{ type?: string; value: string }>
  emails: Array<{ type?: string; value: string }>
}
type ImportRes = { success: boolean; imported?: number; updated?: number }
