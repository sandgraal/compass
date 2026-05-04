import { IpcMain, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { VAULT_DIR } from '../main'

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
  { id: 'financial', label: 'Financial', icon: 'banknote', description: 'Bank accounts, credit cards, investments' },
  { id: 'identity', label: 'Identity', icon: 'id-card', description: 'SSN, passport, driver\'s license' },
  { id: 'credentials', label: 'Credentials', icon: 'key', description: 'Passwords, API keys, license keys' },
  { id: 'medical', label: 'Medical', icon: 'heart-pulse', description: 'Insurance, prescriptions, providers' },
  { id: 'legal', label: 'Legal', icon: 'scale', description: 'Contracts, wills, property documents' }
]

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

  ipcMain.handle('vault:update-entry', (_event, category: string, id: string, updates: Record<string, unknown>) => {
    const key = getOrCreateKey()
    const entries = readVaultCategory(category, key) as Record<string, unknown>[]
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) throw new Error('Entry not found')
    entries[idx] = { ...entries[idx], ...updates, updatedAt: Date.now() }
    writeVaultCategory(category, entries, key)
    return entries[idx]
  })

  ipcMain.handle('vault:delete-entry', (_event, category: string, id: string) => {
    const key = getOrCreateKey()
    const entries = readVaultCategory(category, key) as Record<string, unknown>[]
    const filtered = entries.filter((e) => (e as Record<string, unknown>).id !== id)
    writeVaultCategory(category, filtered, key)
    return { success: true }
  })
}
