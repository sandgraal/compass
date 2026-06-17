/**
 * Venmo transaction-history recognizer (Phase 10 — "The Acquisition Engine").
 *
 * The P2P companion to PayPal: a dropped Venmo statement CSV becomes one timeline
 * record per transaction ("Dinner — - $25.00 · Jane Doe → John Smith"). More
 * money the bank ledger can't see cleanly (split bills, rent, reimbursements).
 *
 * Venmo prefixes the real CSV header with a title + "Account Activity" + summary
 * block, so detection scans the head (not just line 0) and parsing skips the
 * preamble via `fromHeaderRow`. Balance/summary rows (no ID/Datetime) are skipped.
 * Reuses the shared `matchHeader` resolver + `parseWhen`; zero new deps.
 */

import { fromHeaderRow, matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

export const VENMO_RECOGNIZER: Recognizer = {
  id: 'venmo',
  label: 'Venmo transaction history',
  // The header isn't on line 0 (preamble first), so sniff the head for Venmo's
  // distinctive `Datetime` + `Amount (total)` columns.
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const head = f.text.slice(0, 8192).toLowerCase()
    return head.includes('datetime') && head.includes('amount (total)')
  },
  parse: (f) => {
    const rows = parseCSV(fromHeaderRow(f.text, 'Datetime', 'Amount (total)'))
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cId = matchHeader(keys, 'ID')
    const cDatetime = matchHeader(keys, 'Datetime')
    const cType = matchHeader(keys, 'Type')
    const cNote = matchHeader(keys, 'Note')
    const cFrom = matchHeader(keys, 'From')
    const cTo = matchHeader(keys, 'To')
    const cAmount = matchHeader(keys, 'Amount (total)')

    const out: RecordInput[] = []
    for (const r of rows) {
      const id = cId ? r[cId].trim() : ''
      const datetime = cDatetime ? r[cDatetime].trim() : ''
      if (!id || !datetime) continue // skip the preamble + Beginning/Ending Balance rows
      const note = cNote ? r[cNote].trim() : ''
      const from = cFrom ? r[cFrom].trim() : ''
      const to = cTo ? r[cTo].trim() : ''
      const amount = cAmount ? r[cAmount].replace(/\s+/g, ' ').trim() : '' // keeps "- $25.00"
      const who = [from, to].filter(Boolean).join(' → ')
      const type = cType ? r[cType].trim() : ''
      out.push({
        source: 'venmo',
        type: 'payment',
        occurredAt: parseWhen(datetime),
        title: note || who || type || 'Venmo transaction',
        body: [amount, who].filter(Boolean).join(' · ') || undefined,
        payload: r,
        // Venmo's transaction ID is the stable per-transaction key → exact dedup.
        naturalKey: id
      })
    }
    return out
  }
}
