import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type IpcMain, dialog } from 'electron'
import { decryptBlob, encryptBlob, getOrCreateKey, writeEncryptedJson } from '../lib/crypto-vault'
import { parseCSV } from '../lib/csv'
import { detectGenotypeProvider, parseGenotypeSummary } from '../lib/genetics'
import { VAULT_DIR } from '../paths'
import { insertLifeRecord } from './life-records'

// Crypto primitives live in `electron/lib/crypto-vault.ts` so the Plaid
// token vault can share the same master key + AES layout.

/**
 * Reject any `category` that isn't one of the IDs declared in
 * `VAULT_CATEGORIES`. Without this, a hostile (or buggy) renderer could
 * pass `'../foo'` / `'key'` / etc. via `vault:get-entries` and write
 * outside `VAULT_DIR` or clobber the master-key blob.
 */
function assertKnownCategory(category: string): void {
  if (!VAULT_CATEGORIES.some((c) => c.id === category)) {
    throw new Error(`Unknown vault category: ${category}`)
  }
}

function readVaultCategory(category: string, key: Buffer): unknown[] {
  assertKnownCategory(category)
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
  assertKnownCategory(category)
  const path = join(VAULT_DIR, `${category}.enc`)
  const blob = encryptBlob(JSON.stringify(entries), key)
  writeFileSync(path, blob)
}

// The vault split (2026-07): the five old "document" categories (financial /
// identity / medical / legal / foreign-accounts) moved to the plaintext
// `life_records` table — see electron/ipc/life-records.ts and
// docs/data-access-policy.md. The vault now holds ONLY what must stay sealed:
// credentials, genetics, and (as a standalone non-category blob) the
// record-secrets map for life records. `assertKnownCategory` seals the
// migrated categories from IPC automatically.
const VAULT_CATEGORIES = [
  {
    id: 'credentials',
    label: 'Credentials',
    icon: 'key',
    description: 'Passwords, API keys, license keys'
  },
  {
    // Genetics is the most sensitive category in the app — immutable, family-
    // implicating, GINA discrimination risk. It's sealed even from the in-app
    // assistant and, like every vault category, structurally unreachable by
    // MCP. Raw genotype text never lives in this category's own entries — see
    // `vault:import-genetics-file` below, which stores it as a separate
    // standalone encrypted blob and keeps only a summary here.
    id: 'genetics',
    label: 'Genetics',
    icon: 'dna',
    description: 'Raw genotype data (23andMe, AncestryDNA) — sealed from AI, vault-only'
  }
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
    const deleted = entries.find((e) => (e as Record<string, unknown>).id === id)
    const filtered = entries.filter((e) => (e as Record<string, unknown>).id !== id)
    writeVaultCategory(category, filtered, key)

    // Genetics entries point at a standalone raw-genotype blob (see
    // `vault:import-genetics-file`) that lives outside the category array —
    // clean it up too, or it'd be an orphaned encrypted file on disk forever.
    const rawBlobName = typeof deleted?.rawBlobName === 'string' ? deleted.rawBlobName : null
    if (
      category === 'genetics' &&
      rawBlobName &&
      rawBlobName.startsWith('genetics_raw_') &&
      /^[A-Za-z0-9_-]{1,64}$/.test(rawBlobName)
    ) {
      const rawPath = join(VAULT_DIR, `${rawBlobName}.enc`)
      try {
        if (existsSync(rawPath)) unlinkSync(rawPath)
      } catch {
        /* ignore */
      }
    }

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

      let imported = 0
      for (const row of rows) {
        const type = (row.Type || row.type || 'Login').toLowerCase()
        const title = row.Title || row.title || ''
        const username = row.Username || row.username || row.Email || row.email || ''
        const password = row.Password || row.password || ''
        const url = row.Url || row.URL || row.url || row.Website || ''
        const notes = row.Notes || row.notes || ''

        if (type.includes('credit') || type.includes('card')) {
          // Credit cards are non-secret metadata post-split (1Password's CSV
          // export never carried card numbers) → a financial life record.
          insertLifeRecord({
            externalId: `1password:${randomUUID()}`,
            category: 'financial',
            fields: { institution: title, accountType: 'Credit Card' },
            notes: [url, notes].filter(Boolean).join('\n') || null,
            source: '1password'
          })
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

      return { success: true, imported }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('vault:import-genetics-file', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Import raw genotype data (23andMe / AncestryDNA)',
      filters: [{ name: 'Raw genotype data', extensions: ['txt'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }

    try {
      const rawText = readFileSync(filePaths[0], 'utf-8')
      const provider = detectGenotypeProvider(rawText)
      if (!provider) {
        return {
          success: false,
          error: 'Unrecognized file — expected a 23andMe or AncestryDNA raw-data export'
        }
      }
      const summary = parseGenotypeSummary(rawText, provider)

      const key = getOrCreateKey()
      const entryId = randomBytes(8).toString('hex')
      const rawBlobName = `genetics_raw_${entryId}`
      // The raw genotype text is a standalone encrypted blob, never a
      // VAULT_CATEGORIES entry field — it's never parsed further or rendered.
      writeEncryptedJson(rawBlobName, rawText, key)

      const entries = readVaultCategory('genetics', key) as Record<string, unknown>[]
      const entry = {
        id: entryId,
        provider: summary.provider,
        service: summary.provider === '23andme' ? '23andMe' : 'AncestryDNA',
        buildAssembly: summary.buildAssembly ?? '',
        snpCount: String(summary.snpCount),
        notes: '',
        rawBlobName,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      entries.push(entry)
      writeVaultCategory('genetics', entries, key)

      return { success: true, imported: 1, entry }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
