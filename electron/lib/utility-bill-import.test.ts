import { describe, expect, it } from 'vitest'
import { parseUtilityBillCsv, parseUtilityBillPdf } from './utility-bill-import'

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

  it('gives two bills with the same provider/date/amount/address but different periods distinct externalIds', () => {
    // Same provider, statement date, amount, and address — the only thing
    // distinguishing these two bills is the billing period, so it must be
    // in the hash or one would silently overwrite the other on upsert.
    const headers = [
      'Provider',
      'Statement Date',
      'Amount',
      'Address',
      'Period Start',
      'Period End'
    ]
    const rows = [
      ['PG&E', '2026-06-15', '100', '1 Main St', '2026-05-01', '2026-05-31'],
      ['PG&E', '2026-06-15', '100', '1 Main St', '2026-06-01', '2026-06-30']
    ]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out).toHaveLength(2)
    expect(out[0].externalId).not.toBe(out[1].externalId)
  })

  it('gives two bills with the same provider/date/amount but different usage distinct externalIds', () => {
    const headers = ['Provider', 'Statement Date', 'Amount', 'Usage (kWh)']
    const rows = [
      ['PG&E', '2026-06-15', '100', '300'],
      ['PG&E', '2026-06-15', '100', '450']
    ]
    const out = parseUtilityBillCsv(headers, rows)
    expect(out).toHaveLength(2)
    expect(out[0].externalId).not.toBe(out[1].externalId)
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

describe('parseUtilityBillPdf', () => {
  it('extracts amount + statement date from a typical bill layout', () => {
    const text = [
      'Pacific Gas and Electric Company',
      'Account Number: 1234567890',
      'Statement Date: 06/15/2026',
      'Service Period: 05/15/2026 - 06/14/2026',
      'Total Amount Due: $142.50',
      'Usage: 412 kWh'
    ].join('\n')
    const out = parseUtilityBillPdf(text, 'PGE-june-2026.pdf')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      amount: 142.5,
      statementDate: '2026-06-15',
      periodStart: '2026-05-15',
      periodEnd: '2026-06-14',
      usageKwh: 412,
      currency: 'USD'
    })
    expect(out[0].provider).toBe('PGE june 2026')
    expect(out[0].externalId).toMatch(/^manual:[0-9a-f]{16}$/)
  })

  it('matches alternate "amount due" labels', () => {
    const out = parseUtilityBillPdf('Some Utility Co\nBalance Due $88.00', 'bill.pdf')
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBe(88)
  })

  it('falls back periodEnd to statementDate when no period range is found', () => {
    const text = 'Statement Date: 2026-06-15\nAmount Due: $75.00'
    const out = parseUtilityBillPdf(text, 'bill.pdf')
    expect(out[0].periodEnd).toBe('2026-06-15')
    expect(out[0].periodStart).toBeNull()
  })

  it('returns [] when no amount-due pattern matches (unrecognized layout)', () => {
    const text = 'Some Utility Co\nThank you for your payment of $50.00 last month.'
    expect(parseUtilityBillPdf(text, 'bill.pdf')).toEqual([])
  })

  it('produces the same externalId for the same content (idempotent re-import)', () => {
    const text = 'Statement Date: 2026-06-15\nAmount Due: $75.00'
    const a = parseUtilityBillPdf(text, 'bill.pdf')
    const b = parseUtilityBillPdf(text, 'bill.pdf')
    expect(a[0].externalId).toBe(b[0].externalId)
  })

  it('serviceAddress is always null — PDFs have no dedicated address field extracted', () => {
    const text = 'Statement Date: 2026-06-15\nAmount Due: $75.00'
    expect(parseUtilityBillPdf(text, 'bill.pdf')[0].serviceAddress).toBeNull()
  })
})
