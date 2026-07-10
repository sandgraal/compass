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
import { and, eq, like } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { contacts, curationExclusions, derivedEntities } from '../db/schema'
import { writeRelationships } from '../knowledge/contacts-extractor'
import {
  parseFacebookFriends,
  parseGoogleVoice,
  parseLinkedInConnections
} from '../lib/archive-importers'
import { type DedupeContact, computeDedupe, dedupePairKey } from '../lib/contact-dedupe'
import {
  type ContactEnrichment,
  type CrossSourceSummary,
  mergeEnrichment,
  parseEnrichment
} from '../lib/contact-enrichment'
import { parseCSV, serializeCsv } from '../lib/csv'
import { addExclusions, loadExclusionSet, removeExclusion } from '../lib/curation'
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
  enrichment?: ContactEnrichment | null
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
  enrichment: ContactEnrichment | null
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
  nicknames?: string[]
}): string {
  const parts: string[] = []
  if (input.displayName) parts.push(input.displayName)
  if (input.org) parts.push(input.org)
  for (const e of input.emails ?? []) if (e.value) parts.push(e.value)
  for (const p of input.phones ?? []) if (p.value) parts.push(p.value)
  for (const n of input.nicknames ?? []) if (n) parts.push(n)
  return parts.join(' ').toLowerCase()
}

/**
 * DB row → renderer record (parse JSON arrays). `includePhoto=false` for list
 * payloads (keeps them light); `includeEnrichment=false` likewise — the
 * enrichment blob only rides on `contacts:get`.
 */
function rowToRecord(
  row: ContactRow,
  includePhoto: boolean,
  includeEnrichment: boolean
): ContactRecord {
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
    enrichment: includeEnrichment ? parseEnrichment(row.enrichment) : null,
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
    // Enrichment nicknames make the list search match "Bob" for a Robert. We
    // only READ enrichment here for the blob — `toStorage` never EMITS the
    // enrichment column, so a manual create/update can't clobber it.
    searchBlob: computeSearchBlob({
      displayName,
      org,
      emails,
      phones,
      nicknames: input.enrichment?.google?.nicknames
    })
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
 *
 * Exported so the Google Contacts live sync reuses the exact same owned-writer path
 * as file imports (dedupe by external id, search-blob recompute) instead of a
 * parallel one.
 */
export function upsertContacts(inputs: ContactInput[]): {
  imported: number
  updated: number
  skipped: number
  merged: number
} {
  const db = getDb()
  let imported = 0
  let updated = 0
  let skipped = 0
  // The durable "no" list, loaded ONCE per batch: user-deleted contacts
  // (tombstones) and dedupe merge losers must never be re-created by any sync
  // or import — this loop is the single choke point every source funnels through.
  const suppressed = loadExclusionSet(db, ['contact-tombstone', 'contact-merged'])
  for (const input of inputs) {
    const externalId = input.externalId?.trim() || `urn:uuid:${randomUUID()}`
    if (suppressed.has(externalId)) {
      skipped++
      continue
    }
    const storage = toStorage(input)
    const existing = db
      .select({ id: contacts.id, enrichment: contacts.enrichment })
      .from(contacts)
      .where(eq(contacts.externalId, externalId))
      .all()
    // Only touch the enrichment column when this input carries enrichment, and
    // merge BY NAMESPACE against what's stored so a Google-sync write (which
    // supplies `google`) preserves any `crossSource` block, and vice-versa.
    const enrichmentValue =
      input.enrichment != null
        ? JSON.stringify(
            mergeEnrichment(parseEnrichment(existing[0]?.enrichment ?? null), input.enrichment)
          )
        : undefined
    if (existing.length > 0) {
      db.update(contacts)
        .set({
          ...storage,
          source: input.source ?? 'vcard',
          updatedAt: new Date(),
          ...(enrichmentValue !== undefined ? { enrichment: enrichmentValue } : {})
        })
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
          updatedAt: new Date(),
          ...(enrichmentValue !== undefined ? { enrichment: enrichmentValue } : {})
        })
        .run()
      imported++
    }
  }
  // Auto-dedupe after every batch that changed rows: the same person arriving
  // via a second source (google vs google-other vs a CSV) provably shares an
  // email/phone and folds into one contact without asking. Best-effort — a
  // dedupe hiccup must never fail the import itself.
  let merged = 0
  if (imported + updated > 0) {
    try {
      merged = runAutoDedupe()
    } catch (err) {
      console.warn('[contacts] auto-dedupe failed (non-fatal):', err)
    }
  }
  return { imported, updated, skipped, merged }
}

/**
 * Merge-write ONLY the `crossSource` half of a contact's enrichment, preserving
 * any `google` block. Skips the write (returns false) when the summary is
 * unchanged — ignoring `refreshedAt` — so the auto pass after every sync doesn't
 * churn `updatedAt` on contacts whose activity hasn't actually moved. Does not
 * touch `profile/relationships.md`.
 */
export function writeContactEnrichment(
  contactId: number,
  crossSource: CrossSourceSummary
): boolean {
  const db = getDb()
  const row = db
    .select({ enrichment: contacts.enrichment })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .all()[0]
  if (!row) return false
  const existing = parseEnrichment(row.enrichment)
  if (crossSourceEqual(existing.crossSource, crossSource)) return false
  const merged = mergeEnrichment(existing, { crossSource })
  db.update(contacts)
    .set({ enrichment: JSON.stringify(merged), updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .run()
  return true
}

/**
 * Merge additional emails/phones into a contact (de-duped), preserving every other
 * field and recomputing `search_blob`. Used to backfill identifiers discovered in
 * the timeline onto a name-only promoted contact. Returns true if anything changed.
 */
export function addContactIdentifiers(
  contactId: number,
  add: { emails?: ContactEmail[]; phones?: ContactPhone[] }
): boolean {
  const db = getDb()
  const row = db.select().from(contacts).where(eq(contacts.id, contactId)).all()[0]
  if (!row) return false
  const emails = parseArr<ContactEmail>(row.emails)
  const phones = parseArr<ContactPhone>(row.phones)
  const emailSet = new Set(emails.map((e) => e.value.toLowerCase()))
  const phoneSet = new Set(phones.map((p) => p.value))
  let changed = false
  for (const e of add.emails ?? []) {
    if (e.value && !emailSet.has(e.value.toLowerCase())) {
      emails.push(e)
      emailSet.add(e.value.toLowerCase())
      changed = true
    }
  }
  for (const p of add.phones ?? []) {
    if (p.value && !phoneSet.has(p.value)) {
      phones.push(p)
      phoneSet.add(p.value)
      changed = true
    }
  }
  if (!changed) return false
  const enr = parseEnrichment(row.enrichment)
  db.update(contacts)
    .set({
      emails: JSON.stringify(emails),
      phones: JSON.stringify(phones),
      searchBlob: computeSearchBlob({
        displayName: row.displayName,
        org: row.org,
        emails,
        phones,
        nicknames: enr.google?.nicknames
      }),
      updatedAt: new Date()
    })
    .where(eq(contacts.id, contactId))
    .run()
  return true
}

// ─── Duplicate detection + merge ─────────────────────────────────────────────

/** Rough completeness signal for survivor selection. */
function filledScore(row: ContactRow): number {
  let score = 0
  for (const v of [
    row.givenName,
    row.familyName,
    row.org,
    row.jobTitle,
    row.birthday,
    row.url,
    row.relationship,
    row.notes,
    row.photo
  ]) {
    if (v) score++
  }
  score +=
    parseArr(row.emails).length + parseArr(row.phones).length + parseArr(row.addresses).length
  return score
}

function readDedupeRows(): DedupeContact[] {
  const db = getDb()
  return db
    .select()
    .from(contacts)
    .all()
    .map((row) => ({
      id: row.id,
      externalId: row.externalId,
      displayName: row.displayName,
      source: row.source,
      createdAt: row.createdAt ? row.createdAt.getTime() : null,
      emails: parseArr<ContactEmail>(row.emails),
      phones: parseArr<ContactPhone>(row.phones),
      filledScore: filledScore(row)
    }))
}

/**
 * Fold the losers into the survivor and delete them, in ONE transaction:
 * identifiers + addresses unioned, distinct notes concatenated, empty scalar
 * fields filled from losers, photo copied if the survivor lacks one, enrichment
 * merged by namespace, each loser's externalId recorded as `contact-merged` (so
 * no sync re-creates it as a fresh duplicate), and any derived-entity promotion
 * remapped to the survivor. `syncRelationships` is the caller's job (once per
 * batch, not per merge).
 */
export function mergeContacts(survivorId: number, loserIds: number[]): boolean {
  const db = getDb()
  const survivor = db.select().from(contacts).where(eq(contacts.id, survivorId)).all()[0]
  if (!survivor) return false
  const losers = loserIds
    .filter((id) => id !== survivorId)
    .map((id) => db.select().from(contacts).where(eq(contacts.id, id)).all()[0])
    .filter((r): r is ContactRow => !!r)
  if (losers.length === 0) return false

  const emails = parseArr<ContactEmail>(survivor.emails)
  const phones = parseArr<ContactPhone>(survivor.phones)
  const addresses = parseArr<ContactAddress>(survivor.addresses)
  const emailSet = new Set(emails.map((e) => e.value.trim().toLowerCase()))
  const phoneSet = new Set(phones.map((p) => p.value))
  const addrSet = new Set(addresses.map((a) => JSON.stringify(a)))
  const notes: string[] = survivor.notes ? [survivor.notes] : []
  const scalars: Partial<
    Record<
      | 'givenName'
      | 'familyName'
      | 'middleName'
      | 'org'
      | 'jobTitle'
      | 'birthday'
      | 'url'
      | 'relationship',
      string
    >
  > = {}
  let photo = survivor.photo
  let enrichment = parseEnrichment(survivor.enrichment)

  for (const loser of losers) {
    for (const e of parseArr<ContactEmail>(loser.emails)) {
      if (e.value && !emailSet.has(e.value.toLowerCase())) {
        emails.push(e)
        emailSet.add(e.value.toLowerCase())
      }
    }
    for (const p of parseArr<ContactPhone>(loser.phones)) {
      if (p.value && !phoneSet.has(p.value)) {
        phones.push(p)
        phoneSet.add(p.value)
      }
    }
    for (const a of parseArr<ContactAddress>(loser.addresses)) {
      const key = JSON.stringify(a)
      if (!addrSet.has(key)) {
        addresses.push(a)
        addrSet.add(key)
      }
    }
    if (loser.notes && !notes.includes(loser.notes)) notes.push(loser.notes)
    for (const f of [
      'givenName',
      'familyName',
      'middleName',
      'prefix',
      'suffix',
      'org',
      'jobTitle',
      'birthday',
      'url',
      'relationship'
    ] as const) {
      if (!survivor[f] && !scalars[f] && loser[f]) scalars[f] = loser[f] as string
    }
    if (!photo && loser.photo) photo = loser.photo
    const loserEnr = parseEnrichment(loser.enrichment)
    // Namespace-merge, preferring the survivor's existing halves.
    enrichment = {
      google: enrichment.google ?? loserEnr.google,
      crossSource: enrichment.crossSource ?? loserEnr.crossSource
    }
  }

  db.transaction((tx) => {
    tx.update(contacts)
      .set({
        ...scalars,
        emails: JSON.stringify(emails),
        phones: JSON.stringify(phones),
        addresses: JSON.stringify(addresses),
        notes: notes.length > 0 ? notes.join('\n\n') : survivor.notes,
        photo,
        enrichment: JSON.stringify(enrichment),
        searchBlob: computeSearchBlob({
          displayName: survivor.displayName,
          org: (scalars.org ?? survivor.org) || null,
          emails,
          phones,
          nicknames: enrichment.google?.nicknames
        }),
        updatedAt: new Date()
      })
      .where(eq(contacts.id, survivorId))
      .run()
    for (const loser of losers) {
      // The loser's externalId must never re-import as a fresh duplicate row.
      tx.insert(curationExclusions)
        .values({ kind: 'contact-merged', target: loser.externalId })
        .onConflictDoNothing()
        .run()
      tx.update(derivedEntities)
        .set({ promotedId: survivorId })
        .where(
          and(eq(derivedEntities.promotedKind, 'contact'), eq(derivedEntities.promotedId, loser.id))
        )
        .run()
      tx.delete(contacts).where(eq(contacts.id, loser.id)).run()
    }
  })
  return true
}

/**
 * Run the AUTO tier of the dedupe engine over the whole contacts table:
 * merge every exact-identifier group (shared email / same-name shared phone).
 * Called at the end of `upsertContacts` batches so every sync/import inherits
 * it. Deterministic + idempotent (a second run finds nothing). Returns the
 * number of contacts folded away.
 */
export function runAutoDedupe(): number {
  const db = getDb()
  const dismissed = loadExclusionSet(db, ['dedupe-dismissed'])
  const { autoGroups } = computeDedupe(readDedupeRows(), { dismissedPairs: dismissed })
  let merged = 0
  for (const group of autoGroups) {
    if (mergeContacts(group.survivorId, group.loserIds)) merged += group.loserIds.length
  }
  if (merged > 0) syncRelationships()
  return merged
}

/** Structural equality of two summaries, ignoring the ever-changing `refreshedAt`. */
function crossSourceEqual(a: CrossSourceSummary | undefined, b: CrossSourceSummary): boolean {
  if (!a) return false
  const strip = (s: CrossSourceSummary): Omit<CrossSourceSummary, 'refreshedAt'> => {
    const { refreshedAt: _drop, ...rest } = s
    return rest
  }
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/**
 * Promote a person the cross-reference engine derived from the timeline into the
 * owned contacts table. Idempotent by a stable `derived:person:<matchKey>`
 * external id (so re-promoting the same person is a no-op) and `source:'derived'`
 * so it's distinguishable from a hand-added / imported contact. Returns the
 * contact id — existing or newly created — so `entities:promote` can record the
 * link back on the derived-entity row.
 */
export function promoteDerivedContact(
  displayName: string,
  matchKey: string
): { id: number; alreadyExisted: boolean } {
  const db = getDb()
  const externalId = `derived:person:${matchKey}`
  // Promote is EXPLICIT user intent — it overrides a prior delete of this same
  // derived person, so clear any tombstone before the insert-if-missing.
  removeExclusion(db, 'contact-tombstone', externalId)
  const existing = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, externalId))
    .all()[0]
  if (existing) return { id: existing.id, alreadyExisted: true }
  const result = db
    .insert(contacts)
    .values({
      ...toStorage({ displayName }),
      externalId,
      source: 'derived',
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .run()
  return { id: Number(result.lastInsertRowid), alreadyExisted: false }
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
      .map((r) => rowToRecord(r, false, false))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  })

  ipcMain.handle('contacts:get', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('contacts:get requires an integer id')
    const db = getDb()
    const row = db.select().from(contacts).where(eq(contacts.id, id)).all()[0]
    return row ? rowToRecord(row, true, true) : null
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
    // A partial edit (no enrichment in the payload) must still fold the STORED
    // enrichment nicknames into the recomputed search_blob, or a manual edit would
    // silently drop nickname search terms even though the enrichment column is kept.
    let storageInput = updates
    if (updates.enrichment == null) {
      const existing = db
        .select({ enrichment: contacts.enrichment })
        .from(contacts)
        .where(eq(contacts.id, id))
        .all()[0]
      const parsed = parseEnrichment(existing?.enrichment ?? null)
      if (parsed.google?.nicknames?.length) storageInput = { ...updates, enrichment: parsed }
    }
    const storage = toStorage(storageInput)
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
    // Delete means GONE: tombstone the external id first so no future sync or
    // import can re-create this contact (upsertContacts skips tombstoned ids).
    // Settings → Curation can clear tombstones if the user changes their mind.
    const row = db
      .select({ externalId: contacts.externalId })
      .from(contacts)
      .where(eq(contacts.id, id))
      .all()[0]
    if (row?.externalId) addExclusions(db, 'contact-tombstone', [row.externalId])
    db.delete(contacts).where(eq(contacts.id, id)).run()
    // Un-link any derived-entity row that pointed at this contact so the People
    // page is consistent immediately (the next rebuild recomputes this anyway).
    try {
      db.update(derivedEntities)
        .set({ promotedKind: null, promotedId: null })
        .where(and(eq(derivedEntities.promotedKind, 'contact'), eq(derivedEntities.promotedId, id)))
        .run()
    } catch {
      /* derived_entities absent on a pristine DB — ignore */
    }
    syncRelationships()
    return { success: true }
  })

  // ── Duplicates review queue ────────────────────────────────────────────────
  // The MANUAL tier: name-only matches (and demoted shared-phone pairs) that the
  // auto tier wasn't sure about. Computed on demand; the only persistence is the
  // 'dedupe-dismissed' exclusion for pairs the user rejected.
  ipcMain.handle('contacts:duplicates', () => {
    const db = getDb()
    const dismissed = loadExclusionSet(db, ['dedupe-dismissed'])
    const rows = readDedupeRows()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const { fuzzyPairs } = computeDedupe(rows, { dismissedPairs: dismissed })
    const summarize = (r: DedupeContact) => ({
      id: r.id,
      externalId: r.externalId,
      displayName: r.displayName,
      source: r.source,
      emails: r.emails.map((e) => e.value).slice(0, 3),
      phones: r.phones.map((p) => p.value).slice(0, 3)
    })
    return fuzzyPairs.slice(0, 200)
      .map((p) => {
        const b = byId.get(p.bId)
        return a && b ? { a: summarize(a), b: summarize(b), nameKey: p.nameKey } : null
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  })

  ipcMain.handle('contacts:merge', (_event, req: { survivorId: number; loserIds: number[] }) => {
    const { survivorId, loserIds } = req ?? {}
    if (!Number.isInteger(survivorId) || !Array.isArray(loserIds) || loserIds.length === 0) {
      throw new Error('contacts:merge requires survivorId and loserIds')
    }
    const ok = mergeContacts(
      survivorId,
      loserIds.filter((id: unknown): id is number => Number.isInteger(id))
    )
    if (ok) syncRelationships()
    return { success: ok }
  })

  ipcMain.handle(
    'contacts:dismiss-duplicate',
    (_event, req: { aExternalId: string; bExternalId: string }) => {
      const { aExternalId, bExternalId } = req ?? {}
      if (!aExternalId || !bExternalId) {
        throw new Error('contacts:dismiss-duplicate requires both external ids')
      }
      addExclusions(getDb(), 'dedupe-dismissed', [dedupePairKey(aExternalId, bExternalId)])
      return { success: true }
    }
  )

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
