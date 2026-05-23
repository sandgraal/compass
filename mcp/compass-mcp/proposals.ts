/**
 * Compass MCP — propose-write tools (Phase 8.1, write half).
 *
 * Claude NEVER mutates Compass data directly. Each `compass_propose_*` tool
 * validates its input and appends a single JSON line to an append-only inbox
 * (`<app-data>/.data/claude-inbox.jsonl`). The running Compass app later
 * ingests that inbox into the `claude_proposals` table and surfaces each
 * proposal in the Claude Inbox for human approve/reject (Phase 8.2). Approval —
 * not this tool — is what executes the change, through the app's existing
 * validated write IPC.
 *
 * Invariants enforced here:
 *  - This module opens NO database and reads NO vault. It only appends to the
 *    JSONL inbox (a separate store from the read-only `compass.db`).
 *  - Note paths are relative `.md` only, with traversal blocked.
 *  - Every proposal is stamped `status: 'pending'` and `source: 'claude-mcp'`.
 *
 * The JSONL line schema is the contract consumed by Phase 8.2 — keep it stable.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { localYmd } from './dates.js'

export type ProposalType = 'task' | 'note' | 'txn_tag' | 'habit_check'

export interface Proposal {
  id: string
  createdAt: string
  status: 'pending'
  source: 'claude-mcp'
  type: ProposalType
  payload: Record<string, unknown>
}

/** Result of validating raw tool args into a proposal body (no id/timestamp). */
export type BuildResult =
  | { type: ProposalType; payload: Record<string, unknown> }
  | { error: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate the raw `arguments` for a `compass_propose_*` tool and produce the
 * proposal body, or an `{ error }` describing why it was rejected. Pure — no
 * I/O, no clock beyond the local-day default — so it is straightforward to
 * unit-test each tool's contract.
 */
export function buildProposal(
  toolName: string,
  args: Record<string, unknown> | undefined
): BuildResult {
  const a = args ?? {}

  switch (toolName) {
    case 'compass_propose_task': {
      const title = asTrimmedString(a.title)
      if (!title) return { error: 'title is required' }
      const listType = a.listType === 'master' ? 'master' : 'daily'
      const rawDate = a.listDate
      const listDate = typeof rawDate === 'string' && DATE_RE.test(rawDate) ? rawDate : localYmd()
      const payload: Record<string, unknown> = { title, listType, listDate }
      const body = asTrimmedString(a.body)
      if (body) payload.body = body
      const category = asTrimmedString(a.category)
      if (category) payload.category = category
      return { type: 'task', payload }
    }

    case 'compass_propose_note': {
      const path = typeof a.path === 'string' ? a.path : ''
      if (!path || path.startsWith('/') || path.includes('..') || !path.endsWith('.md')) {
        return { error: 'path must be a relative .md path with no ".." segments' }
      }
      const content = typeof a.content === 'string' ? a.content : ''
      if (!content.trim()) return { error: 'content is required' }
      const mode = a.mode === 'append' ? 'append' : 'create'
      return { type: 'note', payload: { path, content, mode } }
    }

    case 'compass_propose_txn_tag': {
      const transactionId = Number(a.transactionId)
      if (!Number.isInteger(transactionId) || transactionId <= 0) {
        return { error: 'transactionId (positive integer) is required' }
      }
      const payload: Record<string, unknown> = { transactionId }
      const taxTag = asTrimmedString(a.taxTag)
      if (taxTag) payload.taxTag = taxTag
      const category = asTrimmedString(a.category)
      if (category) payload.category = category
      if (!('taxTag' in payload) && !('category' in payload)) {
        return { error: 'provide at least one of taxTag or category' }
      }
      return { type: 'txn_tag', payload }
    }

    case 'compass_propose_habit_check': {
      const habitId = Number(a.habitId)
      if (!Number.isInteger(habitId) || habitId <= 0) {
        return { error: 'habitId (positive integer) is required' }
      }
      const rawDate = a.date
      const date = typeof rawDate === 'string' && DATE_RE.test(rawDate) ? rawDate : localYmd()
      const completed = a.completed === undefined ? true : Boolean(a.completed)
      return { type: 'habit_check', payload: { habitId, date, completed } }
    }

    default:
      return { error: `Unknown propose tool: ${toolName}` }
  }
}

/** Stamp a validated body with id/timestamp/status to produce a full Proposal. */
export function makeProposal(type: ProposalType, payload: Record<string, unknown>): Proposal {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    source: 'claude-mcp',
    type,
    payload
  }
}

/** Append one proposal as a JSON line to the inbox, creating its dir if needed. */
export function appendProposal(inboxPath: string, proposal: Proposal): void {
  mkdirSync(dirname(inboxPath), { recursive: true })
  appendFileSync(inboxPath, `${JSON.stringify(proposal)}\n`, 'utf8')
}

/** Tool definitions for the propose-write half — spread into the server's TOOLS. */
export const PROPOSE_TOOLS = [
  {
    name: 'compass_propose_task',
    description:
      "PROPOSE adding a task to a Compass checklist. Does NOT add it — it enqueues a proposal that the user must approve in the Compass Claude Inbox before anything changes. Defaults to today's daily list (local calendar day).",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        body: { type: 'string', description: 'Optional longer note/body' },
        category: { type: 'string', description: 'Optional category label' },
        listType: { type: 'string', enum: ['daily', 'master'], default: 'daily' },
        listDate: {
          type: 'string',
          description: 'YYYY-MM-DD local day for a daily-list item; defaults to today'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'compass_propose_note',
    description:
      'PROPOSE creating or appending to a knowledge-base markdown note. Does NOT write the file — it enqueues a proposal for the user to approve in the Compass Claude Inbox. Path must be a relative .md path (e.g. "notes/idea.md"); no traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative .md path under the knowledge base' },
        content: { type: 'string', description: 'Markdown content (required)' },
        mode: { type: 'string', enum: ['create', 'append'], default: 'create' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'compass_propose_txn_tag',
    description:
      'PROPOSE tagging a finance transaction (set a tax tag and/or recategorize). Does NOT modify the transaction — it enqueues a proposal for the user to approve in the Compass Claude Inbox. Provide at least one of taxTag or category. Identifies the transaction by id only; no raw transaction data is read here.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: { type: 'integer', minimum: 1, description: 'Transaction id (required)' },
        taxTag: { type: 'string', description: 'Tax tag to set' },
        category: { type: 'string', description: 'Category to set' }
      },
      required: ['transactionId'],
      additionalProperties: false
    }
  },
  {
    name: 'compass_propose_habit_check',
    description:
      'PROPOSE marking a habit complete (or not) for a given day. Does NOT toggle the habit — it enqueues a proposal for the user to approve in the Compass Claude Inbox. Defaults to today (local calendar day) and completed=true.',
    inputSchema: {
      type: 'object',
      properties: {
        habitId: { type: 'integer', minimum: 1, description: 'Habit id (required)' },
        date: { type: 'string', description: 'YYYY-MM-DD local day; defaults to today' },
        completed: { type: 'boolean', default: true }
      },
      required: ['habitId'],
      additionalProperties: false
    }
  }
]
