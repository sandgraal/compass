/**
 * Universal Export IPC (Phase 9 — "The Storehouse", Wave 1).
 *
 * The portability backbone. Every handler here writes PLAINTEXT, standard-format
 * files the user can re-import into any other service — the counterpart to the
 * *encrypted* bundle in `backup.ts`. The renderer's Export Center page warns that
 * these files are unencrypted before invoking anything here.
 *
 * SECURITY: nothing in this module reads `VAULT_DIR` or the crypto-vault. Secrets
 * never leave through the portable export path; the encrypted backup is the only
 * thing that carries vault data, and only the user's passphrase can open it.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { calendarEvents, financeAccounts, financeTransactions } from '../db/schema'
import { serializeCsv } from '../lib/csv'
import { serializeIcs } from '../lib/ics'
import { KNOWLEDGE_DIR } from '../paths'
import { buildContactsCsv, buildContactsVcf } from './contacts'

// ─── Pure builders (also called by export:export-all) ─────────────────────────

/** All synced calendar events as one portable `.ics` string. */
export function buildCalendarIcs(): string {
  const db = getDb()
  const rows = db.select().from(calendarEvents).all()
  return serializeIcs(
    rows.map((r) => ({
      externalId: r.externalId,
      title: r.title,
      startAt: r.startAt,
      endAt: r.endAt,
      allDay: r.allDay,
      location: r.location,
      description: r.description
    })),
    { calendarName: 'Compass' }
  )
}

const TXN_HEADERS = [
  'date',
  'amount',
  'description',
  'account',
  'category',
  'subcategory',
  'geo',
  'purpose',
  'tax_tag',
  'notes'
]

/** The full transaction ledger as a `.csv` string. */
export function buildTransactionsCsv(): string {
  const db = getDb()
  const txns = db.select().from(financeTransactions).all()
  const accounts = db
    .select({ id: financeAccounts.id, name: financeAccounts.name })
    .from(financeAccounts)
    .all()
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const rows = txns.map((t) => ({
    date: t.date,
    amount: t.amount,
    description: t.description,
    account: t.accountId != null ? (accountName.get(t.accountId) ?? '') : '',
    category: t.category ?? '',
    subcategory: t.subcategory ?? '',
    geo: t.geo,
    purpose: t.purpose ?? '',
    tax_tag: t.taxTag,
    notes: t.notes ?? ''
  }))
  return serializeCsv(rows, TXN_HEADERS)
}

/** Recursively list every `.md` file under `dir`. */
function listMarkdown(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...listMarkdown(full))
    else if (stat.isFile() && entry.endsWith('.md')) out.push(full)
  }
  return out
}

/** Copy the knowledge-base markdown tree into `destDir`, preserving structure. Returns file count. */
function copyKnowledgeInto(destDir: string): number {
  const files = listMarkdown(KNOWLEDGE_DIR)
  for (const src of files) {
    const rel = relative(KNOWLEDGE_DIR, src)
    const dest = join(destDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  return files.length
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function registerExportHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('calendar:export-ics', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export calendar to ICS',
      defaultPath: 'compass-calendar.ics',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      writeFileSync(filePath, buildCalendarIcs(), 'utf-8')
      return { success: true, path: filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('finance:export-transactions-csv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export transactions to CSV',
      defaultPath: 'compass-transactions.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      writeFileSync(filePath, buildTransactionsCsv(), 'utf-8')
      return { success: true, path: filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('knowledge:export-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a folder to export your knowledge notes into',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      const dest = join(filePaths[0], 'compass-knowledge')
      mkdirSync(dest, { recursive: true })
      const count = copyKnowledgeInto(dest)
      return { success: true, path: dest, count }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // "Export Everything" — one folder picker, writes every domain as an open
  // standard-format file plus a manifest. Deliberately excludes the vault.
  ipcMain.handle('export:export-all', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a folder for your full Compass export',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    try {
      const root = join(filePaths[0], `compass-export-${timestamp()}`)
      mkdirSync(root, { recursive: true })

      const vcf = buildContactsVcf()
      const contactsCsv = buildContactsCsv()
      const ics = buildCalendarIcs()
      const txnCsv = buildTransactionsCsv()
      writeFileSync(join(root, 'contacts.vcf'), vcf, 'utf-8')
      writeFileSync(join(root, 'contacts.csv'), contactsCsv, 'utf-8')
      writeFileSync(join(root, 'calendar.ics'), ics, 'utf-8')
      writeFileSync(join(root, 'transactions.csv'), txnCsv, 'utf-8')
      const knowledgeCount = copyKnowledgeInto(join(root, 'knowledge'))

      const manifest = [
        'Compass — Full Portable Export',
        `Generated: ${new Date().toISOString()}`,
        '',
        'These files are UNENCRYPTED and contain your personal data. Store them',
        'somewhere safe. They use open standard formats you can import elsewhere:',
        '',
        '  contacts.vcf       — vCard 3.0 (import into any phone / address book)',
        '  contacts.csv       — spreadsheet-friendly contact list',
        '  calendar.ics       — iCalendar (import into any calendar app)',
        '  transactions.csv   — full finance ledger',
        `  knowledge/         — ${knowledgeCount} markdown note(s)`,
        '',
        'NOT included: the encrypted vault (passwords, IDs, account numbers).',
        'Use Settings → Backup to export the vault under your passphrase.'
      ].join('\n')
      writeFileSync(join(root, 'manifest.txt'), manifest, 'utf-8')

      return {
        success: true,
        path: root,
        files: ['contacts.vcf', 'contacts.csv', 'calendar.ics', 'transactions.csv', 'manifest.txt'],
        knowledgeCount
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

// Exported for the export-all test (lets it assert which files land on disk
// without re-implementing the manifest text).
export const _internal = { copyKnowledgeInto, listMarkdown }
