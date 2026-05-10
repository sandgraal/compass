/**
 * CSV-based bank ingestion. TypeScript port of the Python ingest at
 * /Users/christopherennis/Documents/Claude/Projects/Getting on top of finances/08_scripts/ingest.py
 *
 * Future v2: replace the CSV parser with `electron/integrations/plaid.ts` for
 * live read-only bank data. The downstream pieces (categorizer, dedupe,
 * write-to-DB, knowledge-base markdown) stay unchanged.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

// ---------- Types ----------
export type RawTxn = {
  date: string // ISO 'YYYY-MM-DD'
  amount: number // negative = expense
  description: string
  account: string
  category?: string
  subcategory?: string
  notes?: string
  sourceFile: string
  hash: string
}

type Parser = {
  name: string
  matches: (headerLower: string[]) => boolean
  parse: (headers: string[], rows: string[][], file: string, accountHint: string) => RawTxn[]
}

// ---------- Helpers ----------
// Exported for reuse by `finance-pdf.ts` (PDF extractors share these).
export const parseMoney = (s: string): number => {
  const t = s.trim().replace(/[$,]/g, '')
  if (!t) return 0
  if (t.startsWith('(') && t.endsWith(')')) return -Number.parseFloat(t.slice(1, -1))
  // Trailing minus (e.g. "500.00-") is used by some banks (USAA) to denote credits.
  if (t.endsWith('-')) return -Number.parseFloat(t.slice(0, -1))
  return Number.parseFloat(t)
}

export const parseDate = (s: string): string => {
  const t = s.trim()
  // Try ISO, then US, then 2-digit year, then ISO with slashes, then EU
  const fmts = [
    /^(\d{4})-(\d{2})-(\d{2})$/, // YYYY-MM-DD
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // M/D/YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, // M/D/YY
    /^(\d{4})\/(\d{2})\/(\d{2})$/ // YYYY/MM/DD
  ]
  let m: RegExpMatchArray | null
  if ((m = t.match(fmts[0]))) return `${m[1]}-${m[2]}-${m[3]}`
  if ((m = t.match(fmts[1]))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  if ((m = t.match(fmts[2]))) {
    const yr = Number.parseInt(m[3], 10)
    const fullYr = yr < 50 ? 2000 + yr : 1900 + yr
    return `${fullYr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  if ((m = t.match(fmts[3]))) return `${m[1]}-${m[2]}-${m[3]}`
  throw new Error(`Unrecognized date: ${s}`)
}

export const hashTxn = (date: string, amount: number, desc: string, account: string): string =>
  createHash('sha1')
    .update(`${date}|${amount.toFixed(2)}|${desc.trim().toLowerCase()}|${account}`)
    .digest('hex')
    .slice(0, 16)

const findIdx = (h: string[], ...names: string[]): number => {
  for (const n of names) {
    const i = h.findIndex((c) => c === n || c.includes(n))
    if (i !== -1) return i
  }
  return -1
}

// ---------- Parsers ----------
const chase: Parser = {
  name: 'Chase',
  matches: (h) =>
    (h.includes('transaction date') || h.includes('trans date')) &&
    h.includes('post date') &&
    h.includes('amount'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = findIdx(h, 'transaction date', 'trans date')
    const ai = findIdx(h, 'amount')
    const descI = findIdx(h, 'description')
    return rows.flatMap((r) => {
      try {
        return [
          {
            date: parseDate(r[di]),
            amount: parseMoney(r[ai]),
            description: r[descI].trim(),
            account: hint || 'Chase',
            sourceFile: file,
            hash: hashTxn(parseDate(r[di]), parseMoney(r[ai]), r[descI], hint || 'Chase')
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const amex: Parser = {
  name: 'Amex',
  matches: (h) =>
    h[0] === 'date' && h[1] === 'description' && h[2] === 'amount' && !h.includes('post date'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = h.indexOf('date')
    const ai = h.indexOf('amount')
    const descI = h.indexOf('description')
    return rows.flatMap((r) => {
      try {
        const amt = -parseMoney(r[ai]) // Amex: positive in export = expense; flip sign
        const date = parseDate(r[di])
        return [
          {
            date,
            amount: amt,
            description: r[descI].trim(),
            account: hint || 'Amex',
            sourceFile: file,
            hash: hashTxn(date, amt, r[descI], hint || 'Amex')
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const capitalOne: Parser = {
  name: 'Capital One',
  matches: (h) =>
    h.includes('transaction date') &&
    h.includes('posted date') &&
    h.includes('debit') &&
    h.includes('credit'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = h.indexOf('transaction date')
    const descI = h.indexOf('description')
    const dbi = h.indexOf('debit')
    const ci = h.indexOf('credit')
    return rows.flatMap((r) => {
      try {
        const debit = r[dbi] ? parseMoney(r[dbi]) : 0
        const credit = r[ci] ? parseMoney(r[ci]) : 0
        const amount = credit - debit
        const date = parseDate(r[di])
        return [
          {
            date,
            amount,
            description: r[descI].trim(),
            account: hint || 'Capital One',
            sourceFile: file,
            hash: hashTxn(date, amount, r[descI], hint || 'Capital One')
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const discover: Parser = {
  name: 'Discover',
  matches: (h) =>
    (h.includes('trans. date') || h.includes('trans date')) &&
    h.includes('post date') &&
    h.includes('category'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = findIdx(h, 'trans. date', 'trans date', 'transaction date')
    const ai = h.indexOf('amount')
    const descI = h.indexOf('description')
    return rows.flatMap((r) => {
      try {
        const amount = -parseMoney(r[ai])
        const date = parseDate(r[di])
        return [
          {
            date,
            amount,
            description: r[descI].trim(),
            account: hint || 'Discover',
            sourceFile: file,
            hash: hashTxn(date, amount, r[descI], hint || 'Discover')
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const boa: Parser = {
  name: 'Bank of America',
  matches: (h) => h.includes('running bal.') || h.includes('running bal'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = h.indexOf('date')
    const ai = h.indexOf('amount')
    const descI = h.indexOf('description')
    return rows.flatMap((r) => {
      try {
        if (!r[0] || r[0].toLowerCase().includes('summary')) return []
        const amount = parseMoney(r[ai])
        const date = parseDate(r[di])
        return [
          {
            date,
            amount,
            description: r[descI].trim(),
            account: hint || 'Bank of America',
            sourceFile: file,
            hash: hashTxn(date, amount, r[descI], hint || 'Bank of America')
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const usaa: Parser = {
  // USAA bank-download CSV: Date, Description, Original Description, Category, Amount, Status
  // Posted/Pending in Status; Amount is signed (negative = expense). Account hint comes from filename
  // (e.g. "USAA_Checking_2026_bk_download.csv" → "USAA Checking").
  name: 'USAA',
  matches: (h) =>
    h.includes('date') &&
    h.includes('description') &&
    h.includes('original description') &&
    h.includes('amount') &&
    h.includes('status'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = h.indexOf('date')
    const descI = h.indexOf('description')
    const origI = h.indexOf('original description')
    const catI = h.indexOf('category')
    const ai = h.indexOf('amount')
    const si = h.indexOf('status')
    const account = hint || 'USAA'
    return rows.flatMap((r) => {
      try {
        if (si !== -1 && (r[si] || '').trim().toLowerCase() === 'pending') return [] // skip pending
        const amount = parseMoney(r[ai])
        const date = parseDate(r[di])
        const description = (r[descI] || r[origI] || '').trim()
        return [
          {
            date,
            amount,
            description,
            account,
            category: catI !== -1 ? r[catI]?.trim() || undefined : undefined,
            sourceFile: file,
            hash: hashTxn(date, amount, description, account)
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const generic: Parser = {
  name: 'Generic',
  matches: () => true,
  parse: (headers, rows, file, hint) => {
    const h = headers.map((c) => c.trim().toLowerCase())
    const di = findIdx(h, 'transaction date', 'trans date', 'date', 'posted')
    const descI = findIdx(h, 'description', 'memo', 'narration', 'details')
    const ai = findIdx(h, 'amount', 'value')
    const dbi = findIdx(h, 'debit', 'withdrawal')
    const ci = findIdx(h, 'credit', 'deposit')
    if (di === -1 || descI === -1 || (ai === -1 && dbi === -1 && ci === -1)) return []
    return rows.flatMap((r) => {
      try {
        let amount = 0
        if (ai !== -1) amount = parseMoney(r[ai])
        else amount = (r[ci] ? parseMoney(r[ci]) : 0) - (r[dbi] ? parseMoney(r[dbi]) : 0)
        const date = parseDate(r[di])
        return [
          {
            date,
            amount,
            description: r[descI].trim(),
            account: hint || basename(file, '.csv'),
            sourceFile: file,
            notes: 'Generic-parsed — verify amount sign',
            hash: hashTxn(date, amount, r[descI], hint || basename(file, '.csv'))
          }
        ]
      } catch {
        return []
      }
    })
  }
}

const PARSERS: Parser[] = [chase, capitalOne, discover, amex, boa, usaa, generic]

// ---------- CSV reader (minimal, no external dep) ----------
function readCsv(path: string): { headers: string[]; rows: string[][] } {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') inQuote = false
      else cell += c
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') {
        row.push(cell)
        cell = ''
      } else if (c === '\n' || c === '\r') {
        if (cell || row.length) {
          row.push(cell)
          out.push(row)
          row = []
          cell = ''
        }
        if (c === '\r' && text[i + 1] === '\n') i++
      } else cell += c
    }
  }
  if (cell || row.length) {
    row.push(cell)
    out.push(row)
  }
  if (out.length === 0) return { headers: [], rows: [] }
  return { headers: out[0], rows: out.slice(1).filter((r) => r.some((c) => c.trim())) }
}

// ---------- Public API ----------
export type IngestResult = {
  filesProcessed: number
  newTransactions: number
  duplicatesDropped: number
  perFile: { file: string; bank: string; parsed: number; new: number }[]
}

export async function ingestCsvFolder(
  db: BetterSQLite3Database<typeof schema>,
  inboxDir: string,
  archiveDir = join(inboxDir, '..', 'archive'),
  accountHint?: (file: string) => string,
  rules: { pattern: string; category: string; subcategory?: string | null }[] = []
): Promise<IngestResult> {
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  const files = readdirSync(inboxDir).filter((f) => f.toLowerCase().endsWith('.csv'))
  const result: IngestResult = {
    filesProcessed: 0,
    newTransactions: 0,
    duplicatesDropped: 0,
    perFile: []
  }

  // Prefetch existing hashes for fast dedupe
  const existingHashes = new Set(
    db
      .select({ h: schema.financeTransactions.hash })
      .from(schema.financeTransactions)
      .all()
      .map((r) => r.h)
  )

  for (const f of files) {
    const fp = join(inboxDir, f)
    const { headers, rows } = readCsv(fp)
    const hLower = headers.map((c) => c.trim().toLowerCase())
    const parser = PARSERS.find((p) => p.matches(hLower)) || generic
    const hint =
      accountHint?.(f) ??
      f
        .replace(/[\d_\-]+\.csv$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim()
    const parsed = parser.parse(headers, rows, f, hint)
    const txns = rules.length ? categorize(parsed, rules) : parsed
    const fresh = txns.filter((t) => !existingHashes.has(t.hash))

    for (const t of fresh) {
      db.insert(schema.financeTransactions)
        .values({
          hash: t.hash,
          date: t.date,
          amount: t.amount,
          description: t.description,
          accountId: null,
          category: t.category ?? 'Uncategorized',
          subcategory: t.subcategory,
          notes: t.notes,
          sourceFile: t.sourceFile,
          ingestedAt: new Date()
        })
        .onConflictDoNothing()
        .run()
      existingHashes.add(t.hash)
    }

    renameSync(fp, join(archiveDir, f))
    result.filesProcessed++
    result.newTransactions += fresh.length
    result.duplicatesDropped += txns.length - fresh.length
    result.perFile.push({ file: f, bank: parser.name, parsed: txns.length, new: fresh.length })
  }
  return result
}

// Categorizer — apply rules to a freshly-parsed batch.
export function categorize(
  txns: RawTxn[],
  rules: { pattern: string; category: string; subcategory?: string | null }[]
): RawTxn[] {
  const sorted = [...rules].sort((a, b) => (a.pattern.length < b.pattern.length ? 1 : -1))
  return txns.map((t) => {
    const desc = t.description.toLowerCase()
    const hit = sorted.find((r) => desc.includes(r.pattern.toLowerCase()))
    if (hit) return { ...t, category: hit.category, subcategory: hit.subcategory ?? undefined }
    return { ...t, category: 'Uncategorized' }
  })
}

// =====================================================================
// Source-of-truth folder support
// =====================================================================
// Unlike `ingestCsvFolder` (which drains an inbox and archives processed
// files), the functions below let users point at a folder they own and
// keep — e.g. `~/Documents/Money/`. Files are read in place; dedupe by
// transaction hash makes re-processing the same file a safe no-op, so
// chokidar can fire on every save without corruption.

import ExcelJS from 'exceljs'

export type DetectedAccount = {
  name: string // e.g. "USAA Checking", "Amex Platinum (****81003)"
  type: 'checking' | 'savings' | 'credit' | 'investment'
  institution: string // "USAA", "American Express"
  lastFour?: string // when statement reveals it
  isDebt: boolean // credit cards = true
  sourceFile: string
}

export type ParsedFile = {
  bank: string
  txns: RawTxn[]
  account?: DetectedAccount
}

/**
 * Return the immediate parent directory name when `filePath` is nested inside
 * `watchRoot`. Returns `undefined` when the file is a direct child of the root
 * (no useful subdirectory signal) or when `watchRoot` is not provided.
 *
 * Exported so tests can exercise it directly.
 *
 * Example:
 *   getAccountHintFromPath('/Money/USAA/stmt.csv', '/Money') → 'USAA'
 *   getAccountHintFromPath('/Money/stmt.csv',      '/Money') → undefined
 */
export function getAccountHintFromPath(filePath: string, watchRoot: string): string | undefined {
  if (!watchRoot.trim()) return undefined

  const root = resolve(watchRoot)
  const absoluteFilePath = resolve(filePath)
  const relativeFilePath = relative(root, absoluteFilePath)

  // Reject files outside root and cross-volume Windows paths.
  if (
    relativeFilePath === '' ||
    relativeFilePath === '.' ||
    relativeFilePath.startsWith('..') ||
    isAbsolute(relativeFilePath)
  ) {
    return undefined
  }

  const parentWithinRoot = dirname(relativeFilePath)
  // Direct child of root has no useful subdirectory signal.
  if (parentWithinRoot === '.') return undefined

  // The immediate parent name is the directory the file lives in.
  return basename(parentWithinRoot) || undefined
}

/** Known institution patterns for directory-name matching. */
const DIR_INSTITUTION_HINTS: Array<{
  patterns: RegExp
  build: (dirName: string) => DetectedAccount
}> = [
  {
    patterns: /\busaa\b/i,
    build: (dirName) => ({
      name: /checking/i.test(dirName)
        ? 'USAA Checking'
        : /savings/i.test(dirName)
          ? 'USAA Savings'
          : 'USAA',
      type: /savings/i.test(dirName) ? 'savings' : 'checking',
      institution: 'USAA',
      isDebt: false,
      sourceFile: ''
    })
  },
  {
    patterns: /\bamex\b|american\s*express/i,
    build: (dirName) => {
      let displayName = 'American Express'
      if (/platinum/i.test(dirName)) displayName = 'Amex Platinum'
      else if (/gold/i.test(dirName)) displayName = 'Amex Gold'
      else if (/green/i.test(dirName)) displayName = 'Amex Green'
      else if (/blue/i.test(dirName)) displayName = 'Amex Blue'
      return {
        name: displayName,
        type: 'credit',
        institution: 'American Express',
        isDebt: true,
        sourceFile: ''
      }
    }
  },
  {
    patterns: /\bchase\b/i,
    build: () => ({
      name: 'Chase',
      type: 'credit',
      institution: 'Chase',
      isDebt: true,
      sourceFile: ''
    })
  },
  {
    patterns: /\bbofa\b|bank\s*of\s*america\b/i,
    build: () => ({
      name: 'Bank of America',
      type: 'checking',
      institution: 'Bank of America',
      isDebt: false,
      sourceFile: ''
    })
  },
  {
    patterns: /\bcapital\s*one\b/i,
    build: () => ({
      name: 'Capital One',
      type: 'credit',
      institution: 'Capital One',
      isDebt: true,
      sourceFile: ''
    })
  },
  {
    patterns: /\bdiscover\b/i,
    build: () => ({
      name: 'Discover',
      type: 'credit',
      institution: 'Discover',
      isDebt: true,
      sourceFile: ''
    })
  },
  {
    patterns: /\bciti\b|citibank\b/i,
    build: () => ({
      name: 'Citi',
      type: 'credit',
      institution: 'Citi',
      isDebt: true,
      sourceFile: ''
    })
  }
]

/** Generic noise words that should NOT be treated as institution signals. */
const DIR_NOISE_RE =
  /^(\d{4}|statements?|documents?|files?|data|archive|exports?|downloads?|misc|other|new)$/i

/**
 * Try to match a directory name against known institution patterns.
 * Returns a partial DetectedAccount template (sourceFile is filled in by caller)
 * or undefined if no strong signal found.
 */
function accountFromDirName(dirName: string): Omit<DetectedAccount, 'sourceFile'> | undefined {
  if (!dirName || DIR_NOISE_RE.test(dirName.trim())) return undefined

  for (const hint of DIR_INSTITUTION_HINTS) {
    if (hint.patterns.test(dirName)) {
      const { sourceFile: _sf, ...partial } = hint.build(dirName)
      return partial
    }
  }
  return undefined
}

/**
 * Infer an account hint and metadata from the filename and (if xlsx)
 * the file's header rows. When the filename alone doesn't match a known
 * institution, falls back to the immediate parent directory name (when
 * `watchRoot` is provided and the file is nested under it).
 *
 * Best-effort — returns undefined if we can't confidently tell what the
 * account is.
 */
function detectAccount(
  file: string,
  peek?: { acctNumber?: string },
  watchRoot?: string
): DetectedAccount | undefined {
  const name = basename(file).toLowerCase()
  const acctNumber = peek?.acctNumber
  // USAA: USAA_Checking_2026_bk_download.csv / USAA_Savings_*.csv
  if (name.includes('usaa')) {
    if (name.includes('checking')) {
      return {
        name: 'USAA Checking',
        type: 'checking',
        institution: 'USAA',
        isDebt: false,
        sourceFile: basename(file)
      }
    }
    if (name.includes('savings')) {
      return {
        name: 'USAA Savings',
        type: 'savings',
        institution: 'USAA',
        isDebt: false,
        sourceFile: basename(file)
      }
    }
  }
  // AMEX: detect from peek (xlsx header cells or PDF text) for the last 4 of card
  if (name.includes('amex') || name.includes('american') || acctNumber) {
    const lastFour = acctNumber?.match(/(\d{4,5})\s*$/)?.[1]
    let displayName = 'American Express'
    if (name.includes('platinum')) displayName = 'Amex Platinum'
    else if (name.includes('gold')) displayName = 'Amex Gold'
    else if (name.includes('green')) displayName = 'Amex Green'
    else if (name.includes('blue')) displayName = 'Amex Blue'
    if (lastFour) displayName += ` (****${lastFour})`
    return {
      name: displayName,
      type: 'credit',
      institution: 'American Express',
      lastFour,
      isDebt: true,
      sourceFile: basename(file)
    }
  }

  // Fall back to parent directory name when filename alone has no signal
  if (watchRoot) {
    const dirName = getAccountHintFromPath(file, watchRoot)
    if (dirName) {
      const fromDir = accountFromDirName(dirName)
      if (fromDir) {
        return { ...fromDir, sourceFile: basename(file) }
      }
    }
  }

  return undefined
}

/**
 * Parse an AMEX exported xlsx with the standard "Transaction Details"
 * sheet (columns: Date, Description, Amount, ...). Header row is at index 6.
 */
async function parseAmexXlsx(filePath: string, watchRoot?: string): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.getWorksheet('Transaction Details') ?? wb.worksheets[0]
  if (!ws) return { bank: 'Amex (xlsx)', txns: [] }

  // Find the account number from rows 1-6 (cell containing "XXXX-XXXXXX-")
  let acctNumber: string | undefined
  for (let r = 1; r <= 6; r++) {
    const row = ws.getRow(r)
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = String(cell.value ?? '')
      if (/^X{2,}.*\d{3,5}$/.test(v)) acctNumber = v
    })
    if (acctNumber) break
  }
  const account = detectAccount(filePath, { acctNumber }, watchRoot)
  const accountName = account?.name ?? 'Amex'

  // Detect the header row by scanning for one that contains 'Date' and 'Amount'
  let headerRowIdx = -1
  for (let r = 1; r <= 12 && headerRowIdx === -1; r++) {
    const cells = ws.getRow(r).values as (string | undefined | null)[]
    const lower = cells.map((c) => String(c ?? '').toLowerCase())
    if (lower.includes('date') && lower.includes('amount')) headerRowIdx = r
  }
  if (headerRowIdx === -1) return { bank: 'Amex (xlsx)', txns: [], account }

  const headerCells = ws.getRow(headerRowIdx).values as (string | undefined | null)[]
  const headers = headerCells.map((c) =>
    String(c ?? '')
      .trim()
      .toLowerCase()
  )
  const dI = headers.indexOf('date')
  const descI = headers.indexOf('description')
  const aI = headers.indexOf('amount')
  const catI = headers.indexOf('category')
  if (dI === -1 || descI === -1 || aI === -1) return { bank: 'Amex (xlsx)', txns: [], account }

  const txns: RawTxn[] = []
  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const cells = ws.getRow(r).values as (string | number | Date | undefined | null)[]
    const rawDate = cells[dI]
    const rawDesc = cells[descI]
    const rawAmt = cells[aI]
    if (rawDate == null || rawDesc == null || rawAmt == null) continue
    try {
      let dateStr: string
      if (rawDate instanceof Date) {
        dateStr = `${rawDate.getFullYear()}-${String(rawDate.getMonth() + 1).padStart(2, '0')}-${String(rawDate.getDate()).padStart(2, '0')}`
      } else {
        dateStr = parseDate(String(rawDate))
      }
      const amount = -parseMoney(String(rawAmt)) // AMEX export: positive = charge → make negative
      const description = String(rawDesc).trim()
      const category = catI !== -1 ? String(cells[catI] ?? '').trim() || undefined : undefined
      txns.push({
        date: dateStr,
        amount,
        description,
        account: accountName,
        category,
        sourceFile: basename(filePath),
        hash: hashTxn(dateStr, amount, description, accountName)
      })
    } catch {
      // skip unparseable rows (subtotal lines, blanks, etc.)
    }
  }
  return { bank: 'Amex (xlsx)', txns, account }
}

/**
 * Parse a single CSV file using the existing parser pipeline.
 */
function parseCsvFile(filePath: string, watchRoot?: string): ParsedFile {
  const { headers, rows } = readCsv(filePath)
  const hLower = headers.map((c) => c.trim().toLowerCase())
  const parser = PARSERS.find((p) => p.matches(hLower)) || generic
  const account = detectAccount(filePath, undefined, watchRoot)
  const hint =
    account?.name ??
    basename(filePath, '.csv')
      .replace(/[\d_\-]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim()
  const txns = parser.parse(headers, rows, basename(filePath), hint)
  return { bank: parser.name, txns, account }
}

/**
 * Build a filename-only account hint that PDF extractors can use as a
 * starting display name. Best-effort — extractors may override with a
 * better name discovered in the PDF text.
 */
function pdfAccountHint(filePath: string): string {
  // `parse().name` strips the extension regardless of case (.pdf or .PDF).
  const stem = parse(filePath).name
  // Strip trailing month/date noise like "Statement_April_2026" → "Statement"
  return stem
    .replace(
      /[-_]?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[_\-\s\d]*$/i,
      ''
    )
    .replace(/[\d_\-\s]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/**
 * Dispatch on extension. Returns parsed transactions + best-effort account
 * detection. Pure: no DB writes, no file moves.
 *
 * Pass `watchRoot` when the file lives inside a user-owned folder so that
 * parent-directory names can be used as institution hints when the filename
 * alone is ambiguous.
 */
export async function parseFinanceFile(
  filePath: string,
  watchRoot?: string
): Promise<ParsedFile | null> {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.csv')) return parseCsvFile(filePath, watchRoot)
  if (lower.endsWith('.xlsx')) return parseAmexXlsx(filePath, watchRoot)
  if (lower.endsWith('.pdf')) {
    // Lazy import keeps `pdf-parse`/pdfjs-dist out of any code path that
    // doesn't need it.
    const { parsePdfFile } = await import('./finance-pdf')
    return parsePdfFile(filePath, pdfAccountHint(filePath))
  }
  return null
}

/**
 * Ingest one or more files into the DB. Idempotent (dedupes by hash).
 * Does NOT move/delete the source files — designed for a folder the
 * user owns (e.g. ~/Documents/Money). Auto-creates a `financeAccounts`
 * row for any newly-detected account.
 */
export async function ingestFinanceFiles(
  db: BetterSQLite3Database<typeof schema>,
  filePaths: string[],
  rules: { pattern: string; category: string; subcategory?: string | null }[] = [],
  watchRoot?: string
): Promise<{
  result: IngestResult
  detectedAccounts: (DetectedAccount & { dbId: number })[]
}> {
  const result: IngestResult = {
    filesProcessed: 0,
    newTransactions: 0,
    duplicatesDropped: 0,
    perFile: []
  }

  // Prefetch existing accounts (lightweight, needed for cross-file account dedup)
  const existingAccounts = db.select().from(schema.financeAccounts).all()
  const accountIdByName = new Map(existingAccounts.map((a) => [a.name, a.id]))
  const detected: (DetectedAccount & { dbId: number })[] = []

  for (const fp of filePaths) {
    const parsed = await parseFinanceFile(fp, watchRoot)
    if (!parsed) continue
    const { bank, txns, account } = parsed
    const f = basename(fp)

    // Auto-create the account if we detected one and it doesn't exist yet
    let accountDbId: number | null = null
    if (account) {
      let id = accountIdByName.get(account.name)
      if (id === undefined) {
        const inserted = db
          .insert(schema.financeAccounts)
          .values({
            name: account.name,
            type: account.type,
            institution: account.institution,
            isDebt: account.isDebt,
            balance: 0,
            apr: 0,
            minPayment: 0,
            creditLimit: null
          } as typeof schema.financeAccounts.$inferInsert)
          .returning({ id: schema.financeAccounts.id })
          .get()
        id = inserted?.id
        if (id !== undefined) {
          accountIdByName.set(account.name, id)
          detected.push({ ...account, dbId: id })
        }
      }
      accountDbId = id ?? null
    }

    const categorized = rules.length ? categorize(txns, rules) : txns

    // Scope hash lookup to only this batch's candidates — avoids full-table scan
    const candidateHashes = categorized.map((t) => t.hash)
    const existingInBatch =
      candidateHashes.length > 0
        ? new Set(
            db
              .select({ h: schema.financeTransactions.hash })
              .from(schema.financeTransactions)
              .where(inArray(schema.financeTransactions.hash, candidateHashes))
              .all()
              .map((r) => r.h)
          )
        : new Set<string>()
    const fresh = categorized.filter((t) => !existingInBatch.has(t.hash))

    for (const t of fresh) {
      db.insert(schema.financeTransactions)
        .values({
          hash: t.hash,
          date: t.date,
          amount: t.amount,
          description: t.description,
          accountId: accountDbId,
          category: t.category ?? 'Uncategorized',
          subcategory: t.subcategory,
          notes: t.notes,
          sourceFile: t.sourceFile,
          ingestedAt: new Date()
        })
        .onConflictDoNothing()
        .run()
    }

    result.filesProcessed++
    result.newTransactions += fresh.length
    result.duplicatesDropped += categorized.length - fresh.length
    result.perFile.push({ file: f, bank, parsed: categorized.length, new: fresh.length })
  }

  return { result, detectedAccounts: detected }
}
