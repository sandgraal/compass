/**
 * PayPal transaction-history recognizer (Phase 10 — "The Acquisition Engine").
 *
 * Advances the financial-footprint domain WITHOUT the PDF/credit-report blocker:
 * a dropped PayPal activity/statement CSV becomes one timeline record per
 * transaction ("Jane Doe — -25.00 USD · Money Sent"). This is money the bank
 * ledger can't see cleanly — P2P transfers and online purchases that Plaid /
 * SimpleFIN only surface as opaque "PAYPAL *MERCHANT" lumps — so it complements,
 * not duplicates, the finance sync.
 *
 * Detection keys on PayPal's distinctive header trio (Transaction ID + Type +
 * Currency), so it claims PayPal exports without grabbing Amazon's order CSV or a
 * generic dated CSV. Content-light: counterparty, type, signed amount, date — the
 * full row is kept in `payload`. Dedup is exact: PayPal's Transaction ID is unique.
 */

import { matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

/**
 * PayPal's double-entry "plumbing" rows — funding legs, auth holds, FX-conversion
 * pairs, and PayPal-Credit (BML) transfers — that MIRROR each real transaction. One
 * ~$184 purchase yields up to 5 rows (a pending `General Authorization` + a Completed
 * copy, the real `Express Checkout Payment`, a `Bank Deposit to PP Account` funding
 * leg, …). Skipping these keeps one clean record per real transaction; the full row
 * still lives in the kept record's `payload`.
 */
const PAYPAL_PLUMBING =
  /Bank Deposit to PP Account|General Card Deposit|Account Hold for Open Authorization|Reversal of General Account Hold|General Authorization|Void of Authorization|General Currency Conversion|Transfer (from|to) BML|Buyer Credit Payment/i

/** Format a PayPal money column (bare signed number + separate Currency col) for the body. */
function formatAmount(raw: string, currency: string): string | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t.replace(/,/g, '')) // PayPal uses thousands separators in some locales
  if (Number.isNaN(n)) return undefined
  const amt = n.toFixed(2) // keeps the sign: -25.00 (sent) vs 25.00 (received)
  return currency ? `${amt} ${currency}` : amt
}

export const PAYPAL_RECOGNIZER: Recognizer = {
  id: 'paypal',
  label: 'PayPal transaction history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const header = f.text.slice(
      0,
      f.text.indexOf('\n') === -1 ? f.text.length : f.text.indexOf('\n')
    )
    return /transaction id/i.test(header) && /\btype\b/i.test(header) && /currency/i.test(header)
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cDate = matchHeader(keys, 'Date')
    const cName = matchHeader(keys, 'Name')
    const cType = matchHeader(keys, 'Type')
    const cCurrency = matchHeader(keys, 'Currency')
    const cAmount = matchHeader(keys, 'Gross', 'Net', 'Amount') // statement → activity column names
    const cTxnId = matchHeader(keys, 'Transaction ID')
    const cItem = matchHeader(keys, 'Item Title')

    const out: RecordInput[] = []
    for (const r of rows) {
      const txnId = cTxnId ? r[cTxnId].trim() : ''
      const name = cName ? r[cName].trim() : ''
      const amountRaw = cAmount ? r[cAmount].trim() : ''
      // Skip blank/footer rows AND zero-movement rows (e.g. "Invoice Received", whose
      // real payment is a separate row).
      if (!amountRaw) continue
      const date = cDate ? r[cDate] : ''
      const type = cType ? r[cType].trim() : ''
      if (PAYPAL_PLUMBING.test(type)) continue // drop internal accounting legs
      const currency = cCurrency ? r[cCurrency].trim() : ''
      const item = cItem ? r[cItem].trim() : ''
      const money = formatAmount(amountRaw, currency)
      out.push({
        source: 'paypal',
        type: 'payment',
        occurredAt: parseWhen(date),
        title: name || item || type || 'PayPal transaction',
        body: money && type ? `${money} · ${type}` : money,
        payload: r,
        // Transaction ID is PayPal's unique per-transaction key → exact dedup.
        naturalKey: txnId || `${date}|${name}|${amountRaw}`
      })
    }
    return out
  }
}
