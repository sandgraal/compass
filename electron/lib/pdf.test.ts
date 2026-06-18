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
import { CREDIT_REPORT_RECOGNIZER, extractPdfText } from './pdf'
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
