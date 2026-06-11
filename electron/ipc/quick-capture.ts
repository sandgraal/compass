/**
 * Quick-capture IPC — backend for the tray / global-shortcut capture bar
 * (Phase 7 Track A). One handler, three capture kinds:
 *
 *   task    → checklist_items row for today (same semantics as checklist:quick-add)
 *   note    → timestamped bullet appended to knowledge-base/inbox/quick-capture.md
 *   expense → finance_transactions row, parsed from "12.50 coffee" / "coffee 12.50",
 *             run through the same categorize → geo/purpose → tax pipeline as ingest
 *
 * The capture window is the only consumer; it talks through the minimal
 * `preload-quick-capture.ts` bridge (window.api is NOT exposed there).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { categorizationRules, checklistItems, financeTransactions } from '../db/schema'
import { type RawTxn, categorize, hashTxn } from '../integrations/finance'
import { tagGeoAndPurpose } from '../integrations/finance-geo'
import { tagTax } from '../integrations/finance-tax'
import { localYmd } from '../lib/dates'
import { KNOWLEDGE_DIR } from '../paths'

export type QuickCaptureKind = 'task' | 'note' | 'expense'

export type QuickCaptureResult = { success: true } | { success: false; error: string }

const KINDS: ReadonlySet<string> = new Set(['task', 'note', 'expense'])
const MAX_TITLE_LEN = 500
const INBOX_NOTE_REL = join('inbox', 'quick-capture.md')

// "$12.50 coffee" / "12.50 coffee" — amount first, description after.
const AMOUNT_FIRST_RE = /^\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s+(.+)$/
// "coffee 12.50" / "coffee $12.50" — description first, amount last.
const AMOUNT_LAST_RE = /^(.+?)\s+\$?\s*(\d[\d,]*(?:\.\d{1,2})?)$/

/**
 * Parses an expense capture line into { amount, description }.
 * Amount may lead or trail, with optional `$` and thousands separators.
 * Returns null when no positive amount can be extracted.
 */
export function parseExpense(text: string): { amount: number; description: string } | null {
  const trimmed = text.trim()
  let amountStr: string | undefined
  let description: string | undefined

  const first = AMOUNT_FIRST_RE.exec(trimmed)
  if (first) {
    amountStr = first[1]
    description = first[2]
  } else {
    const last = AMOUNT_LAST_RE.exec(trimmed)
    if (last) {
      amountStr = last[2]
      description = last[1]
    }
  }

  if (!amountStr || !description) return null
  const amount = Number.parseFloat(amountStr.replace(/,/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { amount, description: description.trim() }
}

function captureTask(text: string): QuickCaptureResult {
  const db = getDb()
  db.insert(checklistItems)
    .values({
      listType: 'daily',
      listDate: localYmd(),
      title: text.slice(0, MAX_TITLE_LEN),
      category: 'personal',
      sortOrder: 999,
      source: 'manual',
      createdAt: new Date()
    })
    .run()
  return { success: true }
}

function captureNote(text: string): QuickCaptureResult {
  const fullPath = join(KNOWLEDGE_DIR, INBOX_NOTE_REL)
  const parent = dirname(fullPath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  if (!existsSync(fullPath)) {
    writeFileSync(fullPath, '# Quick Capture Inbox\n\n', 'utf8')
  }
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  // Single-line entries only — the capture bar is a one-line input, but
  // collapse any pasted newlines so one capture is always one bullet.
  const oneLine = text.replace(/\s*\n\s*/g, ' ')
  appendFileSync(fullPath, `- ${localYmd(now)} ${hh}:${mm} — ${oneLine}\n`, 'utf8')
  return { success: true }
}

function captureExpense(text: string): QuickCaptureResult {
  const parsed = parseExpense(text)
  if (!parsed) {
    return {
      success: false,
      error: 'Could not find an amount. Try "12.50 coffee" or "coffee 12.50".'
    }
  }

  const db = getDb()
  const date = localYmd()
  // Each capture is an intentional, distinct purchase — two "4.50 coffee"
  // captures in one day are two coffees. Salt the hash with the capture
  // instant so the natural-field dedupe (built for re-ingested CSVs) never
  // swallows the second one.
  const raw: RawTxn = {
    date,
    amount: -Math.abs(parsed.amount),
    description: parsed.description.slice(0, MAX_TITLE_LEN),
    account: 'Quick Capture',
    sourceFile: 'quick-capture',
    hash: hashTxn(date, -Math.abs(parsed.amount), parsed.description, `quick-capture:${Date.now()}`)
  }

  const rules = db.select().from(categorizationRules).all()
  const [txn] = tagTax(tagGeoAndPurpose(categorize([raw], rules)))

  db.insert(financeTransactions)
    .values({
      hash: txn.hash,
      date: txn.date,
      amount: txn.amount,
      description: txn.description,
      accountId: null,
      category: txn.category ?? 'Uncategorized',
      subcategory: txn.subcategory,
      notes: txn.notes,
      geo: txn.geo ?? 'US',
      purpose: txn.purpose ?? null,
      taxTag: txn.taxTag ?? 'tax:none',
      taxTagSource: 'auto',
      taxYear: txn.taxYear ?? null,
      sourceFile: txn.sourceFile,
      ingestedAt: new Date()
    })
    .run()
  return { success: true }
}

export function registerQuickCaptureHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('quick-capture:submit', (_event, kind: unknown, text: unknown) => {
    try {
      if (typeof kind !== 'string' || !KINDS.has(kind)) {
        return { success: false, error: 'Unknown capture type' }
      }
      const trimmed = String(text ?? '').trim()
      if (!trimmed) return { success: false, error: 'Nothing to capture' }

      switch (kind as QuickCaptureKind) {
        case 'task':
          return captureTask(trimmed)
        case 'note':
          return captureNote(trimmed)
        case 'expense':
          return captureExpense(trimmed)
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
