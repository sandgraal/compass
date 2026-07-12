/**
 * Encrypted backup/restore — Tier 1 from the May 2026 strategic review.
 *
 * Produces a single passphrase-encrypted `.compass-backup` file containing
 * everything a fresh machine needs to come back online: EVERY SQLite table as
 * JSON (v3 `allTables`, read drift-proof from the live schema so a new table is
 * never silently dropped), the documents-store originals (`documentsFiles`),
 * every knowledge-base markdown file, every `.vault/*.enc` blob EXCEPT
 * `key.enc`, and the master AES-256 key as plaintext hex inside the bundle.
 *
 * Why bundle the plaintext master key (and NOT `key.enc`): `key.enc` is
 * wrapped with Electron `safeStorage`, which is keyed by the OS Keychain
 * entry for THIS machine + user account. If the user restores onto a new
 * machine, the imported `key.enc` blob is undecryptable there — every
 * vault entry stays sealed forever. So at backup time we unwrap the
 * master key through `safeStorage`, put the plaintext hex inside the
 * passphrase-encrypted bundle (the passphrase is the only secret that
 * matters), and at restore time we rewrap the hex with the destination
 * machine's `safeStorage` and write a fresh `key.enc`.
 *
 * Crypto layout on disk:
 *
 *     [magic "COMPASSB" (8 bytes)]
 *     [version (1 byte) = 0x02]
 *     [salt   (16 bytes)]   → scrypt salt
 *     [IV     (16 bytes)]   → AES-256-GCM IV
 *     [tag    (16 bytes)]   → AES-256-GCM auth tag
 *     [ciphertext           → AES-256-GCM( utf8( JSON.stringify(bundle) ) )]
 *
 * scrypt parameters: N=2^15, r=8, p=1, keylen=32. ~150 ms on modern Macs;
 * dramatically harder to brute-force than a bare key.
 *
 * Version history:
 *   - 0x01 (pre-public): shipped `key.enc` verbatim and used the host
 *     path separator. Never released — no compat shim needed.
 *   - 0x02 (current):    plaintext master key inside bundle, POSIX paths,
 *     atomic restore (DB succeeds before filesystem is touched). The JSON
 *     PAYLOAD carries its own `version`: 2 = curated table subset (legacy, still
 *     restorable); 3 = every table via `allTables` + the documents-store files.
 */

import { constants as bufferConstants } from 'node:buffer'
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
import { sep as PATH_SEP, join, relative } from 'node:path'
import { type IpcMain, app, dialog, safeStorage } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
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
  simplefinConnections,
  syncEvents
} from '../db/schema'
import { getOrCreateKey } from '../lib/crypto-vault'
import { DOCUMENTS_DIR, KNOWLEDGE_DIR, VAULT_DIR } from '../paths'

const MAGIC = Buffer.from('COMPASSB', 'utf8') // 8 bytes
const VERSION = 0x02
const SALT_SIZE = 16
const IV_SIZE = 16
const TAG_SIZE = 16
const KEY_SIZE = 32
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1

const HEADER_SIZE = MAGIC.length + 1 + SALT_SIZE + IV_SIZE + TAG_SIZE
// Upper bound on a restore file we read fully into memory + decrypt before the
// passphrase is even verified (threat-model item #5 — bound user-picked input).
// Pinned to the runtime's real Buffer ceiling: `readFileSync` loads the whole
// file into ONE Buffer, so a larger cap couldn't be honored anyway (it would
// throw ERR_FS_FILE_TOO_LARGE). A real "all tables + documents" backup is well
// within this. (Memory pressure below the ceiling is a separate, softer risk.)
const MAX_RESTORE_BYTES = bufferConstants.MAX_LENGTH

interface Bundle {
  version: 2 | 3
  exportedAt: string
  appVersion: string
  // v2 (legacy): a curated subset of tables, drizzle-serialized (dates → ISO).
  // v3+: `allTables` below supersedes it (kept optional so old bundles restore).
  tables?: Record<string, unknown[]>
  // v3+: EVERY user table, raw sqlite rows. Drift-proof — a newly-added table
  // is captured with no code change (the v2 curated list had silently drifted
  // to omit the `records` spine, `documents`, `contacts`, and ~18 more).
  allTables?: Record<string, Record<string, unknown>[]>
  // Bundle keys are ALWAYS POSIX-slashed regardless of the source OS, so
  // a Windows-created backup with `work\projects.md` round-trips cleanly
  // onto macOS/Linux.
  knowledge: Record<string, string>
  // filename → base64 of the encrypted blob bytes. `key.enc` is
  // deliberately NOT included here — see masterKeyHex below.
  vault: Record<string, string>
  // v3+: the documents store originals (filename → base64), restored to
  // DOCUMENTS_DIR. The `documents` DB rows travel in `allTables`; without the
  // files a restore would leave dangling rows pointing at missing originals.
  documentsFiles?: Record<string, string>
  // The raw 64-char hex of the AES-256 master key. Sensitive in clear,
  // but the whole bundle is passphrase-encrypted so it's protected by
  // scrypt + AES-256-GCM. Required for cross-machine restore: the
  // destination machine wraps this with its own `safeStorage` to
  // rebuild `.vault/key.enc`.
  masterKeyHex: string
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

/** Convert a host-native relative path into POSIX form for stable bundle keys. */
function toPosix(rel: string): string {
  return PATH_SEP === '\\' ? rel.split('\\').join('/') : rel
}

/** Reject bundle paths that try to escape the target dir. */
function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.startsWith('\\')) return false
  // Accept either separator at the bundle layer — we still defensively
  // check both because old v0.1-pre dev builds wrote backslash keys.
  const parts = rel.split(/[/\\]+/)
  return parts.every((p) => p !== '..' && p.length > 0)
}

function walkMarkdown(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(toPosix(relative(base, full)))
    }
  }
  return out
}

/** FTS virtual tables + their fts5 shadow tables + drizzle's migration ledger
 *  are derived/internal — never backed up (records_fts etc. rebuild from their
 *  content tables on next launch). */
export function isBackupTable(name: string): boolean {
  if (name.startsWith('sqlite_')) return false
  if (name === '__drizzle_migrations') return false
  if (name.includes('_fts')) return false // fts5 virtual + _data/_idx/_docsize/_config/_content shadows
  return true
}

/** Every user table → its rows (raw sqlite values). Reads the LIVE schema from
 *  sqlite_master, so a newly-added table is captured with zero code change —
 *  the whole point, since the old curated list silently omitted the `records`
 *  spine, `documents`, `contacts`, and most domain tables. */
function collectAllTables(
  sqlite: ReturnType<typeof getRawSqlite>
): Record<string, Record<string, unknown>[]> {
  const names = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter(isBackupTable)
    .sort()
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const name of names) {
    out[name] = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]
  }
  return out
}

/** The documents-store originals (a flat dir of content-hash-named files) →
 *  base64. No nesting, no traversal — filenames only. */
function collectDocumentsFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(DOCUMENTS_DIR)) return out
  for (const entry of readdirSync(DOCUMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    out[entry.name] = readFileSync(join(DOCUMENTS_DIR, entry.name)).toString('base64')
  }
  return out
}

function collectBundle(): Bundle {
  const allTables = collectAllTables(getRawSqlite())

  const knowledge: Record<string, string> = {}
  for (const rel of walkMarkdown(KNOWLEDGE_DIR, KNOWLEDGE_DIR)) {
    knowledge[rel] = readFileSync(join(KNOWLEDGE_DIR, ...rel.split('/')), 'utf8')
  }

  // Vault: copy every `.enc` blob EXCEPT `key.enc`. The master key
  // travels in `masterKeyHex` so it survives cross-machine restore.
  const vault: Record<string, string> = {}
  if (existsSync(VAULT_DIR)) {
    for (const entry of readdirSync(VAULT_DIR)) {
      if (!entry.endsWith('.enc')) continue
      if (entry === 'key.enc') continue
      const full = join(VAULT_DIR, entry)
      if (!statSync(full).isFile()) continue
      vault[entry] = readFileSync(full).toString('base64')
    }
  }

  // Unwrap the master key through `safeStorage` so the bundle carries
  // it as plaintext hex. `getOrCreateKey()` handles the safeStorage
  // round-trip; the only secret then is the user's passphrase.
  const masterKey = getOrCreateKey()
  const masterKeyHex = masterKey.toString('hex')

  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    allTables,
    knowledge,
    vault,
    documentsFiles: collectDocumentsFiles(),
    masterKeyHex
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
  const parsed = JSON.parse(plaintext.toString('utf8')) as Bundle
  // Light structural validation — `applyRestore` is destructive, we'd
  // rather fail loud here than half-apply on a malformed payload.
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed.version !== 2 && parsed.version !== 3) ||
    typeof parsed.masterKeyHex !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(parsed.masterKeyHex) ||
    !parsed.knowledge ||
    typeof parsed.knowledge !== 'object' ||
    !parsed.vault ||
    typeof parsed.vault !== 'object' ||
    // v3 carries every table in `allTables`; legacy v2 carries a curated `tables`.
    (parsed.version === 3
      ? !parsed.allTables || typeof parsed.allTables !== 'object'
      : !parsed.tables || typeof parsed.tables !== 'object')
  ) {
    throw new Error('Backup payload structure is invalid')
  }
  return parsed
}

/**
 * Restore is staged so the user's current data only gets wiped after the
 * destructive DB operation has succeeded in a single transaction:
 *
 *   1. Validate bundle structure (decryptBundle throws on missing fields)
 *   2. Pre-materialise the new vault + knowledge bytes into memory
 *   3. Run DB truncate + bulk-insert in ONE sqlite transaction. If it
 *      fails, the transaction rolls back and we have not touched the
 *      filesystem yet.
 *   4. Only after the DB transaction commits do we wipe + rewrite the
 *      vault directory and the knowledge directory, then rewrap the
 *      master key with the destination machine's `safeStorage` and
 *      write a fresh `key.enc`.
 *
 * The remaining failure window is between the DB commit and the
 * filesystem writes — if the machine power-cycles right there, the user
 * has DB state from the backup but their pre-restore vault/knowledge
 * files still on disk. The DB-vs-filesystem state will look inconsistent
 * until a re-restore. That's a far smaller blast radius than "passphrase
 * was wrong → vault is gone."
 */
/** v3+ DB restore: wipe + re-insert EVERY table from the bundle via raw sqlite.
 *  `defer_foreign_keys` moves FK enforcement to COMMIT so wipe/insert order is
 *  irrelevant (the snapshot is self-consistent). Tables absent from the current
 *  schema are skipped (forward/backward drift tolerance). */
function restoreAllTablesRaw(allTables: Record<string, Record<string, unknown>[]>): number {
  const sqlite = getRawSqlite()
  const existing = new Set(
    (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
  )
  let rows = 0
  const txn = sqlite.transaction(() => {
    sqlite.pragma('defer_foreign_keys = ON')
    // Wipe EVERY live backup-eligible table — not just those present in the
    // bundle — so a restore is a true full replace. A table that didn't exist
    // when the backup was made (older bundle) ends up empty rather than keeping
    // its pre-restore rows.
    for (const name of existing) {
      if (isBackupTable(name)) sqlite.prepare(`DELETE FROM "${name}"`).run()
    }
    for (const [name, tableRows] of Object.entries(allTables)) {
      if (!existing.has(name) || !isBackupTable(name)) continue
      if (!Array.isArray(tableRows) || tableRows.length === 0) continue
      // Intersect the bundle's columns with the destination table's real columns
      // (PRAGMA on an already-validated table name). This tolerates schema drift
      // (a dropped/renamed column in an old bundle) AND ensures only genuine
      // column identifiers are interpolated into the INSERT — a crafted backup
      // can't smuggle a column name into the SQL.
      const destCols = new Set(
        (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
          (c) => c.name
        )
      )
      const cols = Object.keys(tableRows[0]).filter((c) => destCols.has(c))
      if (cols.length === 0) continue
      const stmt = sqlite.prepare(
        `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols
          .map(() => '?')
          .join(',')})`
      )
      for (const row of tableRows) {
        if (!row || typeof row !== 'object') continue
        stmt.run(...cols.map((c) => (row as Record<string, unknown>)[c] ?? null))
        rows++
      }
    }
  })
  // A throw here rolls the transaction back before any FS write — user keeps state.
  txn()
  return rows
}

/** Legacy v2 DB restore: the curated drizzle table list with per-column
 *  timestamp rehydration + hand-maintained FK wipe/insert order. Kept verbatim
 *  so backups made before v3 still restore. */
function restoreCuratedV2(bundle: Bundle): number {
  const db = getDb()
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
    simplefinConnections,
    budgetRules,
    categorizationRules,
    habits,
    habitEntries
  } as const

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
      'simplefinConnections',
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
      'simplefinConnections',
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
      const data = bundle.tables?.[name]
      if (!Array.isArray(data) || data.length === 0) continue
      const table = TABLES[name]
      for (const rawRow of data) {
        if (!rawRow || typeof rawRow !== 'object') continue
        const row = rehydrate(rawRow as Record<string, unknown>)
        ;(db.insert(table) as unknown as { values: (v: unknown) => { run: () => void } })
          .values(row as never)
          .run()
        rows++
      }
    }
  })
  txn()
  return rows
}

/** Dispatch to the raw (v3+) or curated (v2) DB restore by bundle version. */
function restoreDbTables(bundle: Bundle): number {
  return bundle.version >= 3 && bundle.allTables
    ? restoreAllTablesRaw(bundle.allTables)
    : restoreCuratedV2(bundle)
}

function applyRestore(bundle: Bundle): {
  vaultFiles: number
  knowledgeFiles: number
  rows: number
  documentFiles: number
} {
  // --- Stage 1: materialise vault writes (decode + sanity-check filenames) ---
  const vaultWrites: Array<[string, Buffer]> = []
  for (const [name, b64] of Object.entries(bundle.vault)) {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
    if (!name.endsWith('.enc')) continue
    if (name === 'key.enc') continue // rebuilt locally from masterKeyHex
    try {
      vaultWrites.push([name, Buffer.from(b64, 'base64')])
    } catch {
      // a malformed base64 string would surface as an empty buffer; the
      // explicit catch is a belt-and-suspenders guard.
    }
  }

  // --- Stage 2: materialise knowledge writes (path normalize + safety) ---
  const knowledgeWrites: Array<[string[], string]> = []
  for (const [rel, content] of Object.entries(bundle.knowledge)) {
    if (!isSafeRelativePath(rel)) continue
    // Bundle keys are POSIX, but old v0.1-pre Windows backups (if any)
    // used `\\`. Split on either so we re-join with the host separator.
    const parts = rel.split(/[/\\]+/)
    knowledgeWrites.push([parts, content])
  }

  // --- Stage 3: DB restore. Raw all-tables for v3+ bundles, curated drizzle
  // for legacy v2. A throw rolls the transaction back before any filesystem
  // write happens, so the user keeps their pre-restore state on failure.
  const rows = restoreDbTables(bundle)

  // --- Stage 4: FS writes — only reached if DB restore committed. ---
  // 4a. Vault: wipe existing .enc files, write the bundle's, then rewrap
  // the master key with this machine's safeStorage and emit fresh
  // key.enc.
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true })
  for (const existing of readdirSync(VAULT_DIR)) {
    if (existing.endsWith('.enc') || existing.endsWith('.enc.tmp')) {
      rmSync(join(VAULT_DIR, existing), { force: true })
    }
  }
  for (const [name, bytes] of vaultWrites) {
    writeFileSync(join(VAULT_DIR, name), bytes)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage unavailable — cannot rewrap the master key on this machine')
  }
  const wrapped = safeStorage.encryptString(bundle.masterKeyHex)
  writeFileSync(join(VAULT_DIR, 'key.enc'), wrapped)

  // 4b. Knowledge: wipe .md files (preserve .prev snapshots), then write.
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true })
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

  let knowledgeFilesWritten = 0
  for (const [parts, content] of knowledgeWrites) {
    const full = join(KNOWLEDGE_DIR, ...parts)
    if (!full.startsWith(KNOWLEDGE_DIR)) continue
    const parent = full.slice(0, full.lastIndexOf(PATH_SEP))
    if (parent && parent !== KNOWLEDGE_DIR && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
    writeFileSync(full, content, 'utf8')
    knowledgeFilesWritten++
  }

  // 4c. Documents (v3+): wipe + rewrite the DOCUMENTS_DIR originals (the files
  // behind the `documents` rows). Filenames only — no separators / traversal.
  let documentFiles = 0
  if (bundle.documentsFiles) {
    if (!existsSync(DOCUMENTS_DIR)) mkdirSync(DOCUMENTS_DIR, { recursive: true })
    for (const existing of readdirSync(DOCUMENTS_DIR)) {
      // recursive so a stray subdirectory can't throw EISDIR after the DB txn
      // has already committed (which would leave a partial restore).
      rmSync(join(DOCUMENTS_DIR, existing), { force: true, recursive: true })
    }
    for (const [name, b64] of Object.entries(bundle.documentsFiles)) {
      if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
      writeFileSync(join(DOCUMENTS_DIR, name), Buffer.from(b64, 'base64'))
      documentFiles++
    }
  }

  return {
    vaultFiles: vaultWrites.length,
    knowledgeFiles: knowledgeFilesWritten,
    rows,
    documentFiles
  }
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
          tables: Object.keys(bundle.allTables ?? {}).length,
          knowledgeFiles: Object.keys(bundle.knowledge).length,
          vaultFiles: Object.keys(bundle.vault).length,
          documentFiles: Object.keys(bundle.documentsFiles ?? {}).length
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
      if (statSync(filePaths[0]).size > MAX_RESTORE_BYTES) {
        return { success: false, error: 'Backup file is too large to restore safely' }
      }
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
// ── Snapshot façade (Phase 4b device sync) ──────────────────────────────────
// Device sync reuses the exact backup pipeline: the encrypted snapshot IS a
// `.compass-backup` bundle, so the sync payload inherits the comprehensive v3
// capture, the crypto (scrypt + AES-256-GCM), and the atomic restore.

/** Build a passphrase-encrypted snapshot of everything (the v3 bundle). */
export function buildEncryptedSnapshot(passphrase: string): {
  blob: Buffer
  exportedAt: string
} {
  const bundle = collectBundle()
  return { blob: encryptBundle(bundle, passphrase), exportedAt: bundle.exportedAt }
}

/** Decrypt + fully apply a snapshot (destructive full replace — see applyRestore). */
export function restoreEncryptedSnapshot(
  blob: Buffer,
  passphrase: string
): { rows: number; vaultFiles: number; knowledgeFiles: number; documentFiles: number } {
  return applyRestore(decryptBundle(blob, passphrase))
}

export const _internal = {
  collectBundle,
  encryptBundle,
  decryptBundle,
  applyRestore,
  toPosix,
  isSafeRelativePath
}
