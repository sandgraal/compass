/**
 * PDF ingestion (Phase 10.2/10.5 — "The Acquisition Engine", RIGHTS mode).
 *
 * The 5th ingestion shape: a dropped PDF is text-extracted (main-process only,
 * via `pdf-parse`) and routed through PDF recognizers. This is the gateway to the
 * legally-owed disclosures that arrive as PDFs — credit reports first, then tax /
 * medical / government letters.
 *
 * PRIVACY: records are a content-light INDEX, not a copy. A credit report holds
 * SSNs / account numbers, so we deliberately do NOT store the extracted text — we
 * capture the high-level facts (bureau · score · report date) and leave the source
 * file with the user. Compass indexes the document on the timeline; it doesn't
 * duplicate its sensitive contents into the DB.
 *
 * Structured tradeline / inquiry parsing is a follow-up that needs real sample
 * reports to validate against — v1 detects + dates + summarizes.
 */

import { readFileSync } from 'node:fs'
import { PDFParse } from 'pdf-parse'
import { parseWhen } from './dates'
import type { PdfRecognizer, RecordInput } from './recognizers'

/** Extract plain text from a PDF (main process). Strips pdf-parse's "-- N of M --" page markers. */
export async function extractPdfText(path: string): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: readFileSync(path) })
  try {
    const r = await parser.getText()
    const text = (r.text ?? '')
      .replace(/^-- \d+ of \d+ --$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { text, pages: r.total ?? 0 }
  } finally {
    await parser.destroy()
  }
}

const BUREAU = /\b(equifax|experian|transunion)\b/i
const SCORE = /\b(?:fico|vantage(?:score)?|credit)\s*score\b[^\d]{0,15}(\d{3})\b/i
const ANY_DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8} \d{1,2},? \d{4})\b/

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/** The report's own date (prefer a labelled date, else the first date in the text). */
function reportDate(text: string): number | null {
  const labelled = text.match(
    /(?:report date|date generated|prepared(?: on)?|as of)[:\s]*([A-Z][a-z]{2,8} \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i
  )
  if (labelled) return parseWhen(labelled[1])
  const any = text.match(ANY_DATE)
  return any ? parseWhen(any[1]) : null
}

/** Consumer credit report — detect by the report/bureau signature; summarize bureau · score · date. */
export const CREDIT_REPORT_RECOGNIZER: PdfRecognizer = {
  id: 'credit-report',
  label: 'Credit report (PDF)',
  detect: (text) => {
    const t = text.toLowerCase()
    return (
      /credit report|credit file/.test(t) || (BUREAU.test(t) && /score|tradeline|inquir/.test(t))
    )
  },
  parse: (text, name) => {
    const b = text.match(BUREAU)
    const bureau = b ? titleCase(b[1]) : ''
    const s = text.match(SCORE)
    const score = s && Number(s[1]) >= 300 && Number(s[1]) <= 900 ? s[1] : ''
    const when = reportDate(text)
    return [
      {
        source: 'credit-report',
        type: 'credit-report',
        occurredAt: when,
        title: bureau ? `Credit report — ${bureau}` : 'Credit report',
        body: [bureau, score ? `score ${score}` : ''].filter(Boolean).join(' · ') || undefined,
        // Summary only — NOT the raw text (it holds SSN / account numbers).
        payload: { bureau, score: score || null, file: name },
        naturalKey: `${bureau || name}|${when ?? ''}`
      }
    ]
  }
}

/** Catch-all: any other PDF becomes one dated document index entry (title from the filename). */
export const GENERIC_DOC_RECOGNIZER: PdfRecognizer = {
  id: 'document',
  label: 'PDF document',
  detect: () => true,
  parse: (text, name) => {
    const firstLine =
      text
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) ?? ''
    const base = name.replace(/\.pdf$/i, '').trim()
    return [
      {
        source: 'document',
        type: 'document',
        occurredAt: reportDate(text),
        title: base || firstLine.slice(0, 120) || 'Document',
        body: firstLine ? firstLine.slice(0, 200) : undefined,
        payload: { file: name, firstLine: firstLine.slice(0, 200) },
        naturalKey: `${name}|${firstLine.slice(0, 60)}`
      } satisfies RecordInput
    ]
  }
}
