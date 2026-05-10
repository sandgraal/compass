/**
 * Costa Rica ATM 70/30 split post-processor.
 *
 * In the user's accounting model, ATM withdrawals from CR banks (Banco Popular,
 * Scotiabank, the 020NNNNNNN ATM IDs) are mostly construction-related cash
 * spend on the Airbnb build (paying contractors, buying small materials in
 * cash, etc). The current heuristic: 70% goes to Property/Construction and
 * 30% stays as personal cash.
 *
 * On every ingest, this scans for newly-ingested CR ATM rows that haven't been
 * split yet, mutates the original row to the project portion, and inserts a
 * sibling row for the personal portion. Idempotent — rows tagged with the
 * SPLIT_MARKER are skipped on re-run.
 *
 * Adjust SPLIT_PROJECT below if the ratio changes. Override per-row by adding
 * an explicit category edit in the UI; the marker stays so we won't re-split.
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

export const SPLIT_PROJECT = 0.7
export const SPLIT_MARKER_PROJECT = '70% project split'
export const SPLIT_MARKER_PERSONAL = '30% personal split'

const CR_ATM_PATTERNS = ['cartago', 'banco popular', 'scotiabank', 'san jose']
const US_OVERRIDES = ['west palm bea', 'pai atm', 'pai iso']

function isCrAtm(
  description: string,
  category: string | null,
  subcategory: string | null
): boolean {
  const d = (description || '').toLowerCase()
  if (!CR_ATM_PATTERNS.some((p) => d.includes(p))) return false
  if (US_OVERRIDES.some((p) => d.includes(p))) return false
  // Skip the personal sibling produced by a previous split.
  if ((subcategory || '').toLowerCase().includes('split sibling')) return false
  return category === 'Cash'
}

function isAlreadySplit(notes: string | null): boolean {
  if (!notes) return false
  return notes.includes(SPLIT_MARKER_PROJECT) || notes.includes(SPLIT_MARKER_PERSONAL)
}

function splitAmount(orig: number): { project: number; personal: number } {
  // Round project, then derive personal as residual to avoid float drift.
  const project = Math.round(orig * SPLIT_PROJECT * 100) / 100
  const personal = Math.round((orig - project) * 100) / 100
  return { project, personal }
}

export type AtmSplitResult = {
  splitCount: number
  rows: { hash: string; date: string; amount: number; description: string }[]
}

/**
 * Run one pass over the ledger. Returns counts of rows modified and the new
 * sibling rows inserted. Safe to call after every ingest.
 */
export function applyAtmSplit(db: BetterSQLite3Database<typeof schema>): AtmSplitResult {
  const candidates = db
    .select()
    .from(schema.financeTransactions)
    .where(eq(schema.financeTransactions.category, 'Cash'))
    .all()

  const result: AtmSplitResult = { splitCount: 0, rows: [] }
  const tx = db as unknown as {
    transaction: <T>(cb: (tx: BetterSQLite3Database<typeof schema>) => T) => T
  }

  // Some Drizzle/better-sqlite3 versions expose `.transaction`, some don't.
  // Fall back to running operations directly if unavailable.
  const runner = (cb: (tx: BetterSQLite3Database<typeof schema>) => void) => {
    if (typeof tx.transaction === 'function') {
      tx.transaction((t) => {
        cb(t as BetterSQLite3Database<typeof schema>)
      })
    } else {
      cb(db)
    }
  }

  runner((t) => {
    for (const row of candidates) {
      if (!isCrAtm(row.description, row.category, row.subcategory)) continue
      if (isAlreadySplit(row.notes)) continue

      const { project, personal } = splitAmount(row.amount)

      // Mutate the original to the project portion.
      const prefix = row.notes ? `${row.notes} | ` : ''
      const projectNotes = `${prefix}${SPLIT_MARKER_PROJECT} (Airbnb construction estimate)`
      t.update(schema.financeTransactions)
        .set({
          amount: project,
          category: 'Property',
          subcategory: 'Construction — labor (est)',
          notes: projectNotes
        })
        .where(eq(schema.financeTransactions.id, row.id))
        .run()

      // Insert sibling for the personal portion. Hash differs from the original
      // so the dedupe layer doesn't choke if it ever re-encounters it.
      const siblingHash = createHash('sha1')
        .update(`${row.hash}|split_personal`)
        .digest('hex')
        .slice(0, 16)
      t.insert(schema.financeTransactions)
        .values({
          hash: siblingHash,
          date: row.date,
          amount: personal,
          description: row.description,
          accountId: row.accountId,
          category: 'Cash',
          subcategory: 'Personal — split sibling',
          notes: `${SPLIT_MARKER_PERSONAL} (sibling of ${row.hash})`,
          sourceFile: row.sourceFile,
          ingestedAt: new Date()
        })
        .onConflictDoNothing()
        .run()

      result.splitCount++
      result.rows.push({
        hash: row.hash,
        date: row.date,
        amount: row.amount,
        description: row.description
      })
    }
  })

  return result
}

// Exported for tests
export const _internal = { isCrAtm, isAlreadySplit, splitAmount }
