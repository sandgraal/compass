/**
 * PDF statement parsing for the finance pipeline.
 *
 * Many banks (Chase, BofA, Citi, USAA, AMEX) only deliver statements as PDF.
 * This module extracts plain text from a PDF (via `pdf-parse`, which wraps
 * pdfjs-dist) and dispatches to a per-bank extractor that pulls transactions
 * out of the noisy whitespace.
 *
 * IMPORTANT: This module is main-process-only. It dynamically imports
 * `pdf-parse` so the renderer bundle never picks it up. Do not import this
 * file from `src/`.
 *
 * Extractor pattern mirrors the CSV `Parser` shape over in `finance.ts`:
 *   { name, matches(textLines), parse(text, file, hint): ParsedFile }
 *
 * The extractors here MUST be conservative — when a row can't be parsed
 * confidently, drop it rather than guessing. PDF text is order-sensitive
 * and bank layouts change without notice; false positives end up as wrong
 * transactions in the user's ledger.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { DetectedAccount, ParsedFile, RawTxn } from './finance'
import { hashTxn, parseDate, parseMoney } from './finance'

// ---------- Extractor type ----------

export type PdfExtractor = {
  name: string
  /** Tolerant detector — receives normalized lowercased lines from the PDF. */
  matches: (lines: string[]) => boolean
  /**
   * Parse the full PDF text into a ParsedFile. `file` is the absolute path
   * (used only for `sourceFile` basename). `hint` is the filename-derived
   * account hint passed in by the caller; extractors may override with a
   * better name discovered in the PDF text.
   */
  parse: (text: string, file: string, hint: string) => ParsedFile
}

// ---------- Helpers ----------

/**
 * Normalize PDF text into clean non-empty lines. PDFs often have lots of
 * trailing whitespace and zero-width characters from layout reflow; drop
 * those before pattern-matching.
 */
export function normalizeLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').trim())
    .filter((l) => l.length > 0)
}

/** Lowercased view of normalized lines — handy for `matches()` checks. */
function lower(lines: string[]): string[] {
  return lines.map((l) => l.toLowerCase())
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dec: '12'
}

/**
 * Try to parse a date in any of the formats statement PDFs use:
 *   - ISO YYYY-MM-DD
 *   - M/D/YYYY or MM/DD/YYYY (and 2-digit-year variants)
 *   - "Mon DD" or "Mon DD YYYY" (e.g. "Apr 03" or "Apr 03 2026")
 *
 * For yearless dates, caller can also pass `closingMonth` so statements that
 * span a year boundary (e.g. closing in January with a `12/31` row) roll back
 * into the prior year instead of blindly using the closing year.
 * Returns null on no-match.
 */
export function tryParseStatementDate(
  s: string,
  defaultYear?: number,
  closingMonth?: number
): string | null {
  const t = s.trim()
  // Try the strict CSV parsers first — they cover ISO + M/D/YYYY + 2-digit-year.
  try {
    return parseDate(t)
  } catch {
    /* fall through */
  }
  // Numeric "M/D" or "MM/DD" (no year) with a defaultYear from the
  // statement header.
  const numMD = t.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (numMD) {
    if (!defaultYear) return null
    const month = Number.parseInt(numMD[1], 10)
    const day = Number.parseInt(numMD[2], 10)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const year = closingMonth && month > closingMonth ? defaultYear - 1 : defaultYear
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  // "Mon DD" or "Mon DD, YYYY" or "Mon DD YYYY"
  const m = t.match(/^([A-Za-z]{3,4})[.\s]+(\d{1,2})(?:[,\s]+(\d{2,4}))?$/)
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()]
    if (!mon) return null
    const month = Number.parseInt(mon, 10)
    const day = m[2].padStart(2, '0')
    let year: number | undefined
    if (m[3]) {
      const y = Number.parseInt(m[3], 10)
      year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y
    } else if (defaultYear) {
      year = closingMonth && month > closingMonth ? defaultYear - 1 : defaultYear
    }
    if (!year) return null
    return `${year}-${mon}-${day}`
  }
  return null
}

/**
 * Pull a 4-or-5-digit "last N" out of strings like:
 *   "Account ending in 4321"
 *   "Account Ending NNNN-NNNNNN-31003"
 *   "ending in: 4321"
 */
function findLastFour(text: string): string | undefined {
  const m =
    text.match(/account\s+ending(?:\s+in)?\s*[:#-]?\s*[\dx*-]*?(\d{4,5})\b/i) ??
    text.match(/ending\s+in\s*[:#-]?\s*(\d{4,5})\b/i) ??
    text.match(/x{2,}[\d-]*?(\d{4,5})\b/i)
  return m?.[1]
}

/**
 * Pull a four-digit year out of "Statement Period: 04/15/2026 - 05/14/2026" or
 * "Closing Date: 05/14/2026" style lines. Used to disambiguate Mon-DD dates.
 */
function findStatementDateContext(lines: string[]): {
  defaultYear?: number
  closingMonth?: number
} {
  const headerSlice = lines.slice(0, 60).join(' ')
  // Prefer "closing date" since that matches the statement period for the
  // majority of transactions on the page.
  const closing = headerSlice.match(/closing\s+date[:\s-]+(\d{1,2})\/\d{1,2}\/(\d{2,4})/i)
  if (closing) {
    const month = Number.parseInt(closing[1], 10)
    const y = Number.parseInt(closing[2], 10)
    return {
      defaultYear: y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y,
      closingMonth: month
    }
  }
  const period = headerSlice.match(
    /\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–]\s*(\d{1,2})\/\d{1,2}\/(\d{2,4})/
  )
  if (period) {
    const month = Number.parseInt(period[1], 10)
    const y = Number.parseInt(period[2], 10)
    return {
      defaultYear: y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y,
      closingMonth: month
    }
  }
  // Fallback: any 4-digit year
  const year = headerSlice.match(/\b(20\d{2})\b/)
  if (year) return { defaultYear: Number.parseInt(year[1], 10) }
  return {}
}

// ---------- Extractor: USAA ----------

/**
 * USAA credit-card statements. Detection: header text contains "USAA" plus
 * either "Statement" or "Account Summary" plus a transactions block.
 *
 * Transaction lines on USAA statements look like (after PDF text extraction):
 *   "04/03  04/04  CITY OF AUSTIN UTILITY AUSTIN TX  142.87"
 * (post / trans dates, description, amount). We use the first M/D as the
 * transaction date and require both a date and a trailing decimal amount.
 */
export const usaaPdf: PdfExtractor = {
  name: 'USAA (PDF)',
  matches: (lines) => {
    const lo = lower(lines).slice(0, 80).join(' ')
    return lo.includes('usaa') && (lo.includes('statement') || lo.includes('account summary'))
  },
  parse: (text, file, hint) => {
    const lines = normalizeLines(text)
    const { defaultYear, closingMonth } = findStatementDateContext(lines)
    const lastFour = findLastFour(lines.slice(0, 80).join(' '))
    const accountName = lastFour ? `${hint || 'USAA'} (****${lastFour})` : hint || 'USAA'

    const account: DetectedAccount = {
      name: accountName,
      type: 'credit',
      institution: 'USAA',
      lastFour,
      isDebt: true,
      sourceFile: basename(file)
    }

    // Pattern: <M/D or MM/DD>  [<M/D or MM/DD>]  <description...>  <amount>
    // The leading date is the transaction date. A second date (post date) may
    // precede the description. Amount can be signed with parens, $, '-', or a
    // trailing '-' (e.g. "500.00-" = credit/payment on USAA statements).
    const txnLine =
      /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+)?(.+?)\s+(-?\$?[\d,]+\.\d{2}-?|\([\d,]+\.\d{2}\))\s*$/

    const txns: RawTxn[] = []
    let inSection = false
    for (const raw of lines) {
      const lo = raw.toLowerCase()
      // Section delimiters in USAA statements: "Transactions" / "Payments and
      // Credits" headers turn parsing on; totals/summary turn it off.
      if (
        lo.startsWith('transactions') ||
        lo === 'payments and credits' ||
        lo.startsWith('payments, credits and adjustments')
      ) {
        inSection = true
        continue
      }
      if (
        lo.startsWith('total fees') ||
        lo.startsWith('total interest') ||
        lo.startsWith('fees charged') ||
        lo.startsWith('interest charged') ||
        lo.startsWith('account summary')
      ) {
        inSection = false
        continue
      }
      if (!inSection) continue

      const m = raw.match(txnLine)
      if (!m) continue

      const [, dateStr, descRaw, amtRaw] = m
      const date = tryParseStatementDate(dateStr, defaultYear, closingMonth)
      if (!date) continue
      let amount: number
      try {
        amount = parseMoney(amtRaw)
      } catch {
        continue
      }
      // USAA presents charges as positive on the statement; flip to expense-negative.
      // Lines explicitly tagged in a "Payments and Credits" block are already
      // reductions — but the trailing "-" or parens already encodes that, so
      // we just always flip and let the sign in the captured amount drive the
      // direction.
      amount = -amount
      const description = descRaw.replace(/\s{2,}/g, ' ').trim()
      if (!description) continue
      txns.push({
        date,
        amount,
        description,
        account: accountName,
        sourceFile: basename(file),
        notes: 'PDF-parsed — verify amount sign',
        hash: hashTxn(date, amount, description, accountName)
      })
    }

    return { bank: 'USAA (PDF)', txns, account }
  }
}

// ---------- Extractor: AMEX ----------

/**
 * AMEX credit card statements. AMEX PDFs include "Account Ending" plus
 * "American Express" branding. Transaction layout is one of:
 *   "04/03/26*  CITY OF AUSTIN UTILITY AUSTIN TX           $142.87"
 *   "04/03/26   PAYMENT - THANK YOU                       -$1,200.00"
 * (date with two-digit year, then description, then $-prefixed signed amount).
 */
export const amexPdf: PdfExtractor = {
  name: 'AMEX (PDF)',
  matches: (lines) => {
    const lo = lower(lines).slice(0, 80).join(' ')
    return (
      (lo.includes('american express') || lo.includes('amex')) &&
      (lo.includes('account ending') || lo.includes('account number'))
    )
  },
  parse: (text, file, hint) => {
    const lines = normalizeLines(text)
    const headerJoined = lines.slice(0, 80).join(' ')
    const { defaultYear, closingMonth } = findStatementDateContext(lines)
    const lastFive =
      headerJoined.match(/account\s+ending\s+[\dx*-]*?(\d{5})\b/i)?.[1] ??
      findLastFour(headerJoined)

    // Pick a sensible display name from the hint, otherwise 'American Express'.
    let baseName = 'American Express'
    const lh = (hint || '').toLowerCase()
    if (lh.includes('platinum')) baseName = 'Amex Platinum'
    else if (lh.includes('gold')) baseName = 'Amex Gold'
    else if (lh.includes('green')) baseName = 'Amex Green'
    else if (lh.includes('blue')) baseName = 'Amex Blue'
    const accountName = lastFive ? `${baseName} (****${lastFive})` : baseName
    const account: DetectedAccount = {
      name: accountName,
      type: 'credit',
      institution: 'American Express',
      lastFour: lastFive,
      isDebt: true,
      sourceFile: basename(file)
    }

    // M/D/YY or M/D/YYYY at line start, then description, then $-amount with
    // optional leading "-" and optional trailing "*" markers AMEX uses for
    // foreign txns.
    const txnLine =
      /^(\d{1,2}\/\d{1,2}\/\d{2,4})\*?\s+(.+?)\s+(-?\$[\d,]+\.\d{2}|\(\$?[\d,]+\.\d{2}\))\s*$/

    const txns: RawTxn[] = []
    for (const raw of lines) {
      const m = raw.match(txnLine)
      if (!m) continue
      const [, dateStr, descRaw, amtRaw] = m
      const date = tryParseStatementDate(dateStr, defaultYear, closingMonth)
      if (!date) continue
      let amount: number
      try {
        amount = parseMoney(amtRaw)
      } catch {
        continue
      }
      // AMEX: positive on statement = charge → flip to negative
      amount = -amount
      const description = descRaw.replace(/\s{2,}/g, ' ').trim()
      if (!description) continue
      txns.push({
        date,
        amount,
        description,
        account: accountName,
        sourceFile: basename(file),
        notes: 'PDF-parsed — verify amount sign',
        hash: hashTxn(date, amount, description, accountName)
      })
    }

    return { bank: 'AMEX (PDF)', txns, account }
  }
}

// ---------- Extractor: Generic (fallback) ----------

/**
 * Last-resort regex pass. Looks for any line shaped like:
 *   <date> <description> <amount>
 * with date in ISO / M/D/YYYY / "Mon DD" form and amount as a signed decimal.
 *
 * Conservative on purpose: if fewer than 2 plausible transactions are found,
 * returns empty to avoid writing junk data. "Mon DD" dates require a
 * statement-year anchor; ISO and slash-delimited dates are parsed without one.
 */
export const genericPdf: PdfExtractor = {
  name: 'Generic (PDF)',
  matches: () => true,
  parse: (text, file, hint) => {
    const lines = normalizeLines(text)
    const { defaultYear, closingMonth } = findStatementDateContext(lines)
    const accountName = hint || basename(file, '.pdf')

    // ISO date OR M/D[/YY]] OR "Mon DD[ YYYY]" — captured as a single chunk.
    const dateChunk =
      '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|[A-Za-z]{3,4}\\.?\\s+\\d{1,2}(?:[,\\s]+\\d{2,4})?)'
    // Trailing '-' (e.g. "500.00-") is a credit indicator used by some banks.
    const amtChunk = '(-?\\$?[\\d,]+\\.\\d{2}-?|\\(\\$?[\\d,]+\\.\\d{2}\\))'
    const re = new RegExp(`^${dateChunk}\\s+(.+?)\\s+${amtChunk}\\s*$`)

    const txns: RawTxn[] = []
    for (const raw of lines) {
      const m = raw.match(re)
      if (!m) continue
      const [, dateStr, descRaw, amtRaw] = m
      const date = tryParseStatementDate(dateStr, defaultYear, closingMonth)
      if (!date) continue
      let amount: number
      try {
        amount = parseMoney(amtRaw)
      } catch {
        continue
      }
      const description = descRaw.replace(/\s{2,}/g, ' ').trim()
      // Reject suspicious "balance"/"total"/"summary" lines that often have
      // matching shape but aren't transactions.
      const dLo = description.toLowerCase()
      if (
        dLo.startsWith('total ') ||
        dLo.startsWith('subtotal') ||
        dLo.startsWith('balance ') ||
        dLo === 'balance' ||
        dLo.includes('previous balance') ||
        dLo.includes('new balance') ||
        dLo.includes('minimum payment') ||
        dLo.includes('credit limit')
      ) {
        continue
      }
      if (!description) continue
      txns.push({
        date,
        amount,
        description,
        account: accountName,
        sourceFile: basename(file),
        notes: 'Generic-PDF-parsed — verify amount sign',
        hash: hashTxn(date, amount, description, accountName)
      })
    }

    // Confidence floor: if the generic pass found <2 plausible txns, treat
    // the file as unparseable rather than risking junk data.
    if (txns.length < 2) return { bank: 'Generic (PDF)', txns: [] }

    const account: DetectedAccount | undefined = hint
      ? {
          name: accountName,
          type: 'credit',
          institution: hint,
          isDebt: true,
          sourceFile: basename(file)
        }
      : undefined

    return { bank: 'Generic (PDF)', txns, account }
  }
}

// ---------- Public API ----------

const PDF_EXTRACTORS: PdfExtractor[] = [usaaPdf, amexPdf, genericPdf]

/**
 * Parse already-extracted PDF text. Exposed separately so unit tests can
 * exercise the extractors against fixture text without needing a real PDF
 * binary.
 */
export function parsePdfText(text: string, file: string, hint = ''): ParsedFile {
  const lines = normalizeLines(text)
  const extractor = PDF_EXTRACTORS.find((p) => p.matches(lines)) ?? genericPdf
  return extractor.parse(text, file, hint)
}

/**
 * Read a PDF off disk, extract text via pdf-parse (pdfjs under the hood),
 * and dispatch to the right extractor. Returns null if the PDF can't be
 * read or contains no extractable text (e.g. scanned image PDFs without OCR).
 */
export async function parsePdfFile(filePath: string, hint = ''): Promise<ParsedFile | null> {
  // Dynamic import keeps `pdf-parse` (and pdfjs-dist) out of the renderer
  // bundle and out of any module that imports `finance.ts` for type-only
  // reasons.
  const { PDFParse } = await import('pdf-parse')
  let text: string
  try {
    const data = readFileSync(filePath)
    const parser = new PDFParse({ data: new Uint8Array(data) })
    try {
      const result = await parser.getText()
      text = result.text || ''
    } finally {
      await parser.destroy()
    }
  } catch (err) {
    console.error('[finance-pdf] failed to extract text:', filePath, (err as Error).message)
    return null
  }
  if (!text.trim()) return null
  return parsePdfText(text, filePath, hint)
}
