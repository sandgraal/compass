/**
 * Manual utility-bill import — CSV or PDF (Phase 10 — "The Acquisition Engine").
 *
 * A stand-in for Arcadia (Phase 10.9) while the managed relay isn't deployed
 * (`docs/architecture.md` §10.9): the same `utility_bills` table and
 * `finance-property.ts` Schedule E rollup, fed by a manually downloaded
 * utility-provider bill instead of a live Arcadia sync. Most utilities hand
 * out a PDF statement, not a CSV — `parseUtilityBillPdf` covers that path;
 * `parseUtilityBillCsv` stays for the (rarer) provider that offers a CSV/data
 * export. Both are best-effort — no single "utility bill" layout exists
 * across providers — and unvalidated against a wide sample; sharpen the
 * patterns as real bills land, same caveat `finance-holdings.ts` carries for
 * brokerage CSVs.
 */

import { createHash } from 'node:crypto'
import type { UtilityBillRow } from '../integrations/arcadia'
import { parseWhen } from './dates'

const COLS = {
  provider: ['provider', 'utility', 'utility provider', 'company', 'account name'],
  serviceAddress: ['service address', 'address', 'property address', 'service location'],
  statementDate: ['statement date', 'bill date', 'invoice date', 'date'],
  periodStart: ['period start', 'service start', 'start date', 'billing period start'],
  periodEnd: ['period end', 'service end', 'end date', 'billing period end'],
  amount: ['amount due', 'total due', 'amount', 'total', 'bill amount'],
  usageKwh: ['usage (kwh)', 'usage', 'kwh', 'total usage']
}

function findCol(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.indexOf(c)
    if (i !== -1) return i
  }
  for (const c of candidates) {
    const i = headers.findIndex((h) => h.includes(c))
    if (i !== -1) return i
  }
  return -1
}

function str(s: string | undefined): string | null {
  const t = s?.trim()
  return t ? t : null
}

function money(s: string | undefined): number | null {
  const t = s?.trim()
  if (!t) return null
  const n = Number.parseFloat(t.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.abs(n) : null
}

/** A day-only date if the cell parses, else null (matches arcadia.ts's `day()`). */
function day(s: string | undefined): string | null {
  const t = s?.trim()
  if (!t) return null
  // Preserve ISO date-only strings as-written to avoid timezone day-boundary shifts.
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const ms = parseWhen(t)
  if (ms == null) return t.length >= 10 ? t.slice(0, 10) : null
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Content-addressed `externalId` so re-importing the same bill is idempotent
 * (the same contract Arcadia's `externalId` gives live syncs). Every field
 * that can distinguish two bills goes in — provider/date/amount alone can
 * collide (e.g. two same-day statements with no address/period), which would
 * upsert one bill over the other.
 */
function externalIdFor(row: Omit<UtilityBillRow, 'externalId' | 'currency'>): string {
  const { provider, serviceAddress, statementDate, periodStart, periodEnd, amount, usageKwh } = row
  return `manual:${createHash('sha256')
    .update(
      [provider, statementDate, periodStart, periodEnd, amount, usageKwh, serviceAddress]
        .map((v) => v ?? '')
        .join('|')
    )
    .digest('hex')
    .slice(0, 16)}`
}

/**
 * Parse a manually downloaded utility-bill CSV into `UtilityBillRow`s ready
 * for `upsertUtilityBills`. Returns `[]` when the file doesn't look like a
 * bill export (no amount column).
 */
export function parseUtilityBillCsv(headers: string[], rows: string[][]): UtilityBillRow[] {
  const h = headers.map((c) => c.trim().toLowerCase())
  const iAmount = findCol(h, COLS.amount)
  if (iAmount === -1) return []
  const iProvider = findCol(h, COLS.provider)
  const iAddress = findCol(h, COLS.serviceAddress)
  const iStatement = findCol(h, COLS.statementDate)
  const iStart = findCol(h, COLS.periodStart)
  const iEnd = findCol(h, COLS.periodEnd)
  const iUsage = findCol(h, COLS.usageKwh)

  const out: UtilityBillRow[] = []
  for (const r of rows) {
    const amount = money(r[iAmount])
    if (amount == null) continue
    const provider = iProvider >= 0 ? str(r[iProvider]) : null
    const serviceAddress = iAddress >= 0 ? str(r[iAddress]) : null
    const statementDate = iStatement >= 0 ? day(r[iStatement]) : null
    const periodStart = iStart >= 0 ? day(r[iStart]) : null
    const periodEnd = iEnd >= 0 ? day(r[iEnd]) : statementDate
    const usageKwh = iUsage >= 0 ? money(r[iUsage]) : null
    const base = {
      provider,
      serviceAddress,
      statementDate,
      periodStart,
      periodEnd,
      amount,
      usageKwh
    }

    out.push({ ...base, externalId: externalIdFor(base), currency: 'USD' })
  }
  return out
}

// ── PDF path ──────────────────────────────────────────────────────────────────
// Utility bill PDFs vary enormously by provider (no shared layout the way IRS/SSA
// letters have), so this is intentionally shallow: pull the total amount due (the
// one field every bill has and the only one Schedule E actually needs), a best-
// effort statement date and billing period, and fall back to the filename for the
// provider name (most people save bills as e.g. "PGE-june-2026.pdf" — more
// reliable than guessing a company name out of a letterhead block pdf-parse may
// scatter across the page).

const AMOUNT_DUE =
  /(?:total amount due|amount due|total due|balance due|new charges|current charges|total charges)[:\s]*\$?\s*([\d,]+\.\d{2})/i
const STATEMENT_DATE =
  /(?:statement date|bill date|billing date|invoice date)[:\s]*([A-Z][a-z]{2,8} \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i
const PERIOD_RANGE =
  /(?:service period|billing period|service from)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\s*(?:-|to|through)\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i
const USAGE_KWH = /([\d,]+(?:\.\d+)?)\s*kwh/i
const ANY_DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8} \d{1,2},? \d{4})\b/

function isoDay(when: number | null): string | null {
  if (when == null) return null
  const d = new Date(when)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Best-guess provider from the filename ("PGE-june-2026.pdf" -> "PGE june 2026"). */
function providerFromFilename(name: string): string | null {
  const base = name
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return base || null
}

/**
 * Parse a single downloaded utility-bill PDF (already text-extracted via
 * `extractPdfText`) into at most one `UtilityBillRow`. Returns `[]` when no
 * total-amount-due pattern matches — the most common failure mode given how
 * much bill layouts vary; the caller should surface that as "couldn't find an
 * amount" rather than a generic error.
 */
export function parseUtilityBillPdf(text: string, filename: string): UtilityBillRow[] {
  const amountMatch = text.match(AMOUNT_DUE)
  if (!amountMatch) return []
  const amount = money(amountMatch[1])
  if (amount == null) return []

  const statementDate =
    isoDay(parseWhen(text.match(STATEMENT_DATE)?.[1] ?? '')) ??
    isoDay(parseWhen(text.match(ANY_DATE)?.[1] ?? ''))
  const period = text.match(PERIOD_RANGE)
  const periodStart = period ? isoDay(parseWhen(period[1])) : null
  const periodEnd = period ? isoDay(parseWhen(period[2])) : statementDate
  const usageKwh = money(text.match(USAGE_KWH)?.[1])
  const provider = providerFromFilename(filename)
  const base = {
    provider,
    serviceAddress: null,
    statementDate,
    periodStart,
    periodEnd,
    amount,
    usageKwh
  }

  return [{ ...base, externalId: externalIdFor(base), currency: 'USD' }]
}
