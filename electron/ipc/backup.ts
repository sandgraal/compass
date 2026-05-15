/**
 * Encrypted backup/restore — Tier 1 from the May 2026 strategic review.
 *
 * Produces a single passphrase-encrypted `.compass-backup` file containing
 * everything a fresh machine needs to come back online: the SQLite tables
 * as JSON, every knowledge-base markdown file, and every `.vault/*.enc`
 * blob INCLUDING the `key.enc` master-key wrapper.
 *
 * Why passphrase-encrypt (vs. relying on the Keychain master key like the
 * vault does): backups are meant to survive a dead machine. The OS
 * Keychain is by definition not portable — if the disk fails we have no
 * way to recover the master key. The user-supplied passphrase is the only
 * thing they bring with them.
 *
 * Crypto layout on disk:
 *
 *     [magic "COMPASSB" (8 bytes)]
 *     [version (1 byte) = 0x01]
 *     [salt   (16 bytes)]   → scrypt salt
 *     [IV     (16 bytes)]   → AES-256-GCM IV
 *     [tag    (16 bytes)]   → AES-256-GCM auth tag
 *     [ciphertext           → AES-256-GCM( utf8( JSON.stringify(bundle) ) )]
 *
 * scrypt parameters: N=2^15, r=8, p=1, keylen=32. ~150 ms on modern Macs;
 * dramatically harder to brute-force than a bare key.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { type IpcMain, app, dialog } from 'electron'
import { getDb } from '../db/client'
import {
  appSettings,
  budgetRules,
  calendarEvents,
  categorizationRules,
  checklistItems,
  checklistTemplates,
  driveFiles,
  financeAccounts,
  financeBalanceSnapshots,
  financeTransactions,
  forecastOverrides,
  githubItems,
  gmailActions,
  habitEntries,
  habits,
  integrations,
  knowledgeFiles,
  knowledgeSuggestions,
  plaidItems,
  syncEvents
} from '../db/schema'
import { KNOWLEDGE_DIR, VAULT_DIR } from '../paths'

const MAGIC = Buffer.from('COMPASSB', 'utf8') // 8 bytes
const VERSION = 0x01
const SALT_SIZE = 16
const IV_SIZE = 16
const TAG_SIZE = 16
const KEY_SIZE = 32
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1

const HEADER_SIZE = MAGIC.length + 1 + SALT_SIZE + IV_SIZE + TAG_SIZE

interface Bundle {
  version: 1
  exportedAt: string
  appVersion: string
  tables: Record<string, unknown[]>
  // path → markdown text
  knowledge: Record<string, string>
  // filename → base64 of the encrypted blob bytes (includes key.enc)
  vault: Record<string, string>
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_SIZE, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // Default maxmem is 32 MB which is below what N=2^15 needs.
    maxmem: 128 * 1024 * 1024
  })
}

function walkMarkdown(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(relative(base, full))
    }
  }
  return out
}

function collectBundle(): Bundle {
  const db = getDb()

  const tables: Bundle['tables'] = {
    integrations: db.select().from(integrations).all(),
    syncEvents: db.select().from(syncEvents).all(),
    checklistItems: db.select().from(checklistItems).all(),
    checklistTemplates: db.select().from(checklistTemplates).all(),
    calendarEvents: db.select().from(calendarEvents).all(),
    githubItems: db.select().from(githubItems).all(),
    gmailActions: db.select().from(gmailActions).all(),
    driveFiles: db.select().from(driveFiles).all(),
    knowledgeFiles: db.select().from(knowledgeFiles).all(),
    knowledgeSuggestions: db.select().from(knowledgeSuggestions).all(),
    appSettings: db.select().from(appSettings).all(),
    financeAccounts: db.select().from(financeAccounts).all(),
    financeTransactions: db.select().from(financeTransactions).all(),
    financeBalanceSnapshots: db.select().from(financeBalanceSnapshots).all(),
    forecastOverrides: db.select().from(forecastOverrides).all(),
    plaidItems: db.select().from(plaidItems).all(),
    budgetRules: db.select().from(budgetRules).all(),
    categorizationRules: db.select().from(categorizationRules).all(),
    habits: db.select().from(habits).all(),
    habitEntries: db.select().from(habitEntries).all()
  }

  const knowledge: Record<string, string> = {}
  for (const rel of walkMarkdown(KNOWLEDGE_DIR, KNOWLEDGE_DIR)) {
    knowledge[rel] = readFileSync(join(KNOWLEDGE_DIR, rel), 'utf8')
  }

  const vault: Record<string, string> = {}
  if (existsSync(VAULT_DIR)) {
    for (const entry of readdirSync(VAULT_DIR)) {
      if (!entry.endsWith('.enc')) continue
      const full = join(VAULT_DIR, entry)
      if (!statSync(full).isFile()) continue
      vault[entry] = readFileSync(full).toString('base64')
    }
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    tables,
    knowledge,
    vault
  }
}

function encryptBundle(bundle: Bundle, passphrase: string): Buffer {
  const salt = randomBytes(SALT_SIZE)
  const iv = randomBytes(IV_SIZE)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, ciphertext])
}

function decryptBundle(blob: Buffer, passphrase: string): Bundle {
  if (blob.length < HEADER_SIZE + 1) {
    throw new Error('Backup file is too small to be valid')
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a Compass backup file (bad magic header)')
  }
  const version = blob[MAGIC.length]
  if (version !== VERSION) {
    throw new Error(`Unsupported backup version: ${version}`)
  }
  let offset = MAGIC.length + 1
  const salt = blob.subarray(offset, offset + SALT_SIZE)
  offset += SALT_SIZE
  const iv = blob.subarray(offset, offset + IV_SIZE)
  offset += IV_SIZE
  const tag = blob.subarray(offset, offset + TAG_SIZE)
  offset += TAG_SIZE
  const ciphertext = blob.subarray(offset)

  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM auth failure ≡ wrong passphrase OR tampered blob — same surface.
    throw new Error('Wrong passphrase or corrupted backup')
  }
  return JSON.parse(plaintext.toString('utf8')) as Bundle
}

/**
 * Restore writes back to disk in three stages:
 *   1. Wipe + write vault `.enc` files (the master key wrapper has to land
 *      before any subsequent vault op runs)
 *   2. Wipe + write knowledge `.md` files
 *   3. Truncate + bulk-insert every table inside a single transaction
 *
 * Order matters: the DB tables reference vault entries by id; we restore
 * the vault first so a half-applied restore doesn't leave the DB pointing
 * at vault files that don't exist.
 */
function applyRestore(bundle: Bundle): {
  vaultFiles: number
  knowledgeFiles: number
  rows: number
} {
  // --- Vault ---
  let vaultFiles = 0
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true })
  for (const existing of readdirSync(VAULT_DIR)) {
    if (existing.endsWith('.enc') || existing.endsWith('.enc.tmp')) {
      rmSync(join(VAULT_DIR, existing), { force: true })
    }
  }
  for (const [name, b64] of Object.entries(bundle.vault)) {
    // Filenames are constrained by the bundle producer; reject anything
    // that tries to escape the vault dir.
    if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
    if (!name.endsWith('.enc')) continue
    writeFileSync(join(VAULT_DIR, name), Buffer.from(b64, 'base64'))
    vaultFiles++
  }

  // --- Knowledge ---
  let knowledgeFilesWritten = 0
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true })
  // Wipe existing .md (preserve .prev snapshots — they're not in the bundle
  // by design, the user has the source of truth back).
  function wipeMd(dir: string): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        wipeMd(full)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        rmSync(full, { force: true })
      }
    }
  }
  wipeMd(KNOWLEDGE_DIR)

  for (const [rel, content] of Object.entries(bundle.knowledge)) {
    if (rel.includes('..') || rel.startsWith('/')) continue
    const full = join(KNOWLEDGE_DIR, rel)
    if (!full.startsWith(KNOWLEDGE_DIR)) continue
    const parent = full.slice(0, full.lastIndexOf('/'))
    if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(full, content, 'utf8')
    knowledgeFilesWritten++
  }

  // --- Tables ---
  // Use better-sqlite3 directly so we can run inside one transaction and
  // re-coerce ms-timestamp columns from JSON numbers back to Date objects
  // the way Drizzle expects them on insert.
  const db = getDb()
  // Drizzle wraps better-sqlite3; reach through `session` to get the
  // raw connection so we can drive a single nested transaction across
  // every truncate + insert.
  const drizzleSession = (
    db as unknown as {
      session: {
        client?: { transaction: (fn: () => void) => () => void }
        db?: { transaction: (fn: () => void) => () => void }
      }
    }
  ).session
  const sqlite = drizzleSession.client ?? drizzleSession.db
  if (!sqlite || typeof sqlite.transaction !== 'function') {
    throw new Error('Could not access the raw SQLite connection for restore')
  }
  const TABLES = {
    integrations,
    syncEvents,
    checklistItems,
    checklistTemplates,
    calendarEvents,
    githubItems,
    gmailActions,
    driveFiles,
    knowledgeFiles,
    knowledgeSuggestions,
    appSettings,
    financeAccounts,
    financeTransactions,
    financeBalanceSnapshots,
    forecastOverrides,
    plaidItems,
    budgetRules,
    categorizationRules,
    habits,
    habitEntries
  } as const

  // Columns whose Drizzle definition uses `mode: 'timestamp_ms'` — the
  // JSON we serialized turned those Date objects into milliseconds. On
  // re-insert, Drizzle expects Date objects, not numbers.
  const TIMESTAMP_COLUMNS = new Set([
    'connectedAt',
    'lastSyncedAt',
    'syncedAt',
    'createdAt',
    'updatedAt',
    'startAt',
    'endAt',
    'receivedAt',
    'lastModified',
    'lastStatementSyncedAt',
    'ingestedAt',
    'capturedAt',
    'proposedAt',
    'reviewedAt'
  ])

  function rehydrate(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row }
    for (const key of Object.keys(out)) {
      const v = out[key]
      if (
        v != null &&
        TIMESTAMP_COLUMNS.has(key) &&
        (typeof v === 'number' || typeof v === 'string')
      ) {
        const ms = typeof v === 'number' ? v : Date.parse(v)
        if (!Number.isNaN(ms)) out[key] = new Date(ms)
      }
    }
    return out
  }

  let rows = 0
  const txn = sqlite.transaction(() => {
    // Order matters for FK-aware deletes if we ever turn pragma foreign_keys
    // on. better-sqlite3 has it off by default; we still order child-first
    // so a future toggle won't break this path.
    const wipeOrder: Array<keyof typeof TABLES> = [
      'syncEvents',
      'forecastOverrides',
      'financeBalanceSnapshots',
      'financeTransactions',
      'habitEntries',
      'knowledgeSuggestions',
      'knowledgeFiles',
      'gmailActions',
      'githubItems',
      'driveFiles',
      'calendarEvents',
      'checklistItems',
      'checklistTemplates',
      'budgetRules',
      'categorizationRules',
      'financeAccounts',
      'plaidItems',
      'integrations',
      'habits',
      'appSettings'
    ]
    for (const name of wipeOrder) {
      db.delete(TABLES[name]).run()
    }

    const insertOrder: Array<keyof typeof TABLES> = [
      'integrations',
      'plaidItems',
      'habits',
      'financeAccounts',
      'checklistTemplates',
      'budgetRules',
      'categorizationRules',
      'appSettings',
      'syncEvents',
      'checklistItems',
      'calendarEvents',
      'githubItems',
      'gmailActions',
      'driveFiles',
      'knowledgeFiles',
      'knowledgeSuggestions',
      'financeTransactions',
      'financeBalanceSnapshots',
      'forecastOverrides',
      'habitEntries'
    ]
    for (const name of insertOrder) {
      const data = bundle.tables[name]
      if (!Array.isArray(data) || data.length === 0) continue
      const table = TABLES[name]
      for (const rawRow of data) {
        if (!rawRow || typeof rawRow !== 'object') continue
        const row = rehydrate(rawRow as Record<string, unknown>)
        // `.values()` is typed per table; we operate on a heterogenous
        // union here intentionally so a `as never` cast keeps the loop
        // simple without a 20-arm switch on `name`.
        ;(db.insert(table) as unknown as { values: (v: unknown) => { run: () => void } })
          .values(row as never)
          .run()
        rows++
      }
    }
  })
  txn()

  return { vaultFiles, knowledgeFiles: knowledgeFilesWritten, rows }
}

export function registerBackupHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('backup:create', async (_event, passphrase: unknown) => {
    if (typeof passphrase !== 'string' || passphrase.length < 8) {
      return { success: false, error: 'Passphrase must be at least 8 characters' }
    }
    try {
      const dateSlug = new Date().toISOString().slice(0, 10)
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Encrypted Backup',
        defaultPath: join(app.getPath('downloads'), `compass-backup-${dateSlug}.compass-backup`),
        filters: [{ name: 'Compass Backup', extensions: ['compass-backup'] }]
      })
      if (canceled || !filePath) return { success: false, canceled: true }

      const bundle = collectBundle()
      const blob = encryptBundle(bundle, passphrase)
      writeFileSync(filePath, blob)
      return {
        success: true,
        path: filePath,
        size: blob.length,
        stats: {
          tables: Object.keys(bundle.tables).length,
          knowledgeFiles: Object.keys(bundle.knowledge).length,
          vaultFiles: Object.keys(bundle.vault).length
        }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('backup:restore', async (_event, passphrase: unknown) => {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return { success: false, error: 'Passphrase is required' }
    }
    try {
      const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Restore from Encrypted Backup',
        filters: [{ name: 'Compass Backup', extensions: ['compass-backup'] }],
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return { success: false, canceled: true }
      const blob = readFileSync(filePaths[0])
      const bundle = decryptBundle(blob, passphrase)
      const stats = applyRestore(bundle)
      return {
        success: true,
        path: filePaths[0],
        exportedAt: bundle.exportedAt,
        appVersion: bundle.appVersion,
        stats
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

// Exported for unit tests so the round-trip can be exercised without
// dialog / disk I/O.
export const _internal = { collectBundle, encryptBundle, decryptBundle, applyRestore }
