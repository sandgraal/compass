/**
 * Life records IPC (the vault split — 2026-07).
 *
 * CRUD over the plaintext `life_records` table plus the encrypted secret
 * remnant: each row MAY have secret field values (account/routing numbers,
 * SSN/passport numbers, insurance member ids) stored in the standalone
 * `.vault/record-secrets.enc` blob — a JSON map `{ [rowId]: {field: value} }`
 * sharing the vault's master key. Secrets never touch the DB, the records
 * spine, exports, or the MCP server; the renderer fetches them one record at
 * a time via `life:get-secrets` (same trust boundary as the old
 * `vault:get-entries`).
 *
 * Category/field templates live in `electron/lib/life-records.ts` (pure) and
 * are served to the renderer via `life:categories`.
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { contacts, financeAccounts, lifeRecordLinks, lifeRecords } from '../db/schema'
import { getOrCreateKey, readEncryptedJson, writeEncryptedJson } from '../lib/crypto-vault'
import { serializeCsv } from '../lib/csv'
import {
  LIFE_CATEGORIES,
  SECRET_FIELDS_BY_CATEGORY,
  deriveTitle,
  isLifeCategory
} from '../lib/life-records'
import { afterDomainWrite } from './storehouse-sync'

const MAX_FIELD = 4000
const MAX_NOTES = 20_000
const RECORD_SECRETS_BLOB = 'record-secrets'

export interface LifeRecordInput {
  category: string
  fields?: Record<string, string>
  notes?: string | null
  /**
   * Secret field values. Per key: non-empty string sets, empty string
   * deletes, absent key leaves the stored value untouched. `undefined`
   * leaves ALL secrets untouched.
   */
  secrets?: Record<string, string>
}

type LifeRecordRow = typeof lifeRecords.$inferSelect

/** A resolved link on a life record — label denormalized for display. */
export interface LifeRecordLink {
  id: number
  targetKind: 'contact' | 'account'
  targetId: number
  label: string
}

const LINK_KINDS = new Set(['contact', 'account'])

type SecretsMap = Record<string, Record<string, string>>

function readSecretsMap(key: Buffer): SecretsMap {
  return readEncryptedJson<SecretsMap>(RECORD_SECRETS_BLOB, key) ?? {}
}

function writeSecretsMap(map: SecretsMap, key: Buffer): void {
  writeEncryptedJson(RECORD_SECRETS_BLOB, map, key)
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Untrusted renderer input → validated non-secret fields: only keys declared
 * in the category's template (minus secret ones), string values, clamped.
 */
function sanitizeFields(category: string, raw: unknown): Record<string, string> {
  const template = LIFE_CATEGORIES.find((c) => c.id === category)
  if (!template || !raw || typeof raw !== 'object') return {}
  const allowed = new Set(template.fields.filter((f) => !f.secret).map((f) => f.key))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof v !== 'string' || !v.trim()) continue
    out[k] = clamp(v.trim(), MAX_FIELD)
  }
  return out
}

/**
 * Untrusted renderer input → validated secret patch. Keys must be on the
 * category's secret allowlist (rejects stuffing arbitrary data into the vault
 * blob); empty string = delete marker, kept as-is for the caller to apply.
 */
function sanitizeSecrets(category: string, raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const allowed = new Set(SECRET_FIELDS_BY_CATEGORY[category] ?? [])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof v !== 'string') continue
    out[k] = clamp(v.trim(), MAX_FIELD)
  }
  return out
}

function parseFields(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rowToRecord(row: LifeRecordRow) {
  return {
    id: row.id,
    externalId: row.externalId,
    category: row.category,
    title: row.title,
    fields: parseFields(row.fields),
    notes: row.notes,
    hasSecrets: row.hasSecrets,
    source: row.source,
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null
  }
}

/**
 * Apply a secret patch for one record id: non-empty sets, empty deletes.
 * Returns whether the record still has any secrets. No-op (and no blob
 * write) when the patch is empty.
 */
function applySecretsPatch(recordId: number, patch: Record<string, string>): boolean | null {
  if (Object.keys(patch).length === 0) return null
  const key = getOrCreateKey()
  const map = readSecretsMap(key)
  const slot = { ...(map[String(recordId)] ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v) slot[k] = v
    else delete slot[k]
  }
  if (Object.keys(slot).length > 0) map[String(recordId)] = slot
  else delete map[String(recordId)]
  writeSecretsMap(map, key)
  return Object.keys(slot).length > 0
}

function deleteSecretsFor(recordId: number): void {
  try {
    const key = getOrCreateKey()
    const map = readSecretsMap(key)
    if (map[String(recordId)]) {
      delete map[String(recordId)]
      writeSecretsMap(map, key)
    }
  } catch (err) {
    // A missing Keychain must not block deleting the plaintext row; the
    // orphaned slot is re-checked next time the blob is written.
    console.warn('[life-records] could not clean up record secrets:', err)
  }
}

/**
 * Insert a life record + optional secrets in one call. Exported for the
 * vault migration, the finance-watcher seeder, and the 1Password importer —
 * every writer funnels through the same validation.
 */
export function insertLifeRecord(input: {
  externalId: string
  category: string
  fields: Record<string, string>
  notes?: string | null
  secrets?: Record<string, string>
  source: string
  createdAt?: number | null
  updatedAt?: number | null
}): { id: number; inserted: boolean } {
  const db = getDb()
  const fields = sanitizeFields(input.category, input.fields)
  const result = db
    .insert(lifeRecords)
    .values({
      externalId: input.externalId,
      category: input.category,
      title: deriveTitle(input.category, fields),
      fields: JSON.stringify(fields),
      notes: input.notes ? clamp(input.notes, MAX_NOTES) : null,
      hasSecrets: false,
      source: input.source,
      createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date()
    })
    .onConflictDoNothing({ target: lifeRecords.externalId })
    .run()
  if (result.changes === 0) {
    const existing = db
      .select({ id: lifeRecords.id })
      .from(lifeRecords)
      .where(eq(lifeRecords.externalId, input.externalId))
      .all()[0]
    return { id: existing?.id ?? -1, inserted: false }
  }
  const id = Number(result.lastInsertRowid)
  const secrets = sanitizeSecrets(input.category, input.secrets)
  const hasSecrets = applySecretsPatch(id, secrets)
  if (hasSecrets)
    db.update(lifeRecords).set({ hasSecrets: true }).where(eq(lifeRecords.id, id)).run()
  return { id, inserted: true }
}

/**
 * Seed (idempotently) a stub financial life record for each account the
 * finance folder-watcher detects — the successor of the old vault seeder.
 * Skips accounts already represented (same institution + accountType +
 * lastFour, or same account name in the notes). Returns how many stubs were
 * created so the watcher can tell the user.
 */
export function seedLifeRecordsFromDetectedAccounts(
  detectedAccounts: Array<{
    name: string
    institution: string
    type: string
    lastFour?: string
    sourceFile: string
  }>
): number {
  if (detectedAccounts.length === 0) return 0
  const db = getDb()
  const existing = db
    .select()
    .from(lifeRecords)
    .where(eq(lifeRecords.category, 'financial'))
    .all()
    .map(rowToRecord)
  let added = 0

  for (const acct of detectedAccounts) {
    const accountTypeLabel =
      acct.type === 'credit'
        ? 'Credit Card'
        : acct.type === 'savings'
          ? 'Savings'
          : acct.type === 'checking'
            ? 'Checking'
            : acct.type
    const dupe = existing.find((e) => {
      if (e.fields.institution !== acct.institution) return false
      if (e.fields.accountType !== accountTypeLabel) return false
      if (acct.lastFour && e.fields.lastFour === acct.lastFour) return true
      if (!acct.lastFour) {
        const accountName = acct.name?.trim()
        if (accountName && e.notes?.includes(accountName)) return true
      }
      return false
    })
    if (dupe) continue

    const fields: Record<string, string> = {
      institution: acct.institution,
      accountType: accountTypeLabel
    }
    if (acct.lastFour) fields.lastFour = acct.lastFour
    const { inserted } = insertLifeRecord({
      externalId: `detected:${randomUUID()}`,
      category: 'financial',
      fields,
      notes: `Auto-detected from ${acct.sourceFile} — ${acct.name}. Fill in the account number and other details.`,
      source: 'detected'
    })
    if (inserted) {
      existing.push({
        id: -1,
        externalId: '',
        category: 'financial',
        title: '',
        fields,
        notes: acct.name ?? null,
        hasSecrets: false,
        source: 'detected',
        createdAt: null,
        updatedAt: null
      })
      added++
    }
  }
  if (added > 0) afterDomainWrite()
  return added
}

const CSV_HEADERS = ['category', 'title', 'fields', 'notes', 'source', 'created_at']

/**
 * All life records as a CSV string (Export Center). Structurally free of
 * secrets — they are not in the DB this reads from.
 */
export function buildLifeRecordsCsv(): string {
  const db = getDb()
  const rows = db.select().from(lifeRecords).all()
  return serializeCsv(
    rows.map((r) => ({
      category: r.category,
      title: r.title,
      fields: JSON.stringify(parseFields(r.fields)),
      notes: r.notes ?? '',
      source: r.source,
      created_at: r.createdAt ? new Date(r.createdAt).toISOString() : ''
    })),
    CSV_HEADERS
  )
}

/**
 * All links, id → resolved link list. Labels are joined here (one query per
 * target table) so the renderer never needs a second lookup to show a chip.
 */
function loadLinksByRecord(): Map<number, LifeRecordLink[]> {
  const db = getDb()
  const links = db.select().from(lifeRecordLinks).all()
  const out = new Map<number, LifeRecordLink[]>()
  if (links.length === 0) return out
  const contactNames = new Map(
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .all()
      .map((c) => [c.id, c.name])
  )
  const accountNames = new Map(
    db
      .select({ id: financeAccounts.id, name: financeAccounts.name })
      .from(financeAccounts)
      .all()
      .map((a) => [a.id, a.name])
  )
  for (const l of links) {
    const label =
      l.targetKind === 'contact'
        ? (contactNames.get(l.targetId) ?? '(deleted contact)')
        : (accountNames.get(l.targetId) ?? '(deleted account)')
    const list = out.get(l.lifeRecordId) ?? []
    list.push({
      id: l.id,
      targetKind: l.targetKind as LifeRecordLink['targetKind'],
      targetId: l.targetId,
      label
    })
    out.set(l.lifeRecordId, list)
  }
  return out
}

export function registerLifeRecordsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('life:categories', () => LIFE_CATEGORIES)

  ipcMain.handle('life:list', (_event, opts?: { category?: string }) => {
    const db = getDb()
    const rows =
      opts?.category && isLifeCategory(opts.category)
        ? db.select().from(lifeRecords).where(eq(lifeRecords.category, opts.category)).all()
        : db.select().from(lifeRecords).all()
    const linksByRecord = loadLinksByRecord()
    return rows
      .map((r) => ({ ...rowToRecord(r), links: linksByRecord.get(r.id) ?? [] }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
  })

  // Link a life record to the contact / finance account it documents (e.g.
  // a foreign-accounts record → the is_foreign bank account — the FBAR rollup
  // trusts a user-entered maxValueUsd through this link).
  ipcMain.handle(
    'life:set-link',
    (_event, input: { lifeRecordId?: unknown; targetKind?: unknown; targetId?: unknown }) => {
      const { lifeRecordId, targetKind, targetId } = input ?? {}
      if (!Number.isInteger(lifeRecordId) || !Number.isInteger(targetId)) {
        throw new Error('life:set-link requires integer ids')
      }
      if (typeof targetKind !== 'string' || !LINK_KINDS.has(targetKind)) {
        throw new Error('life:set-link: targetKind must be contact | account')
      }
      const db = getDb()
      const record = db
        .select({ id: lifeRecords.id })
        .from(lifeRecords)
        .where(eq(lifeRecords.id, lifeRecordId as number))
        .all()[0]
      if (!record) throw new Error('life:set-link: record not found')
      const target =
        targetKind === 'contact'
          ? db
              .select({ id: contacts.id })
              .from(contacts)
              .where(eq(contacts.id, targetId as number))
              .all()[0]
          : db
              .select({ id: financeAccounts.id })
              .from(financeAccounts)
              .where(eq(financeAccounts.id, targetId as number))
              .all()[0]
      if (!target) throw new Error(`life:set-link: ${targetKind} not found`)
      db.insert(lifeRecordLinks)
        .values({
          lifeRecordId: lifeRecordId as number,
          targetKind,
          targetId: targetId as number,
          createdAt: new Date()
        })
        .onConflictDoNothing()
        .run()
      return { success: true }
    }
  )

  ipcMain.handle('life:remove-link', (_event, linkId: number) => {
    if (!Number.isInteger(linkId)) throw new Error('life:remove-link requires an integer id')
    getDb().delete(lifeRecordLinks).where(eq(lifeRecordLinks.id, linkId)).run()
    return { success: true }
  })

  ipcMain.handle('life:create', (_event, input: LifeRecordInput) => {
    if (!input || !isLifeCategory(input.category)) {
      throw new Error('life:create requires a known category')
    }
    const { id } = insertLifeRecord({
      externalId: `manual:${randomUUID()}`,
      category: input.category,
      fields: input.fields ?? {},
      notes: input.notes ?? null,
      secrets: input.secrets,
      source: 'manual'
    })
    afterDomainWrite()
    return { success: true, id }
  })

  ipcMain.handle('life:update', (_event, id: number, input: LifeRecordInput) => {
    if (!Number.isInteger(id)) throw new Error('life:update requires an integer id')
    const db = getDb()
    const row = db.select().from(lifeRecords).where(eq(lifeRecords.id, id)).all()[0]
    if (!row) throw new Error('life:update: record not found')
    // Category is immutable — field/secret allowlists hang off it.
    const category = row.category
    const fields = sanitizeFields(category, input?.fields)
    const secretsPatch = sanitizeSecrets(category, input?.secrets)
    const hasSecrets = applySecretsPatch(id, secretsPatch)
    db.update(lifeRecords)
      .set({
        title: deriveTitle(category, fields),
        fields: JSON.stringify(fields),
        notes: input?.notes ? clamp(String(input.notes), MAX_NOTES) : null,
        ...(hasSecrets == null ? {} : { hasSecrets }),
        updatedAt: new Date()
      })
      .where(eq(lifeRecords.id, id))
      .run()
    afterDomainWrite()
    return { success: true }
  })

  ipcMain.handle('life:delete', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('life:delete requires an integer id')
    const db = getDb()
    db.delete(lifeRecordLinks).where(eq(lifeRecordLinks.lifeRecordId, id)).run()
    db.delete(lifeRecords).where(eq(lifeRecords.id, id)).run()
    deleteSecretsFor(id)
    afterDomainWrite()
    return { success: true }
  })

  ipcMain.handle('life:get-secrets', (_event, id: number) => {
    if (!Number.isInteger(id)) throw new Error('life:get-secrets requires an integer id')
    const key = getOrCreateKey()
    return readSecretsMap(key)[String(id)] ?? {}
  })

  ipcMain.handle('life:export-csv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export life records to CSV',
      defaultPath: 'compass-life-records.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      const db = getDb()
      const count = db.select({ id: lifeRecords.id }).from(lifeRecords).all().length
      writeFileSync(filePath, buildLifeRecordsCsv(), 'utf-8')
      return { success: true, path: filePath, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
