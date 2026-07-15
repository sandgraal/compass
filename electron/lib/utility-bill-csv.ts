/**
 * Manual utility-bill CSV import (Phase 10 — "The Acquisition Engine").
 *
 * A stand-in for Arcadia (Phase 10.9) while the managed relay isn't deployed
 * (`docs/architecture.md` §10.9): the same `utility_bills` table and
 * `finance-property.ts` Schedule E rollup, fed by a manually downloaded
 * utility-provider bill export instead of a live Arcadia sync. Column
 * matching is best-effort across providers (no single "utility bill CSV"
 * standard exists) and unvalidated against a real export — sharpen the
 * candidate names when one lands, same caveat `finance-holdings.ts` carries
 * for brokerage CSVs.
 */

import { createHash } from 'node:crypto'
import type { UtilityBillRow } from '../integrations/arcadia'

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
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t.length >= 10 ? t.slice(0, 10) : null
  return d.toISOString().slice(0, 10)
}

/**
 * Parse a manually downloaded utility-bill CSV into `UtilityBillRow`s ready
 * for `upsertUtilityBills`. Returns `[]` when the file doesn't look like a
 * bill export (no amount column). `externalId` is content-addressed
 * (provider+statementDate+amount+address) so re-importing the same file is
 * idempotent, the same contract Arcadia's `externalId` gives live syncs.
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
    // Every parsed field that can distinguish two bills goes in the hash —
    // provider/date/address alone can collide (e.g. two same-day statements
    // with no address column), which would upsert one bill over the other.
    const externalId = `manual:${createHash('sha256')
      .update(
        [provider, statementDate, periodStart, periodEnd, amount, usageKwh, serviceAddress]
          .map((v) => v ?? '')
          .join('|')
      )
      .digest('hex')
      .slice(0, 16)}`

    out.push({
      externalId,
      provider,
      serviceAddress,
      statementDate,
      periodStart,
      periodEnd,
      amount,
      currency: 'USD',
      usageKwh
    })
  }
  return out
}
