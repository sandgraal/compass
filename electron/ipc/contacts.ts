/**
 * Contacts IPC (Phase 9 — "The Storehouse", Wave 1).
 *
 * CRUD over the `contacts` table plus vCard/CSV import + export — the
 * "ingest → own → export" loop for your address book. Import upserts by
 * `externalId` so re-importing the same file updates in place instead of
 * duplicating. Export writes a portable `.vcf`/`.csv` you can load into a new
 * phone/service.
 *
 * Renderer never touches this directly — it goes through the `contacts:`
 * preload namespace. Serialization lives in `electron/lib/{vcard,csv}.ts`.
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, like } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { contacts } from '../db/schema'
import { writeRelationships } from '../knowledge/contacts-extractor'
import {
  parseFacebookFriends,
  parseGoogleVoice,
  parseLinkedInConnections
} from '../lib/archive-importers'
import { parseCSV, serializeCsv } from '../lib/csv'
import {
  type ContactAddress,
  type ContactEmail,
  type ContactPhone,
  type ParsedContact,
  parseVCard,
  serializeVCard
} from '../lib/vcard'

// Cap a PHOTO data URI so a pathological vCard can't wedge a multi-MB base64
// blob into SQLite. ~1.3MB of base64 ≈ a 1MB image — plenty for an avatar.
const MAX_PHOTO_CHARS = 1_400_000
const MAX_TEXT = 4000
const MAX_NOTES = 20_000
// Reject an import file larger than this up front so a pathological .vcf/.csv
// can't exhaust the main-process heap (self-DoS) before we even parse it.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_SEARCH_CHARS = 200

/** What the renderer sends for create/update. Arrays are real arrays here. */
export interface ContactInput {
  externalId?: string
  displayName: string
  givenName?: string | null
  familyName?: string | null
  middleName?: string | null
  prefix?: string | null
  suffix?: string | null
  org?: string | null
  jobTitle?: string | null
  phones?: ContactPhone[]
  emails?: ContactEmail[]
  addresses?: ContactAddress[]
  birthday?: string | null
  url?: string | null
  relationship?: string | null
  notes?: string | null
  photo?: string | null
  source?: string
}

/** What the renderer receives. Arrays are parsed back from JSON. */
export interface ContactRecord {
  id: number
  externalId: string
  displayName: string
  givenName: string | null
  familyName: string | null
  middleName: string | null
  prefix: string | null
  suffix: string | null
  org: string | null
  jobTitle: string | null
  phones: ContactPhone[]
  emails: ContactEmail[]
  addresses: ContactAddress[]
  birthday: string | null
  url: string | null
  relationship: string | null
  notes: string | null
  photo: string | null
  source: string
  createdAt: number | null
  updatedAt: number | null
}

type ContactRow = typeof contacts.$inferSelect

function parseArr<T>(json: string | null): T[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  const t = String(s)
  return t.length > max ? t.slice(0, max) : t
}

/** Lowercased haystack for the LIKE search in `contacts:list`. */
function computeSearchBlob(input: {
  displayName?: string | null
  org?: string | null
  emails?: ContactEmail[]
  phones?: ContactPhone[]
}): string {
  const parts: string[] = []
  if (input.displayName) parts.push(input.displayName)
  if (input.org) parts.push(input.org)
  for (const e of input.emails ?? []) if (e.value) parts.push(e.value)
  for (const p of input.phones ?? []) if (p.value) parts.push(p.value)
  return parts.join(' ').toLowerCase()
}

/** DB row → renderer record (parse JSON arrays). `includePhoto=false` for list payloads. */
function rowToRecord(row: ContactRow, includePhoto: boolean): ContactRecord {
  return {
    id: row.id,
    externalId: row.externalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    middleName: row.middleName,
    prefix: row.prefix,
    suffix: row.suffix,
    org: row.org,
    jobTitle: row.jobTitle,
    phones: parseArr<ContactPhone>(row.phones),
    emails: parseArr<ContactEmail>(row.emails),
    addresses: parseArr<ContactAddress>(row.addresses),
    birthday: row.birthday,
    url: row.url,
    relationship: row.relationship,
    notes: row.notes,
    photo: includePhoto ? row.photo : null,
    source: row.source,
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null
  }
}

/** DB row → ParsedContact (for vCard serialization). */
function rowToParsed(row: ContactRow): ParsedContact {
  return {
    externalId: row.externalId,
    displayName: row.displayName,
    givenName: row.givenName ?? undefined,
    familyName: row.familyName ?? undefined,
    middleName: row.middleName ?? undefined,
    prefix: row.prefix ?? undefined,
    suffix: row.suffix ?? undefined,
    org: row.org ?? undefined,
    jobTitle: row.jobTitle ?? undefined,
    phones: parseArr<ContactPhone>(row.phones),
    emails: parseArr<ContactEmail>(row.emails),
    addresses: parseArr<ContactAddress>(row.addresses),
    birthday: row.birthday ?? undefined,
    url: row.url ?? undefined,
    relationship: row.relationship ?? undefined,
    notes: row.notes ?? undefined,
    photo: row.photo ?? undefined
  }
}

/** Build the column values for an insert/update, including the recomputed search blob. */
function toStorage(input: ContactInput) {
  const phones = input.phones ?? []
  const emails = input.emails ?? []
  const addresses = input.addresses ?? []
  const displayName = clamp(input.displayName, MAX_TEXT) || 'Unnamed Contact'
  const org = clamp(input.org, MAX_TEXT)
  let photo = input.photo ?? null
  // Renderer input is untrusted: only persist image data URIs or http(s) URLs —
  // never `data:text/html;…` or other arbitrary strings.
  if (photo && !/^data:image\//i.test(photo) && !/^https?:\/\//i.test(photo)) photo = null
  if (photo && photo.length > MAX_PHOTO_CHARS) photo = null
  return {
    displayName,
    givenName: clamp(input.givenName, MAX_TEXT),
    familyName: clamp(input.familyName, MAX_TEXT),
    middleName: clamp(input.middleName, MAX_TEXT),
    prefix: clamp(input.prefix, MAX_TEXT),
    suffix: clamp(input.suffix, MAX_TEXT),
    org,
    jobTitle: clamp(input.jobTitle, MAX_TEXT),
    phones: JSON.stringify(phones),
    emails: JSON.stringify(emails),
    addresses: JSON.stringify(addresses),
    birthday: clamp(input.birthday, 32),
    url: clamp(input.url, MAX_TEXT),
    relationship: clamp(input.relationship, MAX_TEXT),
    notes: clamp(input.notes, MAX_NOTES),
    photo,
    searchBlob: computeSearchBlob({ displayName, org, emails, phones })
  }
}

/** ParsedContact (from a vCard) → ContactInput. */
function parsedToInput(p: ParsedContact, source: string): ContactInput {
  return {
    externalId: p.externalId,
    displayName: p.displayName,
    givenName: p.givenName ?? null,
    familyName: p.familyName ?? null,
    middleName: p.middleName ?? null,
    prefix: p.prefix ?? null,
    suffix: p.suffix ?? null,
    org: p.org ?? null,
    jobTitle: p.jobTitle ?? null,
    phones: p.phones,
    emails: p.emails,
    addresses: p.addresses,
    birthday: p.birthday ?? null,
    url: p.url ?? null,
    relationship: p.relationship ?? null,
    notes: p.notes ?? null,
    photo: p.photo ?? null,
    source
  }
}

/**
 * Upsert a batch of contacts keyed by `externalId`. Returns how many rows were
 * freshly inserted vs. updated in place — the importer reports both to the user.
 */
function upsertContacts(inputs: ContactInput[]): { imported: number; updated: number } {
  const db = getDb()
  let imported = 0
  let updated = 0
  for (const input of inputs) {
    const externalId = input.externalId?.trim() || `urn:uuid:${randomUUID()}`
    const storage = toStorage(input)
    const existing = db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, externalId))
      .all()
    if (existing.length > 0) {
      db.update(contacts)
        .set({ ...storage, source: input.source ?? 'vcard', updatedAt: new Date() })
        .where(eq(contacts.externalId, externalId))
        .run()
      updated++
    } else {
      db.insert(contacts)
        .values({
          ...storage,
          externalId,
          source: input.source ?? 'vcard',
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .run()
      imported++
    }
  }
  return { imported, updated }
}

// ─── CSV import header mapping ────────────────────────────────────────────────

/** Find the first non-empty value among a row's keys that match `test`. */
function pickAll(row: Record<string, string>, test: (header: string) => boolean): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(row)) {
    if (v?.trim() && test(k.toLowerCase())) out.push(v.trim())
  }
  return out
}

function pick(row: Record<string, string>, names: string[]): string {
  for (const n of names) {
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() === n && v?.trim()) return v.trim()
    }
  }
  return ''
}

/** Map one CSV row (Google / Apple / LinkedIn / generic) → ContactInput. */
export function csvRowToInput(row: Record<string, string>): ContactInput | null {
  const given = pick(row, ['first name', 'given name'])
  const family = pick(row, ['last name', 'family name', 'surname'])
  const org = pick(row, ['organization', 'organization name', 'company'])
  const explicitName = pick(row, ['name', 'display name'])
  const displayName = explicitName || [given, family].filter(Boolean).join(' ').trim() || org
  if (!displayName) return null

  // Collect emails/phones from any header mentioning mail/phone (Google emits
  // "E-mail 1 - Value", LinkedIn "Email Address", Apple "Phone").
  const emails: ContactEmail[] = pickAll(
    row,
    (h) => h.includes('mail') && !h.includes('label') && !h.includes('type')
  ).map((value) => ({ value }))
  const phones: ContactPhone[] = pickAll(
    row,
    (h) => h.includes('phone') && !h.includes('label') && !h.includes('type')
  ).map((value) => ({ value }))

  const jobTitle = pick(row, ['title', 'position', 'organization title', 'job title'])
  const notes = pick(row, ['notes', 'note'])
  const birthday = pick(row, ['birthday', 'birth date'])

  // CSV has no stable UID → mint a deterministic key so re-import dedupes.
  // Fold in email, phone, and org so two different people who share a name
  // (and have no email) don't collide onto the same row.
  const keyBasis =
    `${displayName}|${emails[0]?.value ?? ''}|${phones[0]?.value ?? ''}|${org}`.toLowerCase()
  return {
    externalId: `csv:${keyBasis}`,
    displayName,
    givenName: given || null,
    familyName: family || null,
    org: org || null,
    jobTitle: jobTitle || null,
    emails,
    phones,
    notes: notes || null,
    birthday: birthday || null,
    source: 'csv'
  }
}

// ─── Pure builders (shared with the Export Center's export:export-all) ────────

function fetchParsed(ids?: number[]): ParsedContact[] {
  const db = getDb()
  const rows = db.select().from(contacts).all()
  const filtered = ids && ids.length > 0 ? rows.filter((r) => ids.includes(r.id)) : rows
  return filtered.map(rowToParsed)
}

/**
 * Best-effort regeneration of `profile/relationships.md` after any mutation, so
 * the knowledge base mirrors the contacts table. Never throws into a handler —
 * a markdown write failing shouldn't fail the underlying CRUD.
 */
function syncRelationships(): void {
  try {
    writeRelationships(fetchParsed())
  } catch (err) {
    console.error('[contacts] failed to sync relationships.md', err)
  }
}

/** All contacts as a `.vcf` string. Used by the Export Center too. */
export function buildContactsVcf(ids?: number[]): string {
  return serializeVCard(fetchParsed(ids))
}

const CSV_HEADERS = [
  'Name',
  'Given Name',
  'Family Name',
  'Organization',
  'Job Title',
  'Phones',
  'Emails',
  'Addresses',
  'Birthday',
  'Relationship',
  'URL',
  'Notes'
]

/** All contacts as a human-readable `.csv` string. */
export function buildContactsCsv(ids?: number[]): string {
  const parsed = fetchParsed(ids)
  const rows = parsed.map((c) => ({
    Name: c.displayName,
    'Given Name': c.givenName ?? '',
    'Family Name': c.familyName ?? '',
    Organization: c.org ?? '',
    'Job Title': c.jobTitle ?? '',
    Phones: c.phones.map((p) => (p.type ? `${p.type}:${p.value}` : p.value)).join('; '),
    Emails: c.emails.map((e) => (e.type ? `${e.type}:${e.value}` : e.value)).join('; '),
    Addresses: c.addresses
      .map((a) => [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', '))
      .join('; '),
    Birthday: c.birthday ?? '',
    Relationship: c.relationship ?? '',
    URL: c.url ?? '',
    Notes: c.notes ?? ''
  }))
  return serializeCsv(rows, CSV_HEADERS)
}

function dateStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// Google Voice Takeout can hold thousands of conversation HTML files. Bound both
// the file count and the total bytes read so a huge export can't OOM the main
// process (self-DoS), mirroring the MAX_IMPORT_BYTES guard on single files.
const MAX_VOICE_FILES = 5000

function readVoiceHtmlFiles(root: string): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = []
  let budget = MAX_IMPORT_BYTES
  const walk = (dir: string): void => {
    if (out.length >= MAX_VOICE_FILES || budget <= 0) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_VOICE_FILES || budget <= 0) break
      const full = join(dir, entry)
      let st: ReturnType<typeof lstatSync>
      try {
        // lstat (not stat) so we DON'T follow symlinks — a symlinked directory
        // pointing back at a parent would otherwise cause infinite recursion /
        // a main-process hang. Symlinks are simply skipped.
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile() && entry.toLowerCase().endsWith('.html')) {
        if (st.size > budget) continue
        budget -= st.size
        try {
          out.push({ name: entry, content: readFileSync(full, 'utf-8') })
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  walk(root)
  return out
}

export function registerContactsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('contacts:list', (_event, opts?: { search?: string }) => {
    const db = getDb()
    const q = opts?.search?.trim().slice(0, MAX_SEARCH_CHARS).toLowerCase()
    const rows = q
      ? db
          .select()
          .from(contacts)
          .where(like(contacts.searchBlob, `%${q}%`))
          .all()
      : db.select().from(contacts).all()
    return rows
      .map((r) => rowToRecord(r, false))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  })

  ipcMain.handle('contacts:get', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('contacts:get requires an integer id')
    const db = getDb()
    const row = db.select().from(contacts).where(eq(contacts.id, id)).all()[0]
    return row ? rowToRecord(row, true) : null
  })

  ipcMain.handle('contacts:create', (_event, input: ContactInput) => {
    if (!input?.displayName?.trim() && !input?.givenName && !input?.familyName && !input?.org) {
      throw new Error('contacts:create requires at least a name or organization')
    }
    const db = getDb()
    const externalId = input.externalId?.trim() || `urn:uuid:${randomUUID()}`
    const storage = toStorage(input)
    const result = db
      .insert(contacts)
      .values({
        ...storage,
        externalId,
        source: input.source ?? 'manual',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .run()
    syncRelationships()
    return { success: true, id: Number(result.lastInsertRowid) }
  })

  ipcMain.handle('contacts:update', (_event, id: number, updates: ContactInput) => {
    if (!Number.isInteger(id)) throw new Error('contacts:update requires an integer id')
    const db = getDb()
    const storage = toStorage(updates)
    db.update(contacts)
      .set({ ...storage, updatedAt: new Date() })
      .where(eq(contacts.id, id))
      .run()
    syncRelationships()
    return { success: true }
  })

  ipcMain.handle('contacts:delete', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('contacts:delete requires an integer id')
    const db = getDb()
    db.delete(contacts).where(eq(contacts.id, id)).run()
    syncRelationships()
    return { success: true }
  })

  ipcMain.handle('contacts:import-vcard', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import contacts from vCard',
      filters: [{ name: 'vCard', extensions: ['vcf', 'vcard'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      const parsed: ParsedContact[] = []
      for (const fp of filePaths) {
        if (statSync(fp).size > MAX_IMPORT_BYTES) {
          return { success: false, error: 'File too large to import (max 50 MB).' }
        }
        parsed.push(...parseVCard(readFileSync(fp, 'utf-8')))
      }
      const inputs = parsed.map((p) => parsedToInput(p, 'vcard'))
      const { imported, updated } = upsertContacts(inputs)
      syncRelationships()
      return { success: true, imported, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('contacts:import-csv', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import contacts from CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      if (statSync(filePaths[0]).size > MAX_IMPORT_BYTES) {
        return { success: false, error: 'File too large to import (max 50 MB).' }
      }
      const rows = parseCSV(readFileSync(filePaths[0], 'utf-8'))
      const inputs = rows.map(csvRowToInput).filter((x): x is ContactInput => x !== null)
      if (inputs.length === 0) return { success: false, error: 'No contacts found in CSV' }
      const { imported, updated } = upsertContacts(inputs)
      syncRelationships()
      return { success: true, imported, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Service data-export archive importers (Phase 9.1) ────────────────────
  // FB/LinkedIn killed their friends/connections APIs, so we import their
  // official data-export archives instead — pure local file parsing, upserting
  // by externalId so re-import dedupes. Google Voice numbers come from the
  // Takeout `Voice/Calls` HTML.

  ipcMain.handle('contacts:import-linkedin', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import LinkedIn connections (Connections.csv)',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      if (statSync(filePaths[0]).size > MAX_IMPORT_BYTES) {
        return { success: false, error: 'File too large to import (max 50 MB).' }
      }
      const parsed = parseLinkedInConnections(readFileSync(filePaths[0], 'utf-8'))
      if (parsed.length === 0) {
        return {
          success: false,
          error: 'No connections found — is this a LinkedIn Connections.csv?'
        }
      }
      const { imported, updated } = upsertContacts(parsed)
      syncRelationships()
      return { success: true, imported, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('contacts:import-facebook', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import Facebook friends (friends.json)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      if (statSync(filePaths[0]).size > MAX_IMPORT_BYTES) {
        return { success: false, error: 'File too large to import (max 50 MB).' }
      }
      const parsed = parseFacebookFriends(readFileSync(filePaths[0], 'utf-8'))
      if (parsed.length === 0) {
        return {
          success: false,
          error: 'No friends found — pick friends.json from your FB export.'
        }
      }
      const { imported, updated } = upsertContacts(parsed)
      syncRelationships()
      return { success: true, imported, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('contacts:import-gvoice', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import Google Voice contacts (pick your Takeout Voice folder)',
      properties: ['openDirectory']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      const files = readVoiceHtmlFiles(filePaths[0])
      const parsed = parseGoogleVoice(files)
      if (parsed.length === 0) {
        return {
          success: false,
          error: 'No numbers found — pick the Voice folder from Google Takeout.'
        }
      }
      const { imported, updated } = upsertContacts(parsed)
      syncRelationships()
      return { success: true, imported, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('contacts:export-vcard', async (_event, opts?: { ids?: number[] }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export contacts to vCard',
      defaultPath: `contacts-${dateStamp()}.vcf`,
      filters: [{ name: 'vCard', extensions: ['vcf'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      const vcf = buildContactsVcf(opts?.ids)
      writeFileSync(filePath, vcf, 'utf-8')
      const count = fetchParsed(opts?.ids).length
      return { success: true, path: filePath, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('contacts:export-csv', async (_event, opts?: { ids?: number[] }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export contacts to CSV',
      defaultPath: `contacts-${dateStamp()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      const csv = buildContactsCsv(opts?.ids)
      writeFileSync(filePath, csv, 'utf-8')
      const count = fetchParsed(opts?.ids).length
      return { success: true, path: filePath, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
