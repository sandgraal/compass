/**
 * Encrypted backup/restore — Tier 1 from the May 2026 strategic review.
 *
 * Produces a single passphrase-encrypted `.compass-backup` file containing
 * everything a fresh machine needs to come back online: the SQLite tables
 * as JSON, every knowledge-base markdown file, every `.vault/*.enc` blob
 * EXCEPT `key.enc`, and the master AES-256 key as plaintext hex inside
 * the bundle.
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
 *     atomic restore (DB succeeds before filesystem is touched).
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
import { sep as PATH_SEP, join, relative } from 'node:path'
import { type IpcMain, app, dialog, safeStorage } from 'electron'
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
  simplefinConnections,
  syncEvents
} from '../db/schema'
import { getOrCreateKey } from '../lib/crypto-vault'
import { KNOWLEDGE_DIR, VAULT_DIR } from '../paths'

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

interface Bundle {
  version: 2
  exportedAt: string
  appVersion: string
  tables: Record<string, unknown[]>
  // Bundle keys are ALWAYS POSIX-slashed regardless of the source OS, so
  // a Windows-created backup with `work\projects.md` round-trips cleanly
  // onto macOS/Linux.
  knowledge: Record<string, string>
  // filename → base64 of the encrypted blob bytes. `key.enc` is
  // deliberately NOT included here — see masterKeyHex below.
  vault: Record<string, string>
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
    simplefinConnections: db.select().from(simplefinConnections).all(),
    budgetRules: db.select().from(budgetRules).all(),
    categorizationRules: db.select().from(categorizationRules).all(),
    habits: db.select().from(habits).all(),
    habitEntries: db.select().from(habitEntries).all()
  }

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
    version: 2,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    tables,
    knowledge,
    vault,
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
    parsed.version !== 2 ||
    typeof parsed.masterKeyHex !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(parsed.masterKeyHex) ||
    !parsed.tables ||
    typeof parsed.tables !== 'object' ||
    !parsed.knowledge ||
    typeof parsed.knowledge !== 'object' ||
    !parsed.vault ||
    typeof parsed.vault !== 'object'
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
function applyRestore(bundle: Bundle): {
  vaultFiles: number
  knowledgeFiles: number
  rows: number
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

  // --- Stage 3: DB restore inside a single transaction ---
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
      const data = bundle.tables[name]
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
  // If this throws, the sqlite transaction rolls back AND no FS writes have
  // happened yet. The user keeps their pre-restore state.
  txn()

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

  return { vaultFiles: vaultWrites.length, knowledgeFiles: knowledgeFilesWritten, rows }
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
export const _internal = {
  collectBundle,
  encryptBundle,
  decryptBundle,
  applyRestore,
  toPosix,
  isSafeRelativePath
}
