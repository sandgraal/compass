import { describe, expect, it } from 'vitest'
import { parseUtilityBillCsv } from './utility-bill-csv'

describe('parseUtilityBillCsv', () => {
  it('parses a standard bill export', () => {
    const headers = ['Provider', 'Service Address', 'Statement Date', 'Amount Due', 'Usage (kWh)']
    const rows = [['PG&E', '123 Main St, Oakland, CA', '2026-06-15', '$142.50', '412']]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      provider: 'PG&E',
      serviceAddress: '123 Main St, Oakland, CA',
      statementDate: '2026-06-15',
      amount: 142.5,
      currency: 'USD',
      usageKwh: 412
    })
    expect(out[0].externalId).toMatch(/^manual:[0-9a-f]{16}$/)
  })

  it('matches alternate column names', () => {
    const headers = ['Utility', 'Address', 'Bill Date', 'Total Due']
    const rows = [['Con Edison', '456 Elm St', '2026-05-01', '88.00']]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out).toHaveLength(1)
    expect(out[0].provider).toBe('Con Edison')
    expect(out[0].amount).toBe(88)
  })

  it('falls back periodEnd to statementDate when no period-end column exists', () => {
    const headers = ['Provider', 'Statement Date', 'Amount']
    const rows = [['PG&E', '2026-06-15', '100']]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out[0].periodEnd).toBe('2026-06-15')
    expect(out[0].periodStart).toBeNull()
  })

  it('produces the same externalId for the same content (idempotent re-import)', () => {
    const headers = ['Provider', 'Statement Date', 'Amount']
    const rows = [['PG&E', '2026-06-15', '100']]
    const a = parseUtilityBillCsv(headers, rows)
    const b = parseUtilityBillCsv(headers, rows)
    expect(a[0].externalId).toBe(b[0].externalId)
  })

  it('returns [] when the file has no amount column', () => {
    const headers = ['Provider', 'Statement Date']
    const rows = [['PG&E', '2026-06-15']]
    expect(parseUtilityBillCsv(headers, rows)).toEqual([])
  })

  it('skips rows with an unparseable amount', () => {
    const headers = ['Provider', 'Amount']
    const rows = [
      ['PG&E', ''],
      ['Con Edison', '50.00']
    ]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out).toHaveLength(1)
    expect(out[0].provider).toBe('Con Edison')
  })
})
