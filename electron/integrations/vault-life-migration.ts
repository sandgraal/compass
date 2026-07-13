/**
 * One-shot vault → life-records migration (the vault split, 2026-07).
 *
 * Decrypts each legacy vault document category (`.vault/{financial,identity,
 * medical,legal,foreign-accounts}.enc`), splits every entry into a plaintext
 * `life_records` row + a secret remnant in `.vault/record-secrets.enc`
 * (see `splitVaultEntry` in electron/lib/life-records.ts), then renames the
 * processed blob to `<category>.migrated.enc` — a backup no reader ever
 * touches, but still covered by full backups, device-sync, and wipe-vault.
 *
 * Runs from main.ts's deferred-startup block (it needs BOTH the DB and
 * safeStorage/Keychain, so it can't be a drizzle migration or a
 * DB_INIT_REPAIRS entry). Gated by `runOnceGated('vaultLifeRecordsMigrated')`.
 *
 * Crash-safe + idempotent: rows key on UNIQUE externalId `vault:<entryId>`
 * with `onConflictDoNothing`; the secrets map merge is idempotent; the gate
 * is only written after a fully successful pass, so a crash mid-way simply
 * retries next boot. An empty vault (no category files) is a no-op.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { lifeRecords } from '../db/schema'
import { afterDomainWrite } from '../ipc/storehouse-sync'
import {
  decryptBlob,
  getOrCreateKey,
  readEncryptedJson,
  writeEncryptedJson
} from '../lib/crypto-vault'
import { LIFE_CATEGORY_IDS, splitVaultEntry } from '../lib/life-records'
import { type SqliteForOneShot, runOnceGated } from '../lib/one-shot-repair'
import { VAULT_DIR } from '../paths'

const RECORD_SECRETS_BLOB = 'record-secrets'

export const VAULT_LIFE_MIGRATION_KEY = 'vaultLifeRecordsMigrated'

interface MigrationResult {
  migrated: number
  secretsKept: number
  categoriesProcessed: number
}

/** Lenient read of one legacy category blob — missing/corrupt → empty. */
function readLegacyCategory(category: string, key: Buffer): Array<Record<string, unknown>> {
  const path = join(VAULT_DIR, `${category}.enc`)
  if (!existsSync(path)) return []
  try {
    const entries = JSON.parse(decryptBlob(readFileSync(path), key))
    return Array.isArray(entries)
      ? entries.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      : []
  } catch {
    return []
  }
}

function migrate(): MigrationResult {
  const db = getDb()
  const key = getOrCreateKey()
  let migrated = 0
  let secretsKept = 0
  let categoriesProcessed = 0
  const secretsToMerge = new Map<number, Record<string, string>>()
  const processedPaths: string[] = []

  for (const category of LIFE_CATEGORY_IDS) {
    const path = join(VAULT_DIR, `${category}.enc`)
    if (!existsSync(path)) continue
    const entries = readLegacyCategory(category, key)
    categoriesProcessed++
    processedPaths.push(path)

    for (const entry of entries) {
      const entryId = typeof entry.id === 'string' && entry.id ? entry.id : null
      if (!entryId) continue
      const externalId = `vault:${entryId}`
      const split = splitVaultEntry(category, entry)
      const result = db
        .insert(lifeRecords)
        .values({
          externalId,
          category,
          title: split.title,
          fields: JSON.stringify(split.fields),
          notes: split.notes,
          hasSecrets: Object.keys(split.secrets).length > 0,
          source: 'vault-migration',
          createdAt: split.createdAt ? new Date(split.createdAt) : new Date(),
          updatedAt: split.updatedAt ? new Date(split.updatedAt) : new Date()
        })
        .onConflictDoNothing({ target: lifeRecords.externalId })
        .run()
      if (result.changes > 0) migrated++
      // Resolve the row id whether this pass inserted it or a crashed earlier
      // pass did — the secrets merge below must cover both.
      const row = db
        .select({ id: lifeRecords.id })
        .from(lifeRecords)
        .where(eq(lifeRecords.externalId, externalId))
        .all()[0]
      if (row && Object.keys(split.secrets).length > 0) {
        secretsToMerge.set(row.id, split.secrets)
      }
    }
  }

  // ONE merge-write of the secrets blob (idempotent across retries).
  if (secretsToMerge.size > 0) {
    const map =
      readEncryptedJson<Record<string, Record<string, string>>>(RECORD_SECRETS_BLOB, key) ?? {}
    for (const [id, secrets] of secretsToMerge) {
      map[String(id)] = { ...secrets, ...(map[String(id)] ?? {}) }
      db.update(lifeRecords).set({ hasSecrets: true }).where(eq(lifeRecords.id, id)).run()
      secretsKept += Object.keys(secrets).length
    }
    writeEncryptedJson(RECORD_SECRETS_BLOB, map, key)
  }

  // Retire the processed blobs LAST — after this, nothing re-reads them.
  for (const path of processedPaths) {
    try {
      renameSync(path, path.replace(/\.enc$/, '.migrated.enc'))
    } catch (err) {
      console.warn('[vault-life-migration] could not rename processed blob:', path, err)
    }
  }

  return { migrated, secretsKept, categoriesProcessed }
}

/**
 * Run the migration once. Returns `{ran: false}` when the gate is already
 * set. Throws (and leaves the gate unset) on Keychain/DB failure so the next
 * boot retries.
 */
export function runVaultLifeMigrationIfNeeded(
  sqlite: SqliteForOneShot
): { ran: false } | ({ ran: true } & MigrationResult) {
  const result = runOnceGated(sqlite, VAULT_LIFE_MIGRATION_KEY, migrate)
  if (result.ran && result.migrated > 0) afterDomainWrite()
  return result
}
