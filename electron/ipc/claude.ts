/**
 * Claude Inbox IPC (Phase 8.2) — the approval surface for Claude's proposals.
 *
 * The read-only MCP server appends proposals to `<data>/claude-inbox.jsonl`
 * (see mcp/compass-mcp/proposals.ts). This module ingests that append-only
 * inbox into the `claude_proposals` table (dedup by the MCP-minted UUID), lets
 * the user approve/reject each one, and — only on approval — applies the change
 * through the same validated write logic the app uses elsewhere.
 *
 * Trust boundary: the JSONL is written by an LLM, so every field is
 * re-validated here on apply (path traversal via `safeJoin`, the shared
 * `TAX_TAGS` whitelist, list-type domain, strict booleans) — never trusted
 * because the MCP already checked. The vault is never touched.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import type * as schema from '../db/schema'
import {
  checklistItems,
  claudeProposals,
  financeTransactions,
  habitEntries,
  habits
} from '../db/schema'
import { DATA_DIR, KNOWLEDGE_DIR } from '../paths'
import { TAX_TAGS } from './finance'
import { safeJoin } from './knowledge'

const LIST_TYPES = new Set(['daily', 'weekly', 'monthly'])
const PROPOSAL_TYPES = new Set(['task', 'note', 'txn_tag', 'habit_check'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The concrete handle (getDb result) and a transaction handle both satisfy this
// base, so apply logic can run either standalone or inside `db.transaction`.
type Db = BaseSQLiteDatabase<'sync', BetterSqlite3.RunResult, typeof schema>

/** A real calendar day in YYYY-MM-DD form (shape + round-trip through Date). */
function isRealYmd(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/**
 * A relative POSIX `.md` path that stays inside the knowledge base: no leading
 * `/`, no `..`, no backslashes, no Windows drive letter / UNC. Mirrors the MCP
 * propose-tool contract so approval enforces the same boundary as enqueueing.
 */
function isSafeNotePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !/^[a-zA-Z]:/.test(path) &&
    path.endsWith('.md')
  )
}

export function inboxPath(): string {
  return join(DATA_DIR, 'claude-inbox.jsonl')
}

interface InboxLine {
  id: string
  createdAt: string
  type: string
  source?: string
  payload: Record<string, unknown>
}

function isInboxLine(value: unknown): value is InboxLine {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.type === 'string' &&
    PROPOSAL_TYPES.has(v.type) &&
    typeof v.payload === 'object' &&
    v.payload !== null
  )
}

/**
 * Read the append-only JSONL inbox and insert any not-yet-seen proposals into
 * `claude_proposals` (dedup by `proposalId`). Malformed lines are skipped, not
 * fatal. Returns the number of new rows inserted.
 */
export function ingestProposals(db: Db, file: string = inboxPath()): number {
  if (!existsSync(file)) return 0
  const raw = readFileSync(file, 'utf8')
  let inserted = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // tolerate a partially-written / corrupt line
    }
    if (!isInboxLine(parsed)) continue
    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime())) continue
    const res = db
      .insert(claudeProposals)
      .values({
        proposalId: parsed.id,
        type: parsed.type,
        payload: JSON.stringify(parsed.payload),
        source: parsed.source ?? 'claude-mcp',
        status: 'pending',
        createdAt
      })
      .onConflictDoNothing({ target: claudeProposals.proposalId })
      .run()
    inserted += res.changes
  }
  return inserted
}

export interface ProposalView {
  id: number
  proposalId: string
  type: string
  payload: Record<string, unknown>
  source: string
  status: string
  createdAt: number | null
  resolvedAt: number | null
  error: string | null
  resultRef: string | null
}

function toView(row: typeof claudeProposals.$inferSelect): ProposalView {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    proposalId: row.proposalId,
    type: row.type,
    payload,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt ? row.createdAt.getTime() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
    error: row.error,
    resultRef: row.resultRef
  }
}

export function listProposals(db: Db, status?: string): ProposalView[] {
  // Soft-cleared rows are hidden from the inbox but kept for dedup.
  const notCleared = isNull(claudeProposals.clearedAt)
  const rows = status
    ? db
        .select()
        .from(claudeProposals)
        .where(and(eq(claudeProposals.status, status), notCleared))
        .orderBy(desc(claudeProposals.ingestedAt))
        .all()
    : db
        .select()
        .from(claudeProposals)
        .where(notCleared)
        .orderBy(desc(claudeProposals.ingestedAt))
        .all()
  return rows.map(toView)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Apply an approved proposal via the app's validated write paths. Throws on any
 * validation failure (the caller records the error + marks the row failed).
 * Returns a short human-readable reference to what was written.
 */
export function applyProposal(db: Db, type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'task': {
      const title = str(payload.title)
      if (!title) throw new Error('task: title is required')
      const listType = str(payload.listType) || 'daily'
      if (!LIST_TYPES.has(listType)) throw new Error(`task: invalid listType "${listType}"`)
      const listDate = str(payload.listDate)
      if (!isRealYmd(listDate)) throw new Error('task: invalid listDate (need a real YYYY-MM-DD)')
      const row = db
        .insert(checklistItems)
        .values({
          listType,
          listDate,
          title,
          body: str(payload.body) || undefined,
          category: str(payload.category) || 'personal',
          source: 'claude',
          createdAt: new Date()
        })
        .returning()
        .get()
      return `checklist:${row.id}`
    }

    case 'note': {
      const rel = str(payload.path)
      if (!isSafeNotePath(rel)) {
        throw new Error(
          'note: path must be a relative .md path (no "..", absolute, or Windows/UNC)'
        )
      }
      const content = typeof payload.content === 'string' ? payload.content : ''
      if (!content.trim()) throw new Error('note: content is required')
      const mode = payload.mode === 'append' ? 'append' : 'create'
      const fullPath = safeJoin(KNOWLEDGE_DIR, rel) // throws on traversal
      if (mode === 'create') {
        if (existsSync(fullPath)) throw new Error(`note: file already exists (${rel})`)
        mkdirSync(dirname(fullPath), { recursive: true })
        writeFileSync(fullPath, content, 'utf8')
      } else {
        mkdirSync(dirname(fullPath), { recursive: true })
        if (existsSync(fullPath)) {
          const prev = readFileSync(fullPath, 'utf8')
          const sep = prev.endsWith('\n') ? '' : '\n'
          appendFileSync(fullPath, `${sep}${content}`, 'utf8')
        } else {
          writeFileSync(fullPath, content, 'utf8')
        }
      }
      return `knowledge:${rel}`
    }

    case 'txn_tag': {
      const id = Number(payload.transactionId)
      if (!Number.isInteger(id) || id <= 0) throw new Error('txn_tag: invalid transactionId')
      const taxTag = str(payload.taxTag)
      const category = str(payload.category)
      if (!taxTag && !category) throw new Error('txn_tag: nothing to set')
      if (taxTag && !TAX_TAGS.has(taxTag)) {
        throw new Error(
          `txn_tag: unknown tax tag "${taxTag}" — allowed: ${[...TAX_TAGS].join(', ')}`
        )
      }
      const updates: Record<string, unknown> = {}
      if (taxTag) {
        updates.taxTag = taxTag
        updates.taxTagSource = 'user'
      }
      if (category) updates.category = category
      const res = db
        .update(financeTransactions)
        .set(updates)
        .where(eq(financeTransactions.id, id))
        .run()
      if (res.changes === 0) throw new Error(`txn_tag: transaction not found (${id})`)
      return `txn:${id}`
    }

    case 'habit_check': {
      const habitId = Number(payload.habitId)
      if (!Number.isInteger(habitId) || habitId <= 0)
        throw new Error('habit_check: invalid habitId')
      const date = str(payload.date)
      if (!isRealYmd(date)) throw new Error('habit_check: invalid date (need a real YYYY-MM-DD)')
      if (typeof payload.completed !== 'boolean')
        throw new Error('habit_check: completed must be boolean')
      const completed = payload.completed
      const habit = db.select({ id: habits.id }).from(habits).where(eq(habits.id, habitId)).get()
      if (!habit) throw new Error(`habit_check: habit not found (${habitId})`)
      // Set the explicit desired state (not a toggle — the proposal carries intent).
      const existing = db
        .select()
        .from(habitEntries)
        .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.date, date)))
        .get()
      if (existing) {
        db.update(habitEntries).set({ completed }).where(eq(habitEntries.id, existing.id)).run()
      } else {
        db.insert(habitEntries).values({ habitId, date, completed }).run()
      }
      return `habit:${habitId}:${date}`
    }

    default:
      throw new Error(`Unknown proposal type: ${type}`)
  }
}

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // List proposals — ingests the inbox first so the UI always reflects the
  // latest enqueued items. Optional status filter ('pending' etc.).
  ipcMain.handle('claude:list-proposals', (_event, status?: string) => {
    const db = getDb()
    try {
      ingestProposals(db)
    } catch {
      // a bad inbox file shouldn't break listing already-ingested proposals
    }
    return listProposals(db, status)
  })

  // Approve — apply via validated write paths; record result or failure.
  ipcMain.handle('claude:approve-proposal', (_event, id: number) => {
    const db = getDb()
    const row = db.select().from(claudeProposals).where(eq(claudeProposals.id, id)).get()
    if (!row) return { success: false, error: `Proposal not found: ${id}` }
    if (row.status !== 'pending') return { success: false, error: `Proposal is ${row.status}` }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      payload = {}
    }
    try {
      // Apply + mark-approved atomically so a failed status write can't leave
      // the row 'pending' after the mutation already happened (which would let
      // it be re-approved). For DB-only proposal types the whole thing rolls
      // back together; the `note` type also writes a file inside the txn — that
      // FS write isn't transactional, but a later create re-approve is caught
      // by the file-exists guard, so it can't silently double-write.
      const resultRef = db.transaction((tx) => {
        const ref = applyProposal(tx, row.type, payload)
        tx.update(claudeProposals)
          .set({ status: 'approved', resolvedAt: new Date(), resultRef: ref, error: null })
          .where(eq(claudeProposals.id, id))
          .run()
        return ref
      })
      return { success: true, resultRef }
    } catch (err) {
      const error = (err as Error).message
      db.update(claudeProposals)
        .set({ status: 'failed', resolvedAt: new Date(), error })
        .where(eq(claudeProposals.id, id))
        .run()
      return { success: false, error }
    }
  })

  // Reject — mark rejected, apply nothing.
  ipcMain.handle('claude:reject-proposal', (_event, id: number) => {
    const db = getDb()
    const res = db
      .update(claudeProposals)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(and(eq(claudeProposals.id, id), eq(claudeProposals.status, 'pending')))
      .run()
    if (res.changes === 0) return { success: false, error: 'No pending proposal with that id' }
    return { success: true }
  })

  // Clear — soft-clear resolved (approved/rejected/failed) rows: stamp
  // `clearedAt` so they drop out of the inbox view but the row survives for
  // dedup. Hard-deleting would let the never-truncated JSONL re-ingest and
  // re-apply a resolved proposal as a fresh pending one.
  ipcMain.handle('claude:clear-resolved', () => {
    const db = getDb()
    const res = db
      .update(claudeProposals)
      .set({ clearedAt: new Date() })
      .where(
        and(
          inArray(claudeProposals.status, ['approved', 'rejected', 'failed']),
          isNull(claudeProposals.clearedAt)
        )
      )
      .run()
    return { success: true, cleared: res.changes }
  })
}
