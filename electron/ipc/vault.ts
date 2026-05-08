import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type IpcMain, dialog, safeStorage } from 'electron'
import { VAULT_DIR } from '../paths'

const ALGORITHM = 'aes-256-gcm'
const KEY_SIZE = 32 // 256 bits
const IV_SIZE = 16

// The AES key is stored encrypted in the OS Keychain via safeStorage
// The encrypted key blob is saved in .vault/key.enc
function getOrCreateKey(): Buffer {
  const keyPath = join(VAULT_DIR, 'key.enc')

  if (existsSync(keyPath)) {
    const encrypted = readFileSync(keyPath)
    const decrypted = safeStorage.decryptString(encrypted)
    return Buffer.from(decrypted, 'hex')
  }

  // Generate a new 256-bit key
  const key = randomBytes(KEY_SIZE)
  const encryptedKey = safeStorage.encryptString(key.toString('hex'))
  writeFileSync(keyPath, encryptedKey)
  return key
}

function encryptBlob(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_SIZE)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Layout: [IV(16)] [authTag(16)] [ciphertext]
  return Buffer.concat([iv, authTag, encrypted])
}

function decryptBlob(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_SIZE)
  const authTag = blob.subarray(IV_SIZE, IV_SIZE + 16)
  const ciphertext = blob.subarray(IV_SIZE + 16)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

function readVaultCategory(category: string, key: Buffer): unknown[] {
  const path = join(VAULT_DIR, `${category}.enc`)
  if (!existsSync(path)) return []
  try {
    const blob = readFileSync(path)
    const json = decryptBlob(blob, key)
    return JSON.parse(json)
  } catch {
    return []
  }
}

function writeVaultCategory(category: string, entries: unknown[], key: Buffer): void {
  const path = join(VAULT_DIR, `${category}.enc`)
  const blob = encryptBlob(JSON.stringify(entries), key)
  writeFileSync(path, blob)
}

const VAULT_CATEGORIES = [
  {
    id: 'financial',
    label: 'Financial',
    icon: 'banknote',
    description: 'Bank accounts, credit cards, investments'
  },
  {
    id: 'identity',
    label: 'Identity',
    icon: 'id-card',
    description: "SSN, passport, driver's license"
  },
  {
    id: 'credentials',
    label: 'Credentials',
    icon: 'key',
    description: 'Passwords, API keys, license keys'
  },
  {
    id: 'medical',
    label: 'Medical',
    icon: 'heart-pulse',
    description: 'Insurance, prescriptions, providers'
  },
  {
    id: 'legal',
    label: 'Legal',
    icon: 'scale',
    description: 'Contracts, wills, property documents'
  }
]

/**
 * Seed (idempotently) a stub financial Vault entry for each detected account.
 * Skips entries whose `institution` + `accountType` already exist — won't
 * overwrite anything the user has filled in. Returns the count of new entries
 * created so callers can tell the user.
 *
 * Designed for the finance folder watcher: when a CSV/XLSX reveals an
 * account we've never seen, we drop a stub the user can complete in Vault
 * (account #, routing, login, security questions, etc.).
 */
export function seedVaultFromDetectedAccounts(
  detectedAccounts: Array<{
    name: string
    institution: string
    type: string
    lastFour?: string
    sourceFile: string
  }>
): number {
  if (detectedAccounts.length === 0) return 0
  const key = getOrCreateKey()
  const existing = readVaultCategory('financial', key) as Record<string, unknown>[]
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
    // Idempotent match on institution + accountType + lastFour
    const dupe = existing.find((e) => {
      if (e.institution !== acct.institution) return false
      if (e.accountType !== accountTypeLabel) return false
      if (acct.lastFour && e.accountNumber && String(e.accountNumber).endsWith(acct.lastFour))
        return true
      // No lastFour — match on the human name (USAA Checking vs USAA Savings)
      if (!acct.lastFour && e.notes && String(e.notes).includes(acct.name)) return true
      return !acct.lastFour
    })
    if (dupe) continue

    const newEntry = {
      id: randomBytes(8).toString('hex'),
      institution: acct.institution,
      accountType: accountTypeLabel,
      accountNumber: acct.lastFour ? `••••${acct.lastFour}` : '',
      routingNumber: '',
      notes: `Auto-detected from ${acct.sourceFile} — ${acct.name}. Fill in account number, login, and security questions.`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _autoSeeded: true
    }
    existing.push(newEntry)
    added++
  }

  if (added > 0) writeVaultCategory('financial', existing, key)
  return added
}

export function registerVaultHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('vault:get-categories', () => VAULT_CATEGORIES)

  ipcMain.handle('vault:get-entries', (_event, category: string) => {
    const key = getOrCreateKey()
    return readVaultCategory(category, key)
  })

  ipcMain.handle('vault:add-entry', (_event, category: string, entry: Record<string, unknown>) => {
    const key = getOrCreateKey()
    const entries = readVaultCategory(category, key) as Record<string, unknown>[]
    const newEntry = {
      ...entry,
      id: randomBytes(8).toString('hex'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    entries.push(newEntry)
    writeVaultCategory(category, entries, key)
    return newEntry
  })

  ipcMain.handle(
    'vault:update-entry',
    (_event, category: string, id: string, updates: Record<string, unknown>) => {
      const key = getOrCreateKey()
      const entries = readVaultCategory(category, key) as Record<string, unknown>[]
      const idx = entries.findIndex((e) => e.id === id)
      if (idx === -1) throw new Error('Entry not found')
      const current = entries[idx]
      // Snapshot the current user-facing fields (exclude system/history fields)
      const {
        _history,
        id: _id,
        createdAt,
        updatedAt,
        ...snapshot
      } = current as Record<string, unknown>
      const history = (Array.isArray(current._history) ? current._history : []) as unknown[]
      const newHistory = [{ ...snapshot, _savedAt: updatedAt ?? Date.now() }, ...history].slice(
        0,
        5
      )
      entries[idx] = { ...current, ...updates, updatedAt: Date.now(), _history: newHistory }
      writeVaultCategory(category, entries, key)
      return entries[idx]
    }
  )

  ipcMain.handle('vault:delete-entry', (_event, category: string, id: string) => {
    const key = getOrCreateKey()
    const entries = readVaultCategory(category, key) as Record<string, unknown>[]
    const filtered = entries.filter((e) => (e as Record<string, unknown>).id !== id)
    writeVaultCategory(category, filtered, key)
    return { success: true }
  })

  ipcMain.handle('vault:import-1password-csv', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Import from 1Password CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }

    try {
      const raw = readFileSync(filePaths[0], 'utf-8')
      const rows = parseCSV(raw)
      if (rows.length === 0) return { success: false, error: 'Empty or invalid CSV' }

      const key = getOrCreateKey()
      const credEntries = readVaultCategory('credentials', key) as Record<string, unknown>[]
      const financialEntries = readVaultCategory('financial', key) as Record<string, unknown>[]

      let imported = 0
      for (const row of rows) {
        const type = (row.Type || row.type || 'Login').toLowerCase()
        const title = row.Title || row.title || ''
        const username = row.Username || row.username || row.Email || row.email || ''
        const password = row.Password || row.password || ''
        const url = row.Url || row.URL || row.url || row.Website || ''
        const notes = row.Notes || row.notes || ''

        if (type.includes('credit') || type.includes('card')) {
          const entry = {
            id: randomBytes(8).toString('hex'),
            institution: title,
            accountType: 'Credit Card',
            notes: [url, notes].filter(Boolean).join('\n'),
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
          financialEntries.push(entry)
        } else {
          // Login, Secure Note, API Credential, etc. → credentials category
          const entry = {
            id: randomBytes(8).toString('hex'),
            service: title,
            username,
            password,
            apiKey: '',
            notes: [url, notes].filter(Boolean).join('\n'),
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
          credEntries.push(entry)
        }
        imported++
      }

      writeVaultCategory('credentials', credEntries, key)
      writeVaultCategory('financial', financialEntries, key)

      return { success: true, imported }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

/** Minimal RFC-4180 CSV parser — handles quoted fields with embedded commas/newlines */
function parseCSV(raw: string): Record<string, string>[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) return []

  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]

    if (char === '"') {
      if (inQuotes && normalized[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      record.push(field)
      field = ''
      continue
    }

    if (char === '\n' && !inQuotes) {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      continue
    }

    field += char
  }

  record.push(field)
  records.push(record)

  if (records.length < 2) return []

  const headers = records[0]
  const result: Record<string, string>[] = []

  for (let r = 1; r < records.length; r++) {
    const vals = records[r]
    if (vals.length === 1 && !vals[0].trim()) continue

    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = vals[i] ?? ''
    })
    result.push(row)
  }

  return result
}
