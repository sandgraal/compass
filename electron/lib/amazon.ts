/**
 * Amazon order-history recognizer (Phase 10 — "The Acquisition Engine").
 *
 * Opens the commerce / financial-footprint thread: a dropped Amazon order export
 * becomes one timeline record per ordered item ("USB-C Cable 6ft — $12.99"). It's
 * the "all my old purchases" dataset almost everyone has, and a plain CSV — the
 * mature text-recognizer shape, zero new deps.
 *
 * Handles BOTH export shapes Amazon hands out:
 *  - Modern "Request My Data" → Your Orders → `Retail.OrderHistory.*.csv`
 *    (columns: Order ID, Order Date [ISO], Product Name, Total Owed, Currency, …)
 *  - Legacy "Order History Reports" → Items report
 *    (columns: Order Date [M/D/YY], Order ID, Title, Item Total [$-prefixed], …)
 *
 * Detection keys on the header signature (Order ID + Order Date + a product
 * column), so it claims Amazon exports without colliding with Netflix's
 * `Title,Date` or the generic dated-CSV catch-all. Content-light: just the item,
 * its order id, date, and price — the full row is kept in `payload`.
 */

import { matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

/** Format an Amazon money column for the record body, or undefined if absent/non-numeric. */
function formatMoney(total: string, currency: string): string | undefined {
  const t = total.trim()
  if (!t) return undefined
  // Legacy reports embed a currency symbol ("$42.00"); keep it verbatim.
  if (/[$€£¥]/.test(t)) return t
  // Modern reports give a bare number ("42.00") + a separate Currency column.
  const n = Number(t.replace(/,/g, ''))
  if (Number.isNaN(n)) return undefined // e.g. "Not Available"
  return currency ? `${n.toFixed(2)} ${currency}` : n.toFixed(2)
}

export const AMAZON_RECOGNIZER: Recognizer = {
  id: 'amazon',
  label: 'Amazon order history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const header = f.text.slice(
      0,
      f.text.indexOf('\n') === -1 ? f.text.length : f.text.indexOf('\n')
    )
    return (
      /order id/i.test(header) && /order date/i.test(header) && /(product name|title)/i.test(header)
    )
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    // Resolve columns tolerantly (case/whitespace, priority order) via the shared CSV
    // header matcher — detect() claims the file via a substring regex that tolerates
    // stray header whitespace, so the column lookup has to tolerate it too.
    const keys = Object.keys(rows[0])
    const cOrderId = matchHeader(keys, 'Order ID')
    const cDate = matchHeader(keys, 'Order Date')
    const cProduct = matchHeader(keys, 'Product Name', 'Title')
    const cTotal = matchHeader(keys, 'Total Owed', 'Item Total', 'Purchase Price Per Unit')
    const cCurrency = matchHeader(keys, 'Currency')

    const out: RecordInput[] = []
    for (const r of rows) {
      const product = cProduct ? r[cProduct].trim() : ''
      const orderId = cOrderId ? r[cOrderId].trim() : ''
      if (!product && !orderId) continue // skip footer / blank rows
      const date = cDate ? r[cDate] : ''
      const total = cTotal ? r[cTotal] : ''
      const currency = cCurrency ? r[cCurrency].trim() : ''
      out.push({
        source: 'amazon',
        type: 'order',
        occurredAt: parseWhen(date),
        title: product || `Order ${orderId}`,
        body: formatMoney(total, currency),
        payload: r,
        // One order can have several line items, so key on (order, product) — not
        // the order id alone — so re-imports dedupe per item.
        naturalKey: `${orderId || date}|${product}`
      })
    }
    return out
  }
}
