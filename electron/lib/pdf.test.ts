/**
 * Tests for the PDF recognizers (Phase 10 RIGHTS mode). The recognizer logic runs
 * on extracted-text strings; `extractPdfText` is exercised against a generated PDF
 * so the real pdf-parse round-trip is covered too.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makePdf } from './__fixtures__/make-pdf'
import {
  CREDIT_REPORT_RECOGNIZER,
  SOCIAL_SECURITY_RECOGNIZER,
  TAX_DOC_RECOGNIZER,
  extractPdfText
} from './pdf'
import { recognizePdf } from './recognizers'

describe('credit-report PDF recognizer', () => {
  it('detects a credit report and summarizes bureau · score · report date', () => {
    const text = 'Experian Personal Credit Report\nReport Date: 2026-01-15\nFICO Score: 742\n…'
    expect(recognizePdf(text, 'report.pdf')?.id).toBe('credit-report') // wins over generic

    const out = CREDIT_REPORT_RECOGNIZER.parse(text, 'report.pdf')
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('credit-report')
    expect(out[0].title).toBe('Credit report — Experian')
    expect(out[0].body).toBe('Experian · score 742')
    expect(out[0].occurredAt).toBe(Date.parse('2026-01-15'))
    expect(out[0].payload).toMatchObject({ bureau: 'Experian', score: '742' })
  })

  it('does not store the raw report text (SSN/account-number safety)', () => {
    const text = 'TransUnion Credit Report\nSSN: 123-45-6789\nAccount 4111111111111111\nFICO 705'
    const out = CREDIT_REPORT_RECOGNIZER.parse(text, 'r.pdf')
    expect(JSON.stringify(out[0].payload)).not.toContain('123-45-6789')
    expect(JSON.stringify(out[0].payload)).not.toContain('4111111111111111')
  })

  it('keeps distinct undated reports from one bureau separate (no false dedupe)', () => {
    const text = 'Equifax Credit Report FICO Score 700 (no parseable date)'
    const a = CREDIT_REPORT_RECOGNIZER.parse(text, 'jan.pdf')[0]
    const b = CREDIT_REPORT_RECOGNIZER.parse(text, 'feb.pdf')[0]
    expect(a.occurredAt).toBeNull() // no extractable date
    expect(a.naturalKey).not.toBe(b.naturalKey) // distinct files → distinct keys
  })
})

// A compact fixture in the exact shape pdf-parse produces for an Equifax
// "Annual Credit Report": several "Label: value" pairs packed per line, the
// creditor on the line above "Date Reported:", closed accounts suffixed
// " - Closed", and the delinquency grid between the month header and the legend.
const EQUIFAX_FIXTURE = `Equifax Credit Report
Report Date July 03, 2026
Summary
Average Account Age 6 Years, 7 Months
Length of Credit History 10 Years, 10 Months
Oldest Account SYNCB/AMAZON PLCC | September 2015
Personal Information
CHRIS D ENNIS
505 SPENCER DR APT 303, WEST PALM BEACH, FL 33409
Social Security Number: XXX-XX-7187
Date of Birth: 03/22/1973
Former Address(es): 1810 KOSTER AV, ALVIN, TX 77511
Credit Accounts
AMERICAN EXPRESS
PO Box 981537, El Paso, TX 79998-1537 | (800) 874-2717 Date Reported: 06/28/2026 | Balance: $8,579
Account Number: *3883 | Owner: Individual Account Credit Limit: $10,000 | High Credit: $10,076
Loan/Account Type: Credit Card | Status: Pays As Agreed
Date Opened: 01/15/2025 Date of 1st Delinquency: Terms Frequency: Monthly
Date of Last Activity: 06/28/2026 Date Major Delinquency 1st Reported: Months Reviewed: 17
Term Duration: Activity Designator: Narrative Code(s): 002
USAA FEDERAL SAVINGS BANK
PO Box 33009, San Antonio, TX 78265 | (800) 531-2265 Date Reported: 06/16/2026 | Balance: $331
Account Number: *7130 | Owner: Individual Account Credit Limit: $23,000 | High Credit: $9,695
Loan/Account Type: Credit Card | Status: Pays As Agreed
Date Opened: 01/04/2016 Date of 1st Delinquency: Terms Frequency: Monthly
Term Duration: Activity Designator: Narrative Code(s): 002
Bank of America - Closed
PO Box 982238, El Paso, TX 79998-2238 | (800) 421-2110 Date Reported: 05/28/2022 | Balance: $0
Account Number: *9462 | Owner: Individual Account Credit Limit: $8,000 | High Credit: $332
Loan/Account Type: Credit Card | Status: Pays As Agreed
Date Opened: 09/29/2019 Date of Last Payment: 04/01/2022 Date Closed: 01/01/2022
Term Duration: Activity Designator: Paid and Closed Narrative Code(s): 158, 065
Payment History
Year Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec
2022 60 90 120
2021 30 30
Paid on Time 30 30 Days Past Due 60 60 Days Past Due 90 90 Days Past Due 120 120 Days Past Due
Inquiries
A request for your credit history is called an inquiry.
Company Information Inquiry Type Inquiry Date(s)
COMENITYCAPITAL/SAKSMC
PO BOX 182120 COLUMBUS OH 43218
Phone: (614) 729-4754
Soft 09/25/2025
VERIZON
401 S HIGH ST WEST CHESTER PA 19383
Phone: (916) 357-3336
Soft 11/18/2025
A Summary of Your Rights Under the Fair Credit Reporting Act
Social Security Number: XXX-XX-7187`

describe('credit-report structured parsing', () => {
  const out = CREDIT_REPORT_RECOGNIZER.parse(EQUIFAX_FIXTURE, 'creditReport.pdf')

  it('emits one summary + one record per tradeline + one per inquiry', () => {
    const byType = out.reduce<Record<string, number>>((m, r) => {
      m[r.type] = (m[r.type] ?? 0) + 1
      return m
    }, {})
    expect(byType).toEqual({ 'credit-report': 1, 'credit-tradeline': 3, 'credit-inquiry': 2 })
  })

  it('extracts tradeline fields, closed flag, and utilization', () => {
    const amex = out.find((r) => r.type === 'credit-tradeline' && /AMERICAN EXPRESS/.test(r.title))
    const p = amex?.payload as Record<string, unknown>
    expect(p.accountLast4).toBe('3883')
    expect(p.balance).toBe(8579)
    expect(p.creditLimit).toBe(10000)
    expect(p.closed).toBe(false)
    expect(p.utilization).toBeCloseTo(0.8579, 3)
    // occurredAt is the date the account was opened, not the report date
    // (local midnight, matching parseWhen).
    expect(amex?.occurredAt).toBe(new Date(2025, 0, 15).getTime())
  })

  it('flags closed accounts and rolls up the delinquency grid (not the legend)', () => {
    const bofa = out.find((r) => r.type === 'credit-tradeline' && /Bank of America/.test(r.title))
    const p = bofa?.payload as { closed: boolean; paymentHistory: Record<string, number> }
    expect(bofa?.title).toBe('Bank of America — Closed')
    expect(p.closed).toBe(true)
    // 2022: 60 90 120 · 2021: 30 30 — the "Paid on Time 30 … 60 … 90 … 120 …"
    // legend must NOT be counted.
    expect(p.paymentHistory).toMatchObject({ late30: 2, late60: 1, late90: 1, late120: 1 })
  })

  it('parses inquiries with type and date', () => {
    const inq = out.filter((r) => r.type === 'credit-inquiry')
    expect(inq.map((r) => (r.payload as { company: string }).company)).toEqual([
      'COMENITYCAPITAL/SAKSMC',
      'VERIZON'
    ])
    expect((inq[0].payload as { inquiryType: string }).inquiryType).toBe('Soft')
  })

  it('never stores SSN, DOB, or personal-info addresses', () => {
    const blob = JSON.stringify(out)
    expect(blob).not.toContain('XXX-XX-7187')
    expect(blob).not.toContain('03/22/1973')
    expect(blob).not.toContain('SPENCER')
    expect(blob).not.toContain('KOSTER')
    // account numbers are reduced to trailing ≤4 digits
    for (const r of out.filter((x) => x.type === 'credit-tradeline')) {
      expect(
        (r.payload as { accountLast4: string | null }).accountLast4?.length ?? 0
      ).toBeLessThanOrEqual(4)
    }
  })

  it('keeps open vs closed and distinct report dates from colliding', () => {
    const keys = out.filter((r) => r.type === 'credit-tradeline').map((r) => r.naturalKey)
    expect(new Set(keys).size).toBe(keys.length) // all distinct within a report

    const later = CREDIT_REPORT_RECOGNIZER.parse(
      EQUIFAX_FIXTURE.replace('Report Date July 03, 2026', 'Report Date August 03, 2026'),
      'creditReport.pdf'
    ).filter((r) => r.type === 'credit-tradeline')
    // A new report date → a fresh snapshot (no dedupe against the July rows).
    expect(later[0].naturalKey).not.toBe(
      out.filter((r) => r.type === 'credit-tradeline')[0].naturalKey
    )
  })

  it('falls back to a single summary record on an unknown layout', () => {
    const text = 'Experian Personal Credit Report\nReport Date: 2026-01-15\nFICO Score 742'
    const recs = CREDIT_REPORT_RECOGNIZER.parse(text, 'x.pdf')
    expect(recs).toHaveLength(1)
    expect(recs[0].type).toBe('credit-report')
  })
})

// Experian: tab-delimited `Label \t value` fields, one block per " Account Info",
// a direct Balance, lates as "N days past due as of …", and the FULL account
// number (only the derived last-4 may be stored).
const EXPERIAN_FIXTURE = [
  'Annual Credit Report - Experian',
  'Date Generated Jul 3, 2026',
  '16 Accounts \t0 Public Records \t3 Hard Inquiries',
  ' Account Info',
  'Account Name \tAMERICAN EXPRESS',
  'Account Number \t3499933315943883',
  'Account Type \tCredit card',
  'Date Opened \t01/15/2025',
  'Status \tOpen/Never late.',
  'Balance \t$8,579',
  'Credit Limit \t$10,000',
  ' Payment History',
  ' Account Info',
  'Account Name \tBANK OF AMERICA',
  'Account Number \t546633111541',
  'Account Type \tCredit card',
  'Date Opened \t09/29/2019',
  'Status \tPaid, Closed.',
  'Balance \t$0',
  'Credit Limit \t$8,000',
  '120 days past due as of Mar 2022',
  '90 days past due as of Feb 2022',
  '60 days past due as of Jan 2022',
  '30 days past due as of Dec 2021,Aug 2021',
  ' Payment History',
  'Hard Inquiries',
  'USAA FEDERAL SAVINGS BAN',
  'Inquired on 03/13/2026',
  'Soft Inquiries',
  'CREDIT KARMA',
  'Inquired on 07/03/2026'
].join('\n')

describe('Experian structured parsing', () => {
  const out = CREDIT_REPORT_RECOGNIZER.parse(EXPERIAN_FIXTURE, 'experian.pdf')

  it('parses tab-delimited tradelines with a direct balance + utilization', () => {
    const amex = out.find((r) => r.type === 'credit-tradeline' && /AMERICAN EXPRESS/.test(r.title))
    const p = amex?.payload as Record<string, unknown>
    expect(p.balance).toBe(8579)
    expect(p.creditLimit).toBe(10000)
    expect(p.utilization).toBeCloseTo(0.8579, 3)
    expect(p.accountLast4).toBe('3883') // derived from the full number
    expect(out.filter((r) => r.type === 'credit-tradeline')).toHaveLength(2)
  })

  it('never stores the full account number Experian exposes', () => {
    expect(JSON.stringify(out)).not.toContain('3499933315943883')
  })

  it('flags closed accounts and counts "days past due" lates', () => {
    const bofa = out.find((r) => r.type === 'credit-tradeline' && /Bank of America/i.test(r.title))
    const p = bofa?.payload as { closed: boolean; paymentHistory: Record<string, number> }
    expect(p.closed).toBe(true)
    expect(p.paymentHistory).toMatchObject({ late30: 2, late60: 1, late90: 1, late120: 1 })
  })

  it('parses hard/soft inquiries', () => {
    const inq = out.filter((r) => r.type === 'credit-inquiry')
    expect(inq.some((r) => (r.payload as { inquiryType: string }).inquiryType === 'Hard')).toBe(
      true
    )
    expect(inq.some((r) => (r.payload as { company: string }).company === 'CREDIT KARMA')).toBe(
      true
    )
  })
})

// TransUnion: anchored on the masked account-number line; balance is intentionally
// dropped (payment-history column scatter), but limit/type/closed/lates are kept.
const TRANSUNION_FIXTURE = [
  'View Credit Report | TransUnion Online Service Center',
  'Account Name',
  'BANK OF AMERICA 546633111541****',
  'Account Information',
  'Date Opened \t09/29/2019',
  'Responsibility \tIndividual Account',
  'Loan Type \tCREDIT CARD',
  'High Balance \t$332',
  'Credit Limit \t$8,000',
  'Pay Status \tPaid, Closed; was Paid as agreed',
  'Date Closed \t01/26/2022',
  'Payment History',
  'August 2021',
  '30',
  'Rating',
  'January 2022',
  '60',
  'Rating',
  'February 2022',
  '90',
  'Rating',
  'March 2022',
  '120',
  'Rating',
  'Total Months: 31',
  'AMERICAN EXPRESS',
  '349993331594****',
  'Account Information',
  'Date Opened \t01/15/2025',
  'Loan Type \tCREDIT CARD',
  'Pay Status \tCurrent Account',
  'Payment History',
  'February 2025',
  'OK',
  'Rating',
  'Total Months: 17'
].join('\n')

describe('TransUnion structured parsing', () => {
  const out = CREDIT_REPORT_RECOGNIZER.parse(TRANSUNION_FIXTURE, 'transunion.pdf')

  it('anchors on the masked number, keeps limit/type/closed/lates, drops balance', () => {
    const tls = out.filter((r) => r.type === 'credit-tradeline')
    expect(tls).toHaveLength(2)
    const bofa = tls.find((r) => /Bank of America/i.test(r.title))
    const p = bofa?.payload as {
      creditor: string
      closed: boolean
      creditLimit: number | null
      balance: number | null
      accountLast4: string | null
      paymentHistory: Record<string, number>
    }
    expect(p.creditor).toBe('BANK OF AMERICA')
    expect(p.closed).toBe(true)
    expect(p.creditLimit).toBe(8000)
    expect(p.balance).toBeNull() // TransUnion balance is unreliable → not stored
    expect(p.accountLast4).toBeNull() // last four are masked
    expect(p.paymentHistory).toMatchObject({ late30: 1, late60: 1, late90: 1, late120: 1 })
  })

  it('resolves the second account creditor from the line above its number', () => {
    const amex = out.find((r) => r.type === 'credit-tradeline' && /AMERICAN EXPRESS/.test(r.title))
    expect(amex).toBeTruthy()
    expect((amex?.payload as { closed: boolean }).closed).toBe(false)
  })
})

describe('tax-document PDF recognizer', () => {
  it('detects a W-2 and indexes it by form + tax year (no wages/SSN stored)', () => {
    const text = 'Form W-2 Wage and Tax Statement\nTax Year 2025\nWages $84,000.00\nSSN 123-45-6789'
    expect(recognizePdf(text, 'w2.pdf')?.id).toBe('tax-document')

    const out = TAX_DOC_RECOGNIZER.parse(text, 'w2.pdf')
    expect(out[0].source).toBe('tax-document')
    expect(out[0].title).toBe('Tax document — W-2 2025')
    expect(out[0].occurredAt).toBe(new Date(2025, 11, 31).getTime()) // local Dec 31 of the tax year
    expect(JSON.stringify(out[0].payload)).not.toContain('84,000') // no amounts
    expect(JSON.stringify(out[0].payload)).not.toContain('123-45-6789') // no SSN
  })

  it('recognizes a 1099 and an IRS transcript', () => {
    expect(recognizePdf('Form 1099-INT Interest Income — IRS — tax year 2024', 'a.pdf')?.id).toBe(
      'tax-document'
    )
    const out = TAX_DOC_RECOGNIZER.parse(
      'Wage and Income Transcript — Internal Revenue Service — 2023',
      'b.pdf'
    )
    expect(out[0].title).toBe('Tax document — Wage & Income Transcript 2023')
  })

  it('uses the tax-period year on a transcript, not the request date', () => {
    const text = 'Tax Return Transcript\nRequest Date: 06-13-2024\nTax Period Ending: Dec. 31, 2023'
    const out = TAX_DOC_RECOGNIZER.parse(text, 't.pdf')
    expect(out[0].title).toBe('Tax document — Tax Return Transcript 2023') // not 2024
    expect(out[0].occurredAt).toBe(new Date(2023, 11, 31).getTime())
  })

  it('does not claim an invoice with a bare "1099" number and a "Sales tax" line', () => {
    const invoice = 'Invoice #1099\nSubtotal: $500\nSales tax: $40\nAmount due: $540'
    expect(TAX_DOC_RECOGNIZER.detect(invoice, 'invoice.pdf')).toBe(false)
    expect(recognizePdf(invoice, 'invoice.pdf')?.id).toBe('document') // falls to generic
  })
})

describe('Social Security statement recognizer', () => {
  it('detects an SSA statement and indexes it (no earnings / SSN stored)', () => {
    const text =
      'Your Social Security Statement\nSocial Security Administration\nPrepared for you on April 3, 2025\nSSN: 123-45-6789\nEstimated monthly retirement benefit: $2,400\nYour Social Security Earnings: $84,000'
    expect(recognizePdf(text, 'ssa.pdf')?.id).toBe('social-security') // wins over generic

    const out = SOCIAL_SECURITY_RECOGNIZER.parse(text, 'ssa.pdf')
    expect(out[0].source).toBe('social-security')
    expect(out[0].title).toBe('Social Security Statement 2025')
    expect(JSON.stringify(out[0].payload)).not.toContain('84,000') // no earnings record
    expect(JSON.stringify(out[0].payload)).not.toContain('2,400') // no benefit estimate
    expect(JSON.stringify(out[0].payload)).not.toContain('123-45-6789') // no SSN
  })

  it('does not grab a tax document that merely mentions social security wages', () => {
    const w2 = 'Form W-2 Wage and Tax Statement\nTax Year 2025\nSocial security wages $84,000'
    expect(recognizePdf(w2, 'w2.pdf')?.id).toBe('tax-document') // tax wins; SSA stays specific
  })
})

describe('generic document PDF recognizer', () => {
  it('indexes any other PDF as a dated document titled by filename', () => {
    const text = 'Residential Lease Agreement\nDated March 3, 2025\nbetween …'
    const rec = recognizePdf(text, 'lease.pdf')
    expect(rec?.id).toBe('document')
    const out = rec?.parse(text, 'lease.pdf') ?? []
    expect(out[0].source).toBe('document')
    expect(out[0].title).toBe('lease') // filename sans extension
    expect(out[0].occurredAt).toBe(new Date(2025, 2, 3).getTime()) // "March 3, 2025"
    expect(out[0].body).toBeUndefined() // metadata-only — no document text persisted
    expect(JSON.stringify(out[0].payload)).not.toContain('Residential') // snippet not stored
  })
})

describe('extractPdfText', () => {
  it('round-trips text out of a generated PDF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compass-pdf-'))
    const p = join(dir, 'x.pdf')
    writeFileSync(p, makePdf('Equifax Credit Report 2026-03-01 Score 800'))
    const { text, pages } = await extractPdfText(p)
    expect(text).toContain('Equifax Credit Report 2026-03-01 Score 800')
    expect(pages).toBe(1)
  })
})
