/**
 * Merchant-key normalizer — a byte-identical copy of `normalizeMerchant` from
 * `electron/lib/normalize.ts`. That function's output is a FROZEN CONTRACT
 * (persisted `finance_transactions.normalized_merchant`, `detected:` ids,
 * derived-entity matchKeys); this MCP package is standalone and can't import
 * electron code, so the copy lives here. Any change to the canonical file
 * must be mirrored here (and requires a data migration there anyway).
 */
export function normalizeMerchant(desc: string): string {
  let d = desc.toLowerCase().trim()
  d = d.replace(/^payment to /, '')
  d = d.replace(/^aplpay\s+/, '')
  d = d.replace(/\b\d{4,}\b/g, '') // strip transaction IDs
  d = d.replace(/\b(inc|llc|ltd|corp|co)\.?\b/g, '')
  d = d.replace(/[*#]/g, ' ')
  d = d.replace(/\b(com|net|io|co|ai)\b/g, '')
  d = d.replace(/\s+/g, ' ').trim()
  d = d.replace(/^[,.\-/]+|[,.\-/]+$/g, '').trim()
  return d.split(' ').slice(0, 4).join(' ')
}
