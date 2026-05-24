/**
 * Tools the embedded Claude agent ("Ask Compass", Phase 8.5) can call over the
 * user's local data. Two kinds, mirroring the MCP boundary:
 *
 *   - READ tools answer questions from `compass.db` (aggregates / summaries —
 *     never the vault, never raw finance rows beyond what the MCP already
 *     exposes).
 *   - PROPOSE tools never mutate anything; they enqueue a `pending` row in
 *     `claude_proposals`, exactly like the MCP propose tools, so the change
 *     surfaces in the Claude Inbox for human approval.
 *
 * `executeAssistantTool` is pure w.r.t. the model — it takes a db handle + the
 * tool name/input and returns a JSON-serialisable result — so it unit-tests
 * against an in-memory SQLite without any network.
 */

import { randomUUID } from 'node:crypto'
import { and, eq, gte, lte } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { calendarEvents, checklistItems, claudeProposals, financeAccounts } from '../db/schema'

type Db = ReturnType<typeof getDb>

const DAY_MS = 86_400_000
const LIST_TYPES = new Set(['daily', 'weekly', 'monthly'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Local calendar day (matches the app's date-only column semantics — never UTC).
function localYmd(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function localYm(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function isRealYmd(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** Anthropic tool schemas advertised to the model. */
export const ASSISTANT_TOOLS = [
  {
    name: 'get_upcoming',
    description:
      "Read the user's near-term agenda: today's checklist tasks, calendar events in the next N days, and accounts with a payment due in the next 14 days. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Lookahead window (default 7)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_finance_summary',
    description:
      'Read AGGREGATE finances only — net worth (assets/liabilities), per-month income/expense/net for the last N months, and current-month spend by category. Never returns individual transactions. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        months: {
          type: 'integer',
          minimum: 1,
          maximum: 24,
          description: 'Months of history (default 6)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'propose_task',
    description:
      'Propose adding a task to a Compass checklist. Does NOT add it — it enqueues a proposal the user must approve in the Claude Inbox. Use this instead of claiming you added a task.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        listType: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        listDate: { type: 'string', description: 'YYYY-MM-DD local day; defaults to today' },
        category: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    }
  }
] as const

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function getUpcoming(db: Db, input: Record<string, unknown>): unknown {
  const days = Math.min(
    30,
    Math.max(1, Number.isFinite(Number(input.days)) ? Number(input.days) : 7)
  )
  const today = localYmd()
  const now = Date.now()
  const cutoff = now + days * DAY_MS
  const tasks = db
    .select({
      title: checklistItems.title,
      status: checklistItems.status,
      category: checklistItems.category
    })
    .from(checklistItems)
    .where(and(eq(checklistItems.listType, 'daily'), eq(checklistItems.listDate, today)))
    .all()
  const events = db
    .select({
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      location: calendarEvents.location
    })
    .from(calendarEvents)
    .where(
      and(gte(calendarEvents.startAt, new Date(now)), lte(calendarEvents.startAt, new Date(cutoff)))
    )
    .orderBy(calendarEvents.startAt)
    .all()
  const dueWindowEnd = localYmd(new Date(now + 14 * DAY_MS))
  const paymentsDue = db
    .select({ name: financeAccounts.name, dueDate: financeAccounts.paymentDueDate })
    .from(financeAccounts)
    .where(
      and(
        gte(financeAccounts.paymentDueDate, today),
        lte(financeAccounts.paymentDueDate, dueWindowEnd)
      )
    )
    .orderBy(financeAccounts.paymentDueDate)
    .all()
  return { date: today, tasks, events, paymentsDue }
}

function getFinanceSummary(db: Db, input: Record<string, unknown>): unknown {
  const months = Math.min(
    24,
    Math.max(1, Number.isFinite(Number(input.months)) ? Number(input.months) : 6)
  )
  const accounts = db
    .select({
      isDebt: financeAccounts.isDebt,
      assetClass: financeAccounts.assetClass,
      balance: financeAccounts.balance
    })
    .from(financeAccounts)
    .all()
  let assets = 0
  let liabilities = 0
  for (const a of accounts) {
    const bal = a.balance ?? 0
    if (a.isDebt || a.assetClass === 'liability') liabilities += bal
    else assets += bal
  }
  const round = (n: number): number => Math.round(n * 100) / 100
  // Drizzle's typed builder doesn't express `GROUP BY substr(date,1,7)` cleanly,
  // so run the monthly + by-category aggregates as raw prepared statements via
  // the underlying better-sqlite3 handle. (Mirrors mcp/compass-mcp finance SQL.)
  const sqlite = (
    db as unknown as {
      $client?: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }
    }
  ).$client
  let monthlyRows: Array<{
    month: string
    income: number
    expense: number
    txns: number
    net?: number
  }> = []
  let byCategory: Array<{ category: string; spent: number }> = []
  if (sqlite) {
    monthlyRows = sqlite
      .prepare(
        `SELECT substr(date,1,7) AS month,
                ROUND(SUM(CASE WHEN amount > 0 AND category != 'Transfers' THEN amount ELSE 0 END),2) AS income,
                ROUND(-SUM(CASE WHEN amount < 0 AND category != 'Transfers' THEN amount ELSE 0 END),2) AS expense,
                SUM(CASE WHEN category != 'Transfers' THEN 1 ELSE 0 END) AS txns
         FROM finance_transactions GROUP BY month ORDER BY month DESC LIMIT ?`
      )
      .all(months) as typeof monthlyRows
    for (const m of monthlyRows) m.net = round(m.income - m.expense)
    byCategory = sqlite
      .prepare(
        `SELECT category, ROUND(-SUM(amount),2) AS spent FROM finance_transactions
         WHERE amount < 0 AND category != 'Transfers' AND substr(date,1,7) = ?
         GROUP BY category ORDER BY spent DESC`
      )
      .all(localYm()) as typeof byCategory
  }
  return {
    netWorth: {
      assets: round(assets),
      liabilities: round(liabilities),
      net: round(assets - liabilities)
    },
    accountCount: accounts.length,
    monthly: monthlyRows,
    currentMonth: { month: localYm(), byCategory },
    note: 'Aggregates only — no individual transactions or account numbers.'
  }
}

function proposeTask(db: Db, input: Record<string, unknown>): unknown {
  const title = str(input.title)
  if (!title) return { error: 'title is required' }
  const listType = str(input.listType) || 'daily'
  if (!LIST_TYPES.has(listType)) return { error: 'listType must be daily, weekly, or monthly' }
  const rawDate = str(input.listDate)
  if (rawDate && !isRealYmd(rawDate)) return { error: 'listDate must be a real YYYY-MM-DD date' }
  const listDate = rawDate || localYmd()
  const payload: Record<string, unknown> = { title, listType, listDate }
  if (str(input.category)) payload.category = str(input.category)
  if (str(input.body)) payload.body = str(input.body)
  const proposalId = randomUUID()
  db.insert(claudeProposals)
    .values({
      proposalId,
      type: 'task',
      payload: JSON.stringify(payload),
      source: 'ask-compass',
      status: 'pending',
      createdAt: new Date()
    })
    .run()
  return {
    proposed: true,
    proposalId,
    summary: `Add “${title}” to the ${listType} list (${listDate}) — pending your approval in the Claude Inbox.`
  }
}

/**
 * Execute a single tool call. Read tools return data; propose tools enqueue a
 * pending proposal (never mutate user data). Returns a tagged result so the
 * caller can feed `data` back to the model (or surface `error`).
 */
export function executeAssistantTool(
  db: Db,
  name: string,
  input: Record<string, unknown>
): ToolResult {
  try {
    switch (name) {
      case 'get_upcoming':
        return { ok: true, data: getUpcoming(db, input) }
      case 'get_finance_summary':
        return { ok: true, data: getFinanceSummary(db, input) }
      case 'propose_task': {
        const res = proposeTask(db, input) as Record<string, unknown>
        if ('error' in res) return { ok: false, error: String(res.error) }
        return { ok: true, data: res }
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export const _internal = { localYmd, localYm, isRealYmd }
