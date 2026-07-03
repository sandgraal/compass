/**
 * PDF ingestion (Phase 10.2/10.5 — "The Acquisition Engine", RIGHTS mode).
 *
 * The 5th ingestion shape: a dropped PDF is text-extracted (main-process only,
 * via `pdf-parse`) and routed through PDF recognizers. This is the gateway to the
 * legally-owed disclosures that arrive as PDFs — credit reports first, then tax /
 * medical / government letters.
 *
 * PRIVACY: the tax / SSA / generic recognizers stay a content-light INDEX — they
 * capture high-level facts (form · year, title · date) and never persist the
 * document text, which holds SSNs / wages / earnings.
 *
 * The CREDIT recognizer is the deliberate, user-opted exception: to power the
 * Credit hub (utilization, per-card health, improvement tips) it DOES store the
 * financial data points — creditor, balances, limits, account type, dates, masked
 * last-4, payment status — as structured `records`. It still NEVER stores the
 * identity block: the parser slices out the entire "Personal Information" section
 * (name, SSN, DOB, former addresses/phones) and the FCRA-rights boilerplate BEFORE
 * any field extraction, and reduces the account number to its trailing ≤4 digits.
 * All of it stays on-device. If the block splitter finds no tradelines/inquiries
 * (an unsampled bureau layout) it falls back to the legacy one-record summary.
 */

import { readFileSync } from 'node:fs'
import { parseWhen } from './dates'
import type { PdfRecognizer, RecordInput } from './recognizers'

/** Extract plain text from a PDF (main process). Strips pdf-parse's "-- N of M --" page markers. */
export async function extractPdfText(path: string): Promise<{ text: string; pages: number }> {
  // Dynamic import keeps pdf-parse (and the heavy pdfjs-dist) lazy + out of the
  // renderer bundle — it loads only when a PDF is actually dropped (matches
  // electron/integrations/finance-pdf.ts).
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(readFileSync(path)) })
  try {
    // getText() already returns the page count via `total`, so no second getInfo
    // pass is needed (and `pages` isn't even consumed in production — the
    // round-trip test asserts pages === 1).
    const r = await parser.getText()
    const text = (r.text ?? '')
      .replace(/^-- \d+ of \d+ --$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { text, pages: r.total ?? 0 }
  } finally {
    await parser.destroy()
  }
}

const BUREAU = /\b(equifax|experian|transunion)\b/i
const SCORE = /\b(?:fico|vantage(?:score)?|credit)\s*score\b[^\d]{0,15}(\d{3})\b/i
const ANY_DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8} \d{1,2},? \d{4})\b/

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/** The report's own date (prefer a labelled date, else the first date in the text). */
function reportDate(text: string): number | null {
  const labelled = text.match(
    /(?:report date|date generated|prepared(?: on)?|as of)[:\s]*([A-Z][a-z]{2,8} \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i
  )
  if (labelled) return parseWhen(labelled[1])
  const any = text.match(ANY_DATE)
  return any ? parseWhen(any[1]) : null
}

// ── Credit report structured parsing ─────────────────────────────────────────
// Validated against a real Equifax "Annual Credit Report" (annualcreditreport.com)
// as linearized by pdf-parse: several `Label: value` pairs are packed per physical
// line and a value runs until the NEXT label, a `|`, or the line end.

export type CreditPaymentLates = {
  late30: number
  late60: number
  late90: number
  late120: number
  late150: number
  late180: number
}

export type ParsedCreditTradeline = {
  creditor: string
  accountLast4: string | null
  accountType: string | null
  owner: string | null
  status: string | null
  closed: boolean
  balance: number | null
  creditLimit: number | null
  highCredit: number | null
  scheduledPayment: number | null
  actualPayment: number | null
  amountPastDue: number | null
  dateOpened: string | null
  dateReported: string | null
  dateOfLastActivity: string | null
  dateOfLastPayment: string | null
  dateClosed: string | null
  monthsReviewed: number | null
  termMonths: number | null
  utilization: number | null
  paymentHistory: CreditPaymentLates
}

export type ParsedCreditInquiry = {
  company: string
  inquiryType: string
  inquiryDate: string
}

// Every labeled field that can appear inside a tradeline block. A value is
// terminated by the next label in this set (with its colon), so e.g.
// "Owner: Individual Account Credit Limit:" yields owner = "Individual Account".
const TRADELINE_LABELS = [
  'Date Reported',
  'Balance',
  'Account Number',
  'Owner',
  'Credit Limit',
  'High Credit',
  'Loan/Account Type',
  'Status',
  'Date Opened',
  'Date of 1st Delinquency',
  'Terms Frequency',
  'Date of Last Activity',
  'Date Major Delinquency 1st Reported',
  'Months Reviewed',
  'Scheduled Payment Amount',
  'Amount Past Due',
  'Deferred Payment Start Date',
  'Actual Payment Amount',
  'Charge Off Amount',
  'Balloon Payment Amount',
  'Date of Last Payment',
  'Date Closed',
  'Balloon Payment Date',
  'Term Duration',
  'Activity Designator',
  'Narrative Code(s)'
]

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LABEL_ALT = TRADELINE_LABELS.map(reEsc).join('|')

/** Read one labeled field from a tradeline block; '' when absent or empty. */
function field(block: string, label: string): string {
  const re = new RegExp(`${reEsc(label)}:\\s*(.*?)\\s*(?=\\||\\n|$|(?:${LABEL_ALT}):)`, 'i')
  return block.match(re)?.[1]?.trim() ?? ''
}

/** Money/number cell: strips `$ , %`, `(123)` → -123; '' / '-' → null. */
function money(s: string | undefined): number | null {
  if (s == null) return null
  let t = s.trim()
  if (!t || t === '-' || t === 'N/A' || t === '--') return null
  const neg = t.startsWith('(') && t.endsWith(')')
  if (neg) t = t.slice(1, -1)
  t = t.replace(/[$,%\s]/g, '')
  if (!t) return null
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function toYmd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Text between the first `startRe` match and the following `endRe` (or end). */
function sliceBetween(text: string, startRe: RegExp, endRe: RegExp): string {
  const s = text.search(startRe)
  if (s === -1) return ''
  const rest = text.slice(s)
  const e = rest.search(endRe)
  return e === -1 ? rest : rest.slice(0, e)
}

const isAddressish = (line: string): boolean =>
  /\bPO Box\b|\b[A-Z]{2}\s+\d{5}(-\d{4})?\b|\|\s*\(\d{3}\)/.test(line)

const isRevolving = (type: string | null): boolean => /credit card|charge/i.test(type ?? '')

/** Count delinquency marks in the payment-history grid (between the month header
 *  and the legend). Years are 4-digit; marks are standalone 30/60/90/120/150/180. */
function latesFromGrid(block: string): CreditPaymentLates {
  const out: CreditPaymentLates = {
    late30: 0,
    late60: 0,
    late90: 0,
    late120: 0,
    late150: 0,
    late180: 0
  }
  const start = block.search(/Year\s+Jan\b/i)
  if (start === -1) return out
  const rest = block.slice(start)
  const end = rest.search(/Paid on Time/i)
  const grid = end === -1 ? rest : rest.slice(0, end)
  for (const m of grid.matchAll(/\b(30|60|90|120|150|180)\b/g)) {
    out[`late${m[1]}` as keyof CreditPaymentLates]++
  }
  return out
}

/** Split the Credit Accounts section into tradelines. Each account has exactly
 *  one "Date Reported:" with its creditor on the preceding line. */
export function parseCreditTradelines(accountsText: string): ParsedCreditTradeline[] {
  const lines = accountsText.split('\n')
  const drIdx: number[] = []
  lines.forEach((ln, i) => {
    if (/Date Reported:/i.test(ln)) drIdx.push(i)
  })

  const out: ParsedCreditTradeline[] = []
  for (let k = 0; k < drIdx.length; k++) {
    const L = drIdx[k]
    let credLine = (lines[L - 1] ?? '').trim()
    if (isAddressish(credLine) && lines[L - 2]) credLine = lines[L - 2].trim()
    const headerClosed = /\s-\s*closed\s*$/i.test(credLine)
    const creditor = credLine.replace(/\s-\s*closed\s*$/i, '').trim()
    if (!creditor) continue

    const blockEnd = k + 1 < drIdx.length ? drIdx[k + 1] - 1 : lines.length
    const block = lines.slice(L, blockEnd).join('\n')

    const accountType = field(block, 'Loan/Account Type') || null
    const status = field(block, 'Status') || null
    const activityDesignator = field(block, 'Activity Designator')
    const dateClosed = field(block, 'Date Closed') || null
    const closed =
      headerClosed ||
      !!dateClosed ||
      /closed|transferred|paid and closed/i.test(status ?? '') ||
      /closed/i.test(activityDesignator)

    const balance = money(field(block, 'Balance'))
    const creditLimit = money(field(block, 'Credit Limit'))
    const acctRaw = field(block, 'Account Number')
    const acctDigits = (acctRaw.match(/\d/g) ?? []).join('')
    const accountLast4 = acctDigits ? acctDigits.slice(-4) : null
    const termM = field(block, 'Term Duration').match(/(\d+)\s*months?/i)
    const termMonths = termM ? Number(termM[1]) : null
    const monthsRaw = field(block, 'Months Reviewed')
    const monthsReviewed = /^\d+$/.test(monthsRaw) ? Number(monthsRaw) : null
    const utilization =
      isRevolving(accountType) && creditLimit != null && creditLimit > 0 && balance != null
        ? round4(balance / creditLimit)
        : null

    out.push({
      creditor,
      accountLast4,
      accountType,
      owner: field(block, 'Owner') || null,
      status,
      closed,
      balance,
      creditLimit,
      highCredit: money(field(block, 'High Credit')),
      scheduledPayment: money(field(block, 'Scheduled Payment Amount')),
      actualPayment: money(field(block, 'Actual Payment Amount')),
      amountPastDue: money(field(block, 'Amount Past Due')),
      dateOpened: field(block, 'Date Opened') || null,
      dateReported: field(block, 'Date Reported') || null,
      dateOfLastActivity: field(block, 'Date of Last Activity') || null,
      dateOfLastPayment: field(block, 'Date of Last Payment') || null,
      dateClosed,
      monthsReviewed,
      termMonths,
      utilization,
      paymentHistory: latesFromGrid(block)
    })
  }
  return out
}

/** Parse the Inquiries section: company then (skipping address/phone) a
 *  "Hard|Soft MM/DD/YYYY" line. */
export function parseCreditInquiries(inqText: string): ParsedCreditInquiry[] {
  const lines = inqText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const headerIdx = lines.findIndex((l) => /Company Information\s+Inquiry Type/i.test(l))
  const out: ParsedCreditInquiry[] = []
  const typeDate = /\b(Hard|Soft)\b\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
  let i = headerIdx === -1 ? 0 : headerIdx + 1
  while (i < lines.length) {
    const company = lines[i]
    i++
    let hit: RegExpMatchArray | null = null
    while (i < lines.length) {
      const m = lines[i].match(typeDate)
      if (m) {
        hit = m
        break
      }
      i++
    }
    if (!hit) break
    out.push({ company, inquiryType: titleCase(hit[1]), inquiryDate: hit[2] })
    i++
  }
  return out
}

// ── TransUnion / Experian layouts ────────────────────────────────────────────
// Both bureaus use tab-delimited `Label \t value` fields (very different from
// Equifax's label-packed lines), so each gets its own splitter. Validated
// against real annualcreditreport.com PDFs as linearized by pdf-parse.

/** Read a `Label \t value` field (TransUnion / Experian). '' when absent. */
function tabField(block: string, label: string): string {
  const re = new RegExp(`^${reEsc(label)}\\s*\\t\\s*(.+)$`, 'im')
  return block.match(re)?.[1]?.trim() ?? ''
}

/**
 * Real last-4 of an account number — ONLY when the last four are digits. Experian
 * prints the full number (→ genuine last-4); TransUnion masks the last four with
 * `****` (→ no real last-4, return null). Never stores more than four digits.
 */
function last4(raw: string): string | null {
  const t = raw.trim()
  if (/[*xX]{2,}\s*$/.test(t)) return null // trailing digits are masked
  const digits = (t.match(/\d/g) ?? []).join('')
  return digits.length >= 4 ? digits.slice(-4) : null
}

function emptyLates(): CreditPaymentLates {
  return { late30: 0, late60: 0, late90: 0, late120: 0, late150: 0, late180: 0 }
}

function addLate(out: CreditPaymentLates, bucket: string, n: number): void {
  const k = `late${bucket}` as keyof CreditPaymentLates
  if (k in out) out[k] += n
}

/** Experian delinquency rollup: "N days past due as of Mon YYYY[,Mon YYYY]". */
function latesFromDaysPastDue(block: string): CreditPaymentLates {
  const out = emptyLates()
  for (const m of block.matchAll(/(\d+)\s+days?\s+past due as of\s+([^\n]+)/gi)) {
    const dates = m[2].split(',').filter((s) => /\d{4}/.test(s)).length || 1
    addLate(out, m[1], dates)
  }
  return out
}

/** TransUnion delinquency rollup: standalone 30/60/90/120 rating lines inside the
 *  month-by-month "Payment History" grid (values are "OK" or a bucket number). */
function latesFromRatingGrid(block: string): CreditPaymentLates {
  const out = emptyLates()
  const start = block.search(/Payment History/i)
  const region = start === -1 ? block : block.slice(start)
  for (const m of region.matchAll(/^\s*(30|60|90|120|150|180)\s*$/gm)) addLate(out, m[1], 1)
  return out
}

const isTuNoise = (l: string): boolean =>
  /View Credit Report|annualcreditreport|^\d+\/\d+$|^Address\b|^Phone\b|Satisfactory Accounts|Payment History|following accounts|^Account Information$|^Rating$|Total Months|days late|^Report/i.test(
    l
  )

/**
 * Experian tradelines — one block per " Account Info" header; tab-delimited
 * fields incl. a direct Balance. NOTE: Experian prints the FULL account number,
 * so only the derived last-4 is ever stored (never the raw value).
 */
export function parseExperianTradelines(text: string): ParsedCreditTradeline[] {
  const lines = text.split('\n')
  const idx: number[] = []
  // Each block header is a private-use glyph + " Account Info" — anchor on the
  // trailing text ("Account Information" ends in "rmation", so it won't match).
  lines.forEach((ln, i) => {
    if (/Account Info$/.test(ln.trimEnd())) idx.push(i)
  })
  const hardIdx = lines.findIndex((ln) => /^Hard Inquiries\s*$/.test(ln))
  const out: ParsedCreditTradeline[] = []
  for (let k = 0; k < idx.length; k++) {
    let end = k + 1 < idx.length ? idx[k + 1] : lines.length
    if (hardIdx !== -1 && idx[k] < hardIdx && hardIdx < end) end = hardIdx
    const block = lines.slice(idx[k], end).join('\n')
    const creditor = tabField(block, 'Account Name')
    if (!creditor) continue
    const status = tabField(block, 'Status') || null
    const accountType = tabField(block, 'Account Type') || null
    const balance = money(tabField(block, 'Balance'))
    const creditLimit = money(tabField(block, 'Credit Limit'))
    const closed = /closed/i.test(status ?? '')
    const utilization =
      isRevolving(accountType) && creditLimit != null && creditLimit > 0 && balance != null
        ? round4(balance / creditLimit)
        : null
    out.push({
      creditor,
      accountLast4: last4(tabField(block, 'Account Number')),
      accountType,
      owner: tabField(block, 'Responsibility') || null,
      status,
      closed,
      balance,
      creditLimit,
      highCredit: money(tabField(block, 'High Balance')),
      scheduledPayment: money(tabField(block, 'Monthly Payment')),
      actualPayment: money(tabField(block, 'Recent Payment')),
      amountPastDue: null,
      dateOpened: tabField(block, 'Date Opened') || null,
      dateReported: tabField(block, 'Balance Updated') || null,
      dateOfLastActivity: null,
      dateOfLastPayment: null,
      dateClosed: null,
      monthsReviewed: null,
      termMonths: null,
      utilization,
      paymentHistory: latesFromDaysPastDue(block)
    })
  }
  return out
}

/** Experian inquiries — "Hard Inquiries" / "Soft Inquiries" sections; each entry
 *  is a creditor name followed by "Inquired on <date>". */
export function parseExperianInquiries(text: string): ParsedCreditInquiry[] {
  const out: ParsedCreditInquiry[] = []
  const sections: Array<[string, string]> = [
    [sliceBetween(text, /^Hard Inquiries\s*$/m, /^Soft Inquiries\s*$/m), 'Hard'],
    [
      sliceBetween(
        text,
        /^Soft Inquiries\s*$/m,
        /^(?:Creditor Contacts|Account Information Key)\s*$/m
      ),
      'Soft'
    ]
  ]
  for (const [seg, type] of sections) {
    if (!seg) continue
    const lines = seg.split('\n').map((l) => l.trim())
    for (let i = 0; i < lines.length; i++) {
      if (!/^Inquired on/i.test(lines[i])) continue
      let company = ''
      for (let j = i - 1; j >= 0; j--) {
        const L = lines[j]
        // A creditor name: uppercase-ish, ≥3 letters, no embedded ZIP/address.
        if (
          L &&
          !isAddressish(L) &&
          !/\d{5}/.test(L) &&
          /^[A-Z0-9][A-Z0-9 .,&'/-]{2,}$/.test(L) &&
          /[A-Z]{3}/.test(L)
        ) {
          company = L
          break
        }
      }
      let date = lines[i].match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? ''
      for (let j = i + 1; !date && j < Math.min(i + 4, lines.length); j++) {
        date = lines[j].match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? ''
      }
      if (company && date) out.push({ company, inquiryType: type, inquiryDate: date })
    }
  }
  return out
}

/**
 * TransUnion tradelines. Anchored on the masked account-number line (exactly one
 * per account, e.g. `349993331594****`) — the reliable per-account boundary;
 * "Account Information" is NOT it, because pdf-parse scatters that header relative
 * to the fields. The creditor prefixes the masked number (adverse accounts) or is
 * the line just above it. Balance comes from the payment-history table (no
 * standalone field). Inquiries are intentionally NOT parsed: TransUnion's
 * linearization splits inquiry names into a separate column from their dates, so
 * pairing them reliably isn't possible.
 */
export function parseTransUnionTradelines(text: string): ParsedCreditTradeline[] {
  const lines = text.split('\n')
  const MASK = /\d{4,}[\d*]*\*{2,}\s*$/
  const idx: number[] = []
  lines.forEach((ln, i) => {
    if (MASK.test(ln.trim())) idx.push(i)
  })
  const out: ParsedCreditTradeline[] = []
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k]
    // Creditor: the text prefixing the masked number, else the nearest real line
    // above it (skipping page/section noise and number-only lines).
    let creditor = lines[start].trim().replace(MASK, '').trim()
    if (!creditor) {
      for (let j = start - 1; j >= Math.max(0, start - 4); j--) {
        const C = lines[j].trim()
        if (C && !isTuNoise(C) && !/^[\d*xX\s]+$/.test(C) && /[A-Za-z]/.test(C)) {
          creditor = C
          break
        }
      }
    }
    if (!creditor) continue
    // Block = this account's masked-number line up to the next account's — its
    // fields + payment history. (The next account's creditor line at the tail
    // carries no labels, so it doesn't contaminate field extraction.)
    const end = k + 1 < idx.length ? idx[k + 1] : lines.length
    const block = lines.slice(start, end).join('\n')
    const status = tabField(block, 'Pay Status') || null
    const accountType = tabField(block, 'Loan Type') || tabField(block, 'Account Type') || null
    const dateClosed = tabField(block, 'Date Closed') || null
    const closed = !!dateClosed || /closed|paid|transferred/i.test(status ?? '')
    const creditLimit = money(tabField(block, 'Credit Limit'))
    // Balance is intentionally NOT taken from TransUnion: it only lives in the
    // monthly payment-history table, which pdf-parse's column scatter does not
    // keep bracketed to the right account (a closed $0 card picks up a
    // neighbor's balance). Limit/type/status/lates DO stay with the account.
    out.push({
      creditor,
      accountLast4: null, // TransUnion masks the last four digits
      accountType,
      owner: tabField(block, 'Responsibility') || null,
      status,
      closed,
      balance: null,
      creditLimit,
      highCredit: money(tabField(block, 'High Balance')),
      scheduledPayment: null,
      actualPayment: null,
      amountPastDue: null,
      dateOpened: tabField(block, 'Date Opened') || null,
      dateReported: tabField(block, 'Date Updated') || null,
      dateOfLastActivity: null,
      dateOfLastPayment:
        tabField(block, 'Last Payment Made') || tabField(block, 'Date Paid') || null,
      dateClosed,
      monthsReviewed: null,
      termMonths: null,
      utilization: null,
      paymentHistory: latesFromRatingGrid(block)
    })
  }
  return out
}

/** Report-level rollups from the Summary block (labels carry no colon). */
function parseSummaryRollups(seg: string): {
  avgAccountAgeMonths: number | null
  creditHistoryMonths: number | null
  oldestAccountName: string | null
  oldestAccountOpened: string | null
} {
  const ageM = seg.match(/Average Account Age\s+(\d+)\s*Years?,?\s*(\d+)\s*Months?/i)
  const histM = seg.match(/Length of Credit History\s+(\d+)\s*Years?,?\s*(\d+)\s*Months?/i)
  const oldest = seg.match(/Oldest Account\s+(.+?)\s*\|\s*([A-Za-z]+ \d{4})/i)
  return {
    avgAccountAgeMonths: ageM ? Number(ageM[1]) * 12 + Number(ageM[2]) : null,
    creditHistoryMonths: histM ? Number(histM[1]) * 12 + Number(histM[2]) : null,
    oldestAccountName: oldest ? oldest[1].trim() : null,
    oldestAccountOpened: oldest ? oldest[2].trim() : null
  }
}

/**
 * Consumer credit report. Detect by the report/bureau signature, then extract the
 * summary + one record per tradeline + one per inquiry. Falls back to a single
 * summary record when structured parsing finds nothing (unsampled bureau layout).
 */
export const CREDIT_REPORT_RECOGNIZER: PdfRecognizer = {
  id: 'credit-report',
  label: 'Credit report (PDF)',
  detect: (text) => {
    const t = text.toLowerCase()
    return (
      /credit report|credit file/.test(t) || (BUREAU.test(t) && /score|tradeline|inquir/.test(t))
    )
  },
  parse: (text, name) => {
    // Proper-cased bureau (also the dispatch key), so each bureau's very different
    // layout gets its own splitter.
    const bureau = /transunion/i.test(text)
      ? 'TransUnion'
      : /experian/i.test(text)
        ? 'Experian'
        : /equifax/i.test(text)
          ? 'Equifax'
          : (text.match(BUREAU)?.[1] && titleCase(text.match(BUREAU)?.[1] ?? '')) || ''
    const s = text.match(SCORE)
    const score = s && Number(s[1]) >= 300 && Number(s[1]) <= 900 ? s[1] : ''
    const when = reportDate(text)
    // Stable ISO grouping key shared by every record in this report, so the
    // aggregator can MAX() over snapshots chronologically. Undated → filename.
    const reportYmd = when != null ? toYmd(when) : name

    const summaryRecord: RecordInput = {
      source: 'credit-report',
      type: 'credit-report',
      occurredAt: when,
      title: bureau ? `Credit report — ${bureau}` : 'Credit report',
      body: [bureau, score ? `score ${score}` : ''].filter(Boolean).join(' · ') || undefined,
      payload: { bureau, score: score || null, reportDate: reportYmd, file: name },
      naturalKey: when != null ? `${bureau || name}|${when}` : `${bureau || name}|${name}|${score}`
    }

    // Dispatch to the bureau's parser. Equifax slices its two data sections
    // (which structurally excludes the Personal-Information block and the
    // FCRA-rights boilerplate); TransUnion / Experian parse from the full text
    // but only lift specific labeled fields, never the identity block.
    let tradelines: ParsedCreditTradeline[]
    let inquiries: ParsedCreditInquiry[]
    if (bureau === 'TransUnion') {
      tradelines = parseTransUnionTradelines(text)
      inquiries = [] // names decoupled from dates in TransUnion's linearization
    } else if (bureau === 'Experian') {
      tradelines = parseExperianTradelines(text)
      inquiries = parseExperianInquiries(text)
    } else {
      const accountsText = sliceBetween(
        text,
        /\bCredit Accounts\b/,
        /A request for your credit history/i
      )
      const inqText = sliceBetween(
        text,
        /Company Information\s+Inquiry Type/i,
        /A Summary of (?:Your )?Rights|Para información/i
      )
      tradelines = accountsText ? parseCreditTradelines(accountsText) : []
      inquiries = inqText ? parseCreditInquiries(inqText) : []
    }
    const summaryText = sliceBetween(text, /\bSummary\b/i, /Personal Information/i) || text

    // No structured data (unknown layout) → legacy behavior, never a regression.
    if (tradelines.length === 0 && inquiries.length === 0) return [summaryRecord]

    const roll = parseSummaryRollups(summaryText)
    const openCount = tradelines.filter((t) => !t.closed).length
    const closedCount = tradelines.length - openCount
    const hardInquiries = inquiries.filter((q) => /hard/i.test(q.inquiryType)).length
    const softInquiries = inquiries.length - hardInquiries

    summaryRecord.body =
      [bureau, score ? `score ${score}` : `${openCount} open · ${closedCount} closed`]
        .filter(Boolean)
        .join(' · ') || undefined
    summaryRecord.payload = {
      bureau,
      score: score || null,
      reportDate: reportYmd,
      tradelineCount: tradelines.length,
      openCount,
      closedCount,
      hardInquiries,
      softInquiries,
      ...roll,
      file: name
    }

    const records: RecordInput[] = [summaryRecord]

    for (const t of tradelines) {
      const occurredAt = parseWhen(t.dateOpened ?? '') ?? parseWhen(t.dateReported ?? '') ?? when
      records.push({
        source: 'credit-report',
        type: 'credit-tradeline',
        occurredAt,
        title: `${t.creditor}${t.closed ? ' — Closed' : ''}`,
        body:
          [
            t.accountType,
            t.balance != null ? `bal $${t.balance.toLocaleString('en-US')}` : '',
            t.creditLimit != null ? `limit $${t.creditLimit.toLocaleString('en-US')}` : ''
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        payload: { ...t, bureau, reportDate: reportYmd, file: name },
        // reportDate keeps each report a fresh snapshot (trend); C/O keeps an
        // open→closed transition distinct.
        naturalKey: `${bureau}|${t.creditor}|${t.accountLast4 ?? ''}|${t.dateOpened ?? ''}|${t.closed ? 'C' : 'O'}|${reportYmd}`
      })
    }

    for (const q of inquiries) {
      records.push({
        source: 'credit-report',
        type: 'credit-inquiry',
        occurredAt: parseWhen(q.inquiryDate),
        title: `${q.company} inquiry`,
        body: `${q.inquiryType} · ${bureau}`.trim(),
        payload: { ...q, bureau, reportDate: reportYmd, file: name },
        // A fixed historical event — omit reportDate so the same inquiry seen in
        // two reports dedupes to one row.
        naturalKey: `${bureau}|inquiry|${q.company}|${q.inquiryDate}`
      })
    }

    return records
  }
}

const TAX_FORM =
  /\b(w-2|1099-[a-z]{1,4}|1099|1098|1040(?:-[a-z]{1,3})?|tax return transcript|wage and income transcript|wage and tax statement)\b/i
// Stronger detection: a definitive tax marker (Form-prefixed number, hyphenated
// W-2 / 1099 code, transcript name, or explicit IRS / "Tax Year YYYY") — so a bare
// "1099" invoice line next to a "Sales tax" total isn't claimed as a tax document.
const TAX_SIGNATURE =
  /\b(?:form\s+(?:w-2|1099(?:-[a-z]{1,4})?|1040(?:-[a-z]{1,3})?)|w-2|1099-[a-z]{1,4}|wage and tax statement|tax return transcript|wage and income transcript|internal revenue service|irs|tax year\s*:?\s*20\d{2})\b/i
// Labelled tax year. Includes transcript wording ("Tax Period Ending: … 2023") so a
// transcript's earlier request-date year doesn't win via the bare-year fallback.
const TAX_YEAR_LABELLED =
  /\b(?:tax year|tax period(?: ending)?|for(?: the)?(?: tax)? year)\b[^\n]{0,40}?(20\d{2})\b/i

/** Normalize the matched tax-form marker to a display label (W-2, 1099-INT, transcript names). */
function taxForm(text: string): string {
  const m = text.match(TAX_FORM)
  if (!m) return ''
  const f = m[1].toLowerCase()
  if (f === 'wage and tax statement') return 'W-2'
  if (f.includes('income transcript')) return 'Wage & Income Transcript'
  if (f.includes('return transcript')) return 'Tax Return Transcript'
  return m[1].toUpperCase()
}

/** Tax documents (W-2 / 1099 / 1040 / IRS transcripts) — index by form + tax year only. */
export const TAX_DOC_RECOGNIZER: PdfRecognizer = {
  id: 'tax-document',
  label: 'Tax document (PDF)',
  detect: (text) => TAX_SIGNATURE.test(text),
  parse: (text, name) => {
    const form = taxForm(text)
    const year = text.match(TAX_YEAR_LABELLED)?.[1] ?? text.match(/\b20\d{2}\b/)?.[0] ?? ''
    const label = [form, year].filter(Boolean).join(' ')
    return [
      {
        source: 'tax-document',
        type: 'tax-document',
        // Local midnight Dec 31 of the tax year — stable displayed day across
        // timezones (no UTC-midnight drift / spurious time on the Timeline).
        occurredAt: year ? new Date(Number(year), 11, 31).getTime() : null,
        title: label ? `Tax document — ${label}` : 'Tax document',
        body: form || undefined,
        // Content-light — form + year only, never wages / SSN / amounts.
        payload: { form: form || null, year: year || null, file: name },
        naturalKey: `${form || 'tax'}|${year}|${name}`
      }
    ]
  }
}

/**
 * SSA — the Social Security Statement (earnings record + benefit estimate). Closes
 * the loop the Concierge opens ("get your SSA statement"). Content-light: the
 * statement's earnings history / SSN are never stored, only the title + date.
 */
export const SOCIAL_SECURITY_RECOGNIZER: PdfRecognizer = {
  id: 'social-security',
  label: 'Social Security statement (PDF)',
  detect: (text) => /\bsocial security statement\b/i.test(text),
  parse: (text, name) => {
    const when = reportDate(text)
    const year =
      when != null ? String(new Date(when).getFullYear()) : (text.match(/\b20\d{2}\b/)?.[0] ?? '')
    return [
      {
        source: 'social-security',
        type: 'social-security',
        occurredAt: when,
        title: year ? `Social Security Statement ${year}` : 'Social Security Statement',
        payload: { file: name }, // content-light — no earnings / SSN
        naturalKey: when != null ? `ssa|${when}|${name}` : `ssa|${year}|${name}`
      }
    ]
  }
}

/**
 * Catch-all: any other PDF becomes one dated document index entry. Metadata ONLY
 * — the title is the user's filename and the date is extracted metadata; the
 * document's own text is never persisted (records:list returns `body` and the
 * Export Center serializes it, so a snippet of a tax/medical letter would leak).
 */
export const GENERIC_DOC_RECOGNIZER: PdfRecognizer = {
  id: 'document',
  label: 'PDF document',
  detect: () => true,
  parse: (text, name) => {
    const base = name.replace(/\.pdf$/i, '').trim()
    return [
      {
        source: 'document',
        type: 'document',
        occurredAt: reportDate(text), // a date is metadata, not document content
        title: base || 'Document', // the user's filename, never extracted text
        payload: { file: name },
        naturalKey: name
      } satisfies RecordInput
    ]
  }
}
