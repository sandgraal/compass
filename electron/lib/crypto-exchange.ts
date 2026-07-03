/**
 * Crypto-exchange transaction recognizers (Phase 10 — "The Acquisition Engine").
 *
 * Opens the CRYPTO domain: a dropped Coinbase "Transaction history" CSV or a
 * Kraken "Ledgers" CSV becomes one timeline record per transaction — "Buy 0.5
 * BTC · $15,000.00", dated when it happened. Your crypto activity, owned
 * forever, on the unified timeline.
 *
 * SCOPE (deliberate): these feed the TIMELINE, not Net Worth. Exchange exports
 * are transaction LOGS, not position snapshots, and valuing a reconstructed
 * balance would need a live crypto price feed Compass doesn't have (its FX
 * fetch is fiat-only). Net-worth crypto valuation is a separate future path
 * (a positions/balances export + a price source); cap-gains tagging is likewise
 * deferred — see docs/storehouse-roadmap.md.
 *
 * FORMAT CAVEAT: column layouts here are based on the documented/typical
 * Coinbase + Kraken export shapes and are UNVALIDATED against a real export —
 * same honest posture as `finance-holdings.ts`. Detection is conservative and
 * parsing is tolerant; sharpen the column names when a real export lands.
 */

import { fromHeaderRow, matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

/** Parse a number cell: strips `$ , ` and returns null when non-numeric. */
function num(s: string | undefined): number | null {
  if (s == null) return null
  const t = s.replace(/[$,\s]/g, '').trim()
  if (!t) return null
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? n : null
}

/** Trim trailing zeros from a fixed-decimal quantity for a clean title. */
function trimQty(raw: string): string {
  const n = num(raw)
  if (n == null) return raw.trim()
  // Up to 8 dp (crypto precision), then drop trailing zeros.
  return n.toFixed(8).replace(/\.?0+$/, '')
}

// ─── Coinbase ────────────────────────────────────────────────────────────────
// Transaction history export. A short human-readable preamble precedes the real
// header, so we skip to the header row keyed on its distinctive columns. The
// fiat total column has drifted across export eras ("Total (inclusive of fees…)"
// vs "USD Amount Transacted…"), so match a list of candidates.
export const COINBASE_RECOGNIZER: Recognizer = {
  id: 'coinbase',
  label: 'Coinbase transaction history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const lower = f.text.toLowerCase()
    return (
      lower.includes('transaction type') &&
      lower.includes('quantity transacted') &&
      lower.includes('asset')
    )
  },
  parse: (f) => {
    const text = fromHeaderRow(f.text, 'Transaction Type', 'Quantity Transacted')
    const rows = parseCSV(text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cTime = matchHeader(keys, 'Timestamp')
    const cType = matchHeader(keys, 'Transaction Type')
    const cAsset = matchHeader(keys, 'Asset')
    const cQty = matchHeader(keys, 'Quantity Transacted')
    const cCurrency = matchHeader(keys, 'Spot Price Currency', 'Price Currency')
    const cTotal = matchHeader(
      keys,
      'Total (inclusive of fees and/or spread)',
      'USD Amount Transacted (Inclusive of Coinbase Fees)',
      'Subtotal'
    )

    const out: RecordInput[] = []
    for (const r of rows) {
      const type = cType ? r[cType].trim() : ''
      const asset = cAsset ? r[cAsset].trim() : ''
      const qtyRaw = cQty ? r[cQty].trim() : ''
      if (!type || !asset || !qtyRaw) continue
      const qty = trimQty(qtyRaw)
      const when = parseWhen(cTime ? r[cTime] : '')
      const total = cTotal ? num(r[cTotal]) : null
      const currency = (cCurrency ? r[cCurrency].trim() : '') || 'USD'
      const body =
        total != null
          ? `${total.toLocaleString('en-US', { style: 'currency', currency: safeCurrency(currency) })}`
          : undefined
      out.push({
        source: 'coinbase',
        type: 'crypto',
        occurredAt: when,
        title: `${type} ${qty} ${asset}`,
        body,
        payload: r,
        // Coinbase's standard export has no stable per-row id, so compose one
        // from the natural fields — re-importing the same export dedupes.
        naturalKey: `${cTime ? r[cTime].trim() : ''}|${type}|${asset}|${qtyRaw}`
      })
    }
    return out
  }
}

// ─── Kraken ──────────────────────────────────────────────────────────────────
// Ledgers export. `txid` + `refid` + `aclass` (asset class) together are
// distinctive to Kraken, so detection won't collide with other exchange CSVs.
// Each ledger row carries a stable `txid` → exact dedup.
export const KRAKEN_RECOGNIZER: Recognizer = {
  id: 'kraken',
  label: 'Kraken ledger history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const header = (
      f.text.indexOf('\n') === -1 ? f.text : f.text.slice(0, f.text.indexOf('\n'))
    ).toLowerCase()
    return (
      header.includes('txid') &&
      header.includes('refid') &&
      header.includes('asset') &&
      header.includes('amount')
    )
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cTxid = matchHeader(keys, 'txid')
    const cTime = matchHeader(keys, 'time')
    const cType = matchHeader(keys, 'type')
    const cAsset = matchHeader(keys, 'asset')
    const cAmount = matchHeader(keys, 'amount')

    const out: RecordInput[] = []
    for (const r of rows) {
      const txid = cTxid ? r[cTxid].trim() : ''
      if (!txid) continue // Kraken ledger rows always carry a txid; skip malformed/blank rows
      const type = cType ? r[cType].trim() : 'ledger'
      const asset = cAsset ? r[cAsset].trim() : ''
      const amountRaw = cAmount ? r[cAmount].trim() : ''
      const amount = amountRaw ? trimQty(amountRaw) : ''
      const when = parseWhen(cTime ? r[cTime] : '')
      const label = [type, amount, asset].filter(Boolean).join(' ')
      out.push({
        source: 'kraken',
        type: 'crypto',
        occurredAt: when,
        title: label || 'Kraken ledger entry',
        payload: r,
        naturalKey: txid
      })
    }
    return out
  }
}

/** Fall back to USD if the currency cell isn't a plausible 3-letter ISO code. */
function safeCurrency(code: string): string {
  return /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : 'USD'
}
