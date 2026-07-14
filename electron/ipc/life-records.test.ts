/**
 * Tests for the life:* IPC handlers (the vault split).
 *
 * Real in-memory SQLite (better-sqlite3 + drizzle) for true SQL semantics; the
 * crypto-vault layer is a deterministic in-memory stub (no Keychain in a
 * Vitest worker) so the record-secrets roundtrip is observable; the
 * storehouse-sync projection hook is mocked (its real debounce would keep the
 * worker alive).
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

// In-memory stand-in for `.vault/*.enc` JSON blobs.
const blobs: Record<string, unknown> = {}
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => Buffer.from('stub-key'),
  readEncryptedJson: (name: string) => blobs[name] ?? null,
  writeEncryptedJson: (name: string, data: unknown) => {
    blobs[name] = JSON.parse(JSON.stringify(data))
  }
}))

const afterDomainWriteMock = vi.fn()
vi.mock('./storehouse-sync', () => ({
  afterDomainWrite: afterDomainWriteMock
}))

const showSaveDialogMock = vi
  .fn<() => Promise<{ canceled: boolean; filePath?: string }>>()
  .mockResolvedValue({ canceled: true })
vi.mock('electron', () => ({
  dialog: { showSaveDialog: showSaveDialogMock }
}))

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

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE life_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      title TEXT NOT NULL, fields TEXT, notes TEXT, has_secrets INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE life_record_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, life_record_id INTEGER NOT NULL,
      target_kind TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER
    );
    CREATE UNIQUE INDEX life_record_links_unique
      ON life_record_links (life_record_id, target_kind, target_id);
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      is_debt INTEGER DEFAULT 0, balance REAL DEFAULT 0
    );
  `)
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(blobs)) delete blobs[k]
  afterDomainWriteMock.mockClear()
  const mod = await import('./life-records')
  mod.registerLifeRecordsHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

type LifeRec = {
  id: number
  externalId: string
  category: string
  title: string
  fields: Record<string, string>
  notes: string | null
  hasSecrets: boolean
  source: string
}

describe('life:categories', () => {
  it('serves the five templates with their secret markers', async () => {
    const cats = (await invoke('life:categories')) as Array<{
      id: string
      fields: Array<{ key: string; secret?: boolean }>
    }>
    expect(cats.map((c) => c.id)).toEqual([
      'financial',
      'identity',
      'medical',
      'legal',
      'foreign-accounts'
    ])
    const financial = cats.find((c) => c.id === 'financial')
    expect(financial?.fields.find((f) => f.key === 'accountNumber')?.secret).toBe(true)
  })
})

describe('life CRUD + secrets roundtrip', () => {
  it('creates a record: fields plaintext, secrets to the vault blob, hasSecrets set', async () => {
    const { id } = (await invoke('life:create', {
      category: 'financial',
      fields: { institution: 'Chase', accountType: 'Checking' },
      notes: 'main account',
      secrets: { accountNumber: '123456789', routingNumber: '021000021' }
    })) as { id: number }

    const listed = (await invoke('life:list', { category: 'financial' })) as LifeRec[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      title: 'Chase',
      fields: { institution: 'Chase', accountType: 'Checking' },
      notes: 'main account',
      hasSecrets: true,
      source: 'manual'
    })
    // The DB row NEVER holds a secret value.
    const raw = sqlite.prepare('SELECT fields, notes, title FROM life_records').get() as Record<
      string,
      string
    >
    expect(JSON.stringify(raw)).not.toContain('123456789')
    // The secret lives in the record-secrets blob, keyed by row id.
    expect(blobs['record-secrets']).toEqual({
      [String(id)]: { accountNumber: '123456789', routingNumber: '021000021' }
    })
    const secrets = await invoke('life:get-secrets', id)
    expect(secrets).toEqual({ accountNumber: '123456789', routingNumber: '021000021' })
    expect(afterDomainWriteMock).toHaveBeenCalled()
  })

  it('rejects unknown categories and non-allowlisted secret keys', async () => {
    await expect(invoke('life:create', { category: 'credentials' })).rejects.toThrow(
      /known category/
    )
    const { id } = (await invoke('life:create', {
      category: 'legal',
      fields: { documentType: 'Will', bogus: 'dropped' },
      secrets: { password: 'nope', accountNumber: 'not-a-legal-field' }
    })) as { id: number }
    const listed = (await invoke('life:list', { category: 'legal' })) as LifeRec[]
    expect(listed[0].fields).toEqual({ documentType: 'Will' })
    expect(listed[0].hasSecrets).toBe(false)
    expect(await invoke('life:get-secrets', id)).toEqual({})
  })

  it('update rewrites fields/notes, patches secrets per key, and recomputes the title', async () => {
    const { id } = (await invoke('life:create', {
      category: 'identity',
      fields: { documentType: 'Passport' },
      secrets: { number: 'X1234567' }
    })) as { id: number }

    await invoke('life:update', id, {
      category: 'identity',
      fields: { documentType: 'Driver License', issueDate: '2020-01-01' },
      notes: 'renewed',
      secrets: { number: 'DL999' }
    })
    const rec = ((await invoke('life:list', { category: 'identity' })) as LifeRec[])[0]
    expect(rec.title).toBe('Driver License')
    expect(rec.fields.issueDate).toBe('2020-01-01')
    expect(rec.notes).toBe('renewed')
    expect(await invoke('life:get-secrets', id)).toEqual({ number: 'DL999' })

    // Empty string deletes the secret; hasSecrets follows.
    await invoke('life:update', id, {
      category: 'identity',
      fields: { documentType: 'Driver License' },
      secrets: { number: '' }
    })
    expect(await invoke('life:get-secrets', id)).toEqual({})
    const after = ((await invoke('life:list', { category: 'identity' })) as LifeRec[])[0]
    expect(after.hasSecrets).toBe(false)

    // Omitting `secrets` leaves stored secrets untouched.
    await invoke('life:update', id, {
      category: 'identity',
      secrets: { number: 'BACK' }
    })
    await invoke('life:update', id, { category: 'identity', fields: { documentType: 'ID' } })
    expect(await invoke('life:get-secrets', id)).toEqual({ number: 'BACK' })
  })

  it('delete removes the row AND its secrets slot', async () => {
    const { id } = (await invoke('life:create', {
      category: 'financial',
      fields: { institution: 'CU' },
      secrets: { accountNumber: '42424242' }
    })) as { id: number }
    await invoke('life:delete', id)
    expect((await invoke('life:list')) as unknown[]).toHaveLength(0)
    expect(blobs['record-secrets']).toEqual({})
  })

  it('clamps oversized field values', async () => {
    await invoke('life:create', {
      category: 'legal',
      fields: { documentType: 'x'.repeat(5000) }
    })
    const rec = ((await invoke('life:list')) as LifeRec[])[0]
    expect(rec.fields.documentType).toHaveLength(4000)
  })
})

describe('seedLifeRecordsFromDetectedAccounts', () => {
  it('creates one stub per new account, idempotently', async () => {
    const { seedLifeRecordsFromDetectedAccounts } = await import('./life-records')
    const accounts = [
      { name: 'USAA Checking', institution: 'USAA', type: 'checking', sourceFile: 'usaa.csv' },
      {
        name: 'Amex Platinum',
        institution: 'American Express',
        type: 'credit',
        lastFour: '1003',
        sourceFile: 'amex.xlsx'
      }
    ]
    expect(seedLifeRecordsFromDetectedAccounts(accounts)).toBe(2)
    const listed = (await invoke('life:list', { category: 'financial' })) as LifeRec[]
    expect(listed).toHaveLength(2)
    const amex = listed.find((r) => r.fields.institution === 'American Express')
    expect(amex).toMatchObject({
      source: 'detected',
      fields: { accountType: 'Credit Card', lastFour: '1003' },
      hasSecrets: false
    })
    // Re-detection of the same accounts is a no-op.
    expect(seedLifeRecordsFromDetectedAccounts(accounts)).toBe(0)
    expect(((await invoke('life:list')) as unknown[]).length).toBe(2)
  })

  it('matches on the human name when no lastFour is available', async () => {
    const { insertLifeRecord, seedLifeRecordsFromDetectedAccounts } = await import('./life-records')
    insertLifeRecord({
      externalId: 'vault:existing',
      category: 'financial',
      fields: { institution: 'USAA', accountType: 'Checking' },
      notes: 'imported from USAA Checking — Aug 2025',
      source: 'vault-migration'
    })
    const added = seedLifeRecordsFromDetectedAccounts([
      { name: 'USAA Checking', institution: 'USAA', type: 'checking', sourceFile: 'usaa.csv' }
    ])
    expect(added).toBe(0)
  })
})

describe('buildLifeRecordsCsv', () => {
  it('exports plaintext columns only — secrets are structurally absent', async () => {
    await invoke('life:create', {
      category: 'financial',
      fields: { institution: 'Chase' },
      notes: 'note',
      secrets: { accountNumber: 'SECRET99' }
    })
    const { buildLifeRecordsCsv } = await import('./life-records')
    const csv = buildLifeRecordsCsv()
    expect(csv).toContain('Chase')
    expect(csv).not.toContain('SECRET99')
  })
})

describe('life record links', () => {
  async function createRecord(): Promise<number> {
    const r = (await invoke('life:create', {
      category: 'foreign-accounts',
      fields: { institution: 'BAC', maxValueUsd: '12000' }
    })) as { id: number }
    return r.id
  }

  it('links a record to an account, lists it with a resolved label, and unlinks', async () => {
    const recordId = await createRecord()
    sqlite.prepare("INSERT INTO finance_accounts (name) VALUES ('BAC CR Savings')").run()

    expect(
      await invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'account', targetId: 1 })
    ).toEqual({ success: true })
    // Idempotent by the unique index.
    await invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'account', targetId: 1 })

    const list = (await invoke('life:list')) as Array<{
      id: number
      links: Array<{ id: number; targetKind: string; targetId: number; label: string }>
    }>
    const rec = list.find((r) => r.id === recordId)
    expect(rec?.links).toHaveLength(1)
    expect(rec?.links[0]).toMatchObject({
      targetKind: 'account',
      targetId: 1,
      label: 'BAC CR Savings'
    })

    await invoke('life:remove-link', rec?.links[0].id)
    const after = (await invoke('life:list')) as Array<{ id: number; links: unknown[] }>
    expect(after.find((r) => r.id === recordId)?.links).toEqual([])
  })

  it('resolves contact labels and rejects unknown kinds/targets', async () => {
    const recordId = await createRecord()
    sqlite
      .prepare("INSERT INTO contacts (external_id, display_name) VALUES ('t/1', 'Dr. Mora')")
      .run()
    await invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'contact', targetId: 1 })
    const list = (await invoke('life:list')) as Array<{
      id: number
      links: Array<{ label: string }>
    }>
    expect(list.find((r) => r.id === recordId)?.links[0].label).toBe('Dr. Mora')

    await expect(
      invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'place', targetId: 1 })
    ).rejects.toThrow()
    await expect(
      invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'account', targetId: 99 })
    ).rejects.toThrow()
    await expect(
      invoke('life:set-link', { lifeRecordId: 999, targetKind: 'contact', targetId: 1 })
    ).rejects.toThrow()
  })

  it('deleting a record removes its links', async () => {
    const recordId = await createRecord()
    sqlite.prepare("INSERT INTO finance_accounts (name) VALUES ('BAC')").run()
    await invoke('life:set-link', { lifeRecordId: recordId, targetKind: 'account', targetId: 1 })
    await invoke('life:delete', recordId)
    const n = sqlite.prepare('SELECT COUNT(*) n FROM life_record_links').get() as { n: number }
    expect(n.n).toBe(0)
  })
})
