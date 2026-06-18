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
