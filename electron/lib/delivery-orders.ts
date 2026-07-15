/**
 * Delivery order-history recognizers (Phase 10 — "The Acquisition Engine").
 *
 * A dropped DoorDash or Instacart order-history export becomes one timeline
 * record per order — mirrors `./rideshare.ts` exactly (same shape, same
 * caveat).
 *
 * FORMAT CAVEAT: neither export's column names are validated against a real
 * file — both parsers match on a list of candidate column names and detect
 * conservatively (filename hint + a couple of characteristic columns) so they
 * don't fight over a file or false-positive on an unrelated CSV. Sharpen the
 * column names when a real export lands. Rows without a usable timestamp are
 * skipped rather than dated `null`-and-buried.
 */

import { fromHeaderRow, matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

function money(s: string | undefined): { amount: number; text: string } | null {
  if (!s) return null
  const t = s.replace(/[$,\s]/g, '').trim()
  if (!t) return null
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return null
  return { amount: n, text: `$${n.toFixed(2)}` }
}

// ─── DoorDash ────────────────────────────────────────────────────────────────
export const DOORDASH_RECOGNIZER: Recognizer = {
  id: 'doordash',
  label: 'DoorDash order history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const lower = f.text.toLowerCase()
    const isDoordash = /doordash/i.test(f.name) || lower.includes('doordash')
    return isDoordash && lower.includes('restaurant') && lower.includes('total')
  },
  parse: (f) => {
    const rows = parseCSV(fromHeaderRow(f.text, 'Restaurant'))
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cOrderId = matchHeader(keys, 'Order ID', 'Order Id', 'OrderID', 'Delivery ID')
    const cWhen = matchHeader(keys, 'Delivered At', 'Order Time', 'Order Date', 'Timestamp')
    const cMerchant = matchHeader(keys, 'Restaurant', 'Store', 'Merchant Name')
    const cTotal = matchHeader(keys, 'Total', 'Order Total', 'Subtotal')

    const out: RecordInput[] = []
    for (const r of rows) {
      const when = parseWhen(cWhen ? r[cWhen] : '')
      if (when == null) continue
      const total = cTotal ? money(r[cTotal]) : null
      const merchant = cMerchant ? r[cMerchant].trim() : ''
      const orderId = cOrderId ? r[cOrderId].trim() : ''
      out.push({
        source: 'doordash',
        type: 'order',
        occurredAt: when,
        title: `DoorDash${merchant ? ` · ${merchant}` : ''}${total ? ` · ${total.text}` : ''}`,
        body: merchant || undefined,
        payload: r,
        // Prefer the order id when the export has one (stable, collision-free);
        // otherwise fall back to time+merchant+total — still imperfect for two
        // identical same-minute orders at the same restaurant, but the closest
        // available signal without one.
        naturalKey: orderId || `${cWhen ? r[cWhen].trim() : ''}|${merchant}|${total?.text ?? ''}`
      })
    }
    return out
  }
}

// ─── Instacart ───────────────────────────────────────────────────────────────
export const INSTACART_RECOGNIZER: Recognizer = {
  id: 'instacart',
  label: 'Instacart order history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const lower = f.text.toLowerCase()
    const isInstacart = /instacart/i.test(f.name) || lower.includes('instacart')
    return isInstacart && lower.includes('store') && lower.includes('total')
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cOrderId = matchHeader(keys, 'Order ID', 'Order Id', 'OrderID', 'Order Number')
    const cWhen = matchHeader(keys, 'Delivery Date', 'Order Date', 'Placed At', 'Timestamp')
    const cMerchant = matchHeader(keys, 'Store', 'Retailer', 'Merchant')
    const cTotal = matchHeader(keys, 'Total', 'Order Total', 'Grand Total')

    const out: RecordInput[] = []
    for (const r of rows) {
      const when = parseWhen(cWhen ? r[cWhen] : '')
      if (when == null) continue
      const total = cTotal ? money(r[cTotal]) : null
      const merchant = cMerchant ? r[cMerchant].trim() : ''
      const orderId = cOrderId ? r[cOrderId].trim() : ''
      out.push({
        source: 'instacart',
        type: 'order',
        occurredAt: when,
        title: `Instacart${merchant ? ` · ${merchant}` : ''}${total ? ` · ${total.text}` : ''}`,
        body: merchant || undefined,
        payload: r,
        // Prefer the order id when present (stable, collision-free); otherwise
        // fall back to time+merchant+total, same tradeoff as DoorDash above.
        naturalKey: orderId || `${cWhen ? r[cWhen].trim() : ''}|${merchant}|${total?.text ?? ''}`
      })
    }
    return out
  }
}
