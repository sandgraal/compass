/**
 * CSV-based bank ingestion. TypeScript port of the Python ingest at
 * /Users/christopherennis/Documents/Claude/Projects/Getting on top of finances/08_scripts/ingest.py
 *
 * Future v2: replace the CSV parser with `electron/integrations/plaid.ts` for
 * live read-only bank data. The downstream pieces (categorizer, dedupe,
 * write-to-DB, knowledge-base markdown) stay unchanged.
 */

import { readFileSync, readdirSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

// ---------- Types ----------
export type RawTxn = {
  date: string          // ISO 'YYYY-MM-DD'
  amount: number        // negative = expense
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
const parseMoney = (s: string): number => {
  const t = s.trim().replace(/[$,]/g, '')
  if (!t) return 0
  if (t.startsWith('(') && t.endsWith(')')) return -parseFloat(t.slice(1, -1))
  return parseFloat(t)
}

const parseDate = (s: string): string => {
  const t = s.trim()
  // Try ISO, then US, then 2-digit year, then ISO with slashes, then EU
  const fmts = [
    /^(\d{4})-(\d{2})-(\d{2})$/,   // YYYY-MM-DD
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // M/D/YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, // M/D/YY
    /^(\d{4})\/(\d{2})\/(\d{2})$/,    // YYYY/MM/DD
  ]
  let m: RegExpMatchArray | null
  if ((m = t.match(fmts[0]))) return `${m[1]}-${m[2]}-${m[3]}`
  if ((m = t.match(fmts[1]))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  if ((m = t.match(fmts[2]))) {
    const yr = parseInt(m[3], 10)
    const fullYr = yr < 50 ? 2000 + yr : 1900 + yr
    return `${fullYr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  if ((m = t.match(fmts[3]))) return `${m[1]}-${m[2]}-${m[3]}`
  throw new Error(`Unrecognized date: ${s}`)
}

const hashTxn = (date: string, amount: number, desc: string, account: string): string =>
  createHash('sha1').update(`${date}|${amount.toFixed(2)}|${desc.trim().toLowerCase()}|${account}`).digest('hex').slice(0, 16)

const findIdx = (h: string[], ...names: string[]): number => {
  for (const n of names) {
    const i = h.findIndex(c => c === n || c.includes(n))
    if (i !== -1) return i
  }
  return -1
}

// ---------- Parsers ----------
const chase: Parser = {
  name: 'Chase',
  matches: (h) => (h.includes('transaction date') || h.includes('trans date')) && h.includes('post date') && h.includes('amount'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = findIdx(h, 'transaction date', 'trans date'), ai = findIdx(h, 'amount'), descI = findIdx(h, 'description')
    return rows.flatMap(r => {
      try {
        return [{
          date: parseDate(r[di]), amount: parseMoney(r[ai]),
          description: r[descI].trim(), account: hint || 'Chase',
          sourceFile: file,
          hash: hashTxn(parseDate(r[di]), parseMoney(r[ai]), r[descI], hint || 'Chase')
        }]
      } catch { return [] }
    })
  }
}

const amex: Parser = {
  name: 'Amex',
  matches: (h) => h[0] === 'date' && h[1] === 'description' && h[2] === 'amount' && !h.includes('post date'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = h.indexOf('date'), ai = h.indexOf('amount'), descI = h.indexOf('description')
    return rows.flatMap(r => {
      try {
        const amt = -parseMoney(r[ai])  // Amex: positive in export = expense; flip sign
        const date = parseDate(r[di])
        return [{
          date, amount: amt, description: r[descI].trim(), account: hint || 'Amex',
          sourceFile: file, hash: hashTxn(date, amt, r[descI], hint || 'Amex')
        }]
      } catch { return [] }
    })
  }
}

const capitalOne: Parser = {
  name: 'Capital One',
  matches: (h) => h.includes('transaction date') && h.includes('posted date') && h.includes('debit') && h.includes('credit'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = h.indexOf('transaction date'), descI = h.indexOf('description')
    const dbi = h.indexOf('debit'), ci = h.indexOf('credit')
    return rows.flatMap(r => {
      try {
        const debit = r[dbi] ? parseMoney(r[dbi]) : 0
        const credit = r[ci] ? parseMoney(r[ci]) : 0
        const amount = credit - debit
        const date = parseDate(r[di])
        return [{
          date, amount, description: r[descI].trim(), account: hint || 'Capital One',
          sourceFile: file, hash: hashTxn(date, amount, r[descI], hint || 'Capital One')
        }]
      } catch { return [] }
    })
  }
}

const discover: Parser = {
  name: 'Discover',
  matches: (h) => (h.includes('trans. date') || h.includes('trans date')) && h.includes('post date') && h.includes('category'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = findIdx(h, 'trans. date', 'trans date', 'transaction date')
    const ai = h.indexOf('amount'), descI = h.indexOf('description')
    return rows.flatMap(r => {
      try {
        const amount = -parseMoney(r[ai])
        const date = parseDate(r[di])
        return [{
          date, amount, description: r[descI].trim(), account: hint || 'Discover',
          sourceFile: file, hash: hashTxn(date, amount, r[descI], hint || 'Discover')
        }]
      } catch { return [] }
    })
  }
}

const boa: Parser = {
  name: 'Bank of America',
  matches: (h) => h.includes('running bal.') || h.includes('running bal'),
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = h.indexOf('date'), ai = h.indexOf('amount'), descI = h.indexOf('description')
    return rows.flatMap(r => {
      try {
        if (!r[0] || r[0].toLowerCase().includes('summary')) return []
        const amount = parseMoney(r[ai]), date = parseDate(r[di])
        return [{
          date, amount, description: r[descI].trim(), account: hint || 'Bank of America',
          sourceFile: file, hash: hashTxn(date, amount, r[descI], hint || 'Bank of America')
        }]
      } catch { return [] }
    })
  }
}

const generic: Parser = {
  name: 'Generic',
  matches: () => true,
  parse: (headers, rows, file, hint) => {
    const h = headers.map(c => c.trim().toLowerCase())
    const di = findIdx(h, 'transaction date', 'trans date', 'date', 'posted')
    const descI = findIdx(h, 'description', 'memo', 'narration', 'details')
    const ai = findIdx(h, 'amount', 'value')
    const dbi = findIdx(h, 'debit', 'withdrawal'), ci = findIdx(h, 'credit', 'deposit')
    if (di === -1 || descI === -1 || (ai === -1 && dbi === -1 && ci === -1)) return []
    return rows.flatMap(r => {
      try {
        let amount = 0
        if (ai !== -1) amount = parseMoney(r[ai])
        else amount = (r[ci] ? parseMoney(r[ci]) : 0) - (r[dbi] ? parseMoney(r[dbi]) : 0)
        const date = parseDate(r[di])
        return [{
          date, amount, description: r[descI].trim(),
          account: hint || basename(file, '.csv'), sourceFile: file,
          notes: 'Generic-parsed — verify amount sign',
          hash: hashTxn(date, amount, r[descI], hint || basename(file, '.csv'))
        }]
      } catch { return [] }
    })
  }
}

const PARSERS: Parser[] = [chase, capitalOne, discover, amex, boa, generic]

// ---------- CSV reader (minimal, no external dep) ----------
function readCsv(path: string): { headers: string[]; rows: string[][] } {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const out: string[][] = []
  let row: string[] = [], cell = '', inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') inQuote = false
      else cell += c
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { row.push(cell); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (cell || row.length) { row.push(cell); out.push(row); row = []; cell = '' }
        if (c === '\r' && text[i + 1] === '\n') i++
      }
      else cell += c
    }
  }
  if (cell || row.length) { row.push(cell); out.push(row) }
  if (out.length === 0) return { headers: [], rows: [] }
  return { headers: out[0], rows: out.slice(1).filter(r => r.some(c => c.trim())) }
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
  const files = readdirSync(inboxDir).filter(f => f.toLowerCase().endsWith('.csv'))
  const result: IngestResult = { filesProcessed: 0, newTransactions: 0, duplicatesDropped: 0, perFile: [] }

  // Prefetch existing hashes for fast dedupe
  const existingHashes = new Set(
    db.select({ h: schema.financeTransactions.hash }).from(schema.financeTransactions).all().map(r => r.h)
  )

  for (const f of files) {
    const fp = join(inboxDir, f)
    const { headers, rows } = readCsv(fp)
    const hLower = headers.map(c => c.trim().toLowerCase())
    const parser = PARSERS.find(p => p.matches(hLower)) || generic
    const hint = accountHint?.(f) ?? f.replace(/[\d_\-]+\.csv$/i, '').replace(/[_-]+/g, ' ').trim()
    const parsed = parser.parse(headers, rows, f, hint)
    const txns = rules.length ? categorize(parsed, rules) : parsed
    const fresh = txns.filter(t => !existingHashes.has(t.hash))

    for (const t of fresh) {
      db.insert(schema.financeTransactions).values({
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
      }).onConflictDoNothing().run()
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
  const sorted = [...rules].sort((a, b) => a.pattern.length < b.pattern.length ? 1 : -1)
  return txns.map(t => {
    const desc = t.description.toLowerCase()
    const hit = sorted.find(r => desc.includes(r.pattern.toLowerCase()))
    if (hit) return { ...t, category: hit.category, subcategory: hit.subcategory ?? undefined }
    return { ...t, category: 'Uncategorized' }
  })
}
