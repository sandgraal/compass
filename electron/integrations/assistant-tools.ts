/**
 * Tools the embedded Claude agent ("Ask Compass", Phase 8.5) can call over the
 * user's local data. Two kinds:
 *
 *   - READ tools answer questions from `compass.db` — per the data-access
 *     policy (docs/data-access-policy.md) they see EVERY domain in full
 *     detail: raw transactions, medical records, contacts, paystubs, the
 *     records spine, and the vault DOCUMENT categories. The only things
 *     sealed everywhere: the vault `credentials` category + token vaults
 *     (access keys, not life data) and raw GPS coordinates.
 *   - PROPOSE tools never mutate anything; they enqueue a `pending` row in
 *     `claude_proposals`, exactly like the MCP propose tools, so the change
 *     surfaces in the Claude Inbox for human approval.
 *
 * `executeAssistantTool` is pure w.r.t. the model — it takes a db handle + the
 * tool name/input (+ optional injected VaultReader) and returns a
 * JSON-serialisable result — so it unit-tests against an in-memory SQLite
 * without any network or keychain.
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { and, asc, eq, gte, like, lte } from 'drizzle-orm'
import type { getDb } from '../db/client'
import {
  appSettings,
  calendarEvents,
  checklistItems,
  claudeProposals,
  contacts,
  financeAccounts
} from '../db/schema'
import { buildInsights } from '../ipc/insights'
import { searchRecords } from '../lib/records-search'

type Db = ReturnType<typeof getDb>
type RawSqlite = BetterSqlite3.Database

/**
 * Vault access injected by the caller (electron/ipc/assistant.ts wires the
 * real decrypt-in-memory reader; tests pass a fake). Absent ⇒ the vault
 * tools return a clean "vault unavailable" error. Only the document
 * categories below are ever readable — `readCategory` is never called with
 * `credentials`.
 */
export interface VaultReader {
  readCategory(category: string): Array<Record<string, unknown>>
}
export interface AssistantToolDeps {
  vault?: VaultReader
}

/** Vault document categories readable by the assistant. `credentials` is sealed. */
export const VAULT_DOC_CATEGORIES = [
  'financial',
  'identity',
  'medical',
  'legal',
  'foreign-accounts'
] as const
const VAULT_DOC_SET = new Set<string>(VAULT_DOC_CATEGORIES)

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
      'Read the AGGREGATE finance picture — net worth (assets/liabilities), per-month income/expense/net for the last N months, and current-month spend by category. The convenient rollup view; for individual transactions use list_transactions. Read-only.',
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
    name: 'list_transactions',
    description:
      'Read individual finance transactions — date, amount, currency, description (merchant/payee), category. Filter by a date range, a single month, a category, and/or a description substring. Use for "what did I spend at X", "list my June charges", "when did I last pay Y". Newest first. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        month: { type: 'string', description: 'Single month YYYY-MM (overrides from/to)' },
        category: { type: 'string', description: 'Exact category, e.g. "Dining"' },
        q: { type: 'string', description: 'Description substring, e.g. a merchant name' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max transactions (default 20)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_contacts',
    description:
      "Search the user's address book by name, organization, email, phone, or nickname. Returns matching contacts (id, name, org, title, relationship). Use get_contact with an id for the full card. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search text' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max results (default 10)' }
      },
      required: ['q'],
      additionalProperties: false
    }
  },
  {
    name: 'get_contact',
    description:
      'Read one full contact card by id (from search_contacts): names, org/title, emails, phones, addresses, birthday, URL, relationship, notes, and the cross-source summary of how the user knows them. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Contact id from search_contacts' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_medical_records',
    description:
      "Read the user's clinical records in full detail — conditions, medications, labs, immunizations, allergies, encounters, procedures — each with description, code (ICD-10/RxNorm/LOINC/CVX), status, and date. Optional category/status filters. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'condition',
            'medication',
            'lab',
            'immunization',
            'allergy',
            'encounter',
            'procedure'
          ],
          description: 'Optional: one clinical category'
        },
        status: { type: 'string', description: 'Optional: e.g. "active", "resolved"' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max records (default 50)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_paystubs',
    description:
      "Read the user's payroll paystubs — employer, gross/net pay, summed withholding and deductions, pay period, deposit date — newest first, plus totals. (Per-tax line detail is never stored.) Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 36,
          description: 'Max paystubs (default 12)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_vault',
    description:
      'Search the encrypted vault DOCUMENT categories (financial, identity, medical, legal, foreign-accounts) by any field value — e.g. "find my passport number", "which policy covers dental". Returns matching entries with the matched field. The credentials category (passwords, API keys) is permanently sealed and cannot be searched or read. Read-only; decryption happens in memory per call.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search text' },
        category: {
          type: 'string',
          enum: ['financial', 'identity', 'medical', 'legal', 'foreign-accounts'],
          description: 'Optional: restrict to one document category'
        }
      },
      required: ['q'],
      additionalProperties: false
    }
  },
  {
    name: 'get_vault_entry',
    description:
      'Read one full vault document entry by category + id (from search_vault) — every field, e.g. the passport number, policy details, account identifiers. The credentials category is permanently sealed. Read-only; decryption happens in memory per call.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['financial', 'identity', 'medical', 'legal', 'foreign-accounts']
        },
        id: { type: 'string', description: 'Entry id from search_vault' }
      },
      required: ['category', 'id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_week_tasks',
    description:
      'Read daily-checklist tasks across a date range (default: today through 6 days ahead — a rolling week; max 31 days). Includes done/undone state per task. Use this for weekly planning instead of guessing. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default today)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD inclusive (default today+6)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_weekly_goals',
    description:
      "Read the user's weekly goals for the week containing the given date (weeks start Monday; default this week). Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Any YYYY-MM-DD inside the target week (default today)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_habit_streaks',
    description:
      'Read each active habit with its current streak (consecutive days, ending today or yesterday) and longest streak. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_insights',
    description:
      "Read Compass's proactive insights — spending anomalies, uncategorized-spend buildup, habit slippage, stale notes (same data as the Dashboard 'Worth a look' card). Useful context when planning. Read-only.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_timeline',
    description:
      'Summarize the user\'s unified life Timeline — records imported from all their data sources (purchases, media watched/listened, messages, documents, health, credit/tax, and more). Returns AGGREGATES (total, counts by source and kind, the year span, per-year totals). Use for shape-of-the-data questions like "how far back does my data go", "what have I imported", "how much data do I have and what kind", or "how active was I in <year>". To read the actual matching records, use search_records. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'search_records',
    description:
      'Search the user\'s unified life Timeline — the ACTUAL records from every domain (purchases, media, messages, documents, health, medical, habits, tasks, trips, paychecks, bills, goals, credit/tax, connections, facts, and more) — and return the matching records themselves (date, source, kind, title, short detail). Use this for "what/when did I…" questions: "when did I last watch X", "what did I buy from Y", "find anything about Z", "what was I doing in <month/year>". Supports optional source/kind filters and a from/to date range (YYYY-MM-DD). The one exclusion: raw GPS coordinates are never on the timeline (country-level trips are). Read-only. (For totals/counts by source or year, use get_timeline.)',
    input_schema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Search text — matches record titles + details, last word prefix-matched'
        },
        source: { type: 'string', description: 'Optional: one source, e.g. "amazon", "linkedin"' },
        type: {
          type: 'string',
          description: 'Optional: one kind, e.g. "order", "watch", "connection"'
        },
        from: { type: 'string', description: 'Optional start date YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'Optional end date YYYY-MM-DD (inclusive)' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max records (default 8)' },
        includeFirehose: {
          type: 'boolean',
          description:
            'Include high-volume telemetry sources (raw browser history, routine habit/task checks). Off by default so they never bury the meaningful records; a source filter naming one of them works regardless.'
        }
      },
      required: ['q'],
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
    .orderBy(asc(checklistItems.sortOrder))
    .all()
  const eventRows = db
    .select({
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      location: calendarEvents.location
    })
    .from(calendarEvents)
    .where(
      and(gte(calendarEvents.startAt, new Date(now)), lte(calendarEvents.startAt, new Date(cutoff)))
    )
    .orderBy(asc(calendarEvents.startAt))
    .all()
  // Normalize the timestamp to a JSON primitive (epoch ms) — matches the MCP's
  // `compass_upcoming` shape rather than leaking a Date/ISO string.
  const events = eventRows.map((e) => ({
    title: e.title,
    startAtMs: e.startAt ? e.startAt.getTime() : null,
    location: e.location
  }))
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

function getFinanceSummary(db: Db, sqlite: RawSqlite, input: Record<string, unknown>): unknown {
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
  // so run the monthly + by-category aggregates as raw prepared statements on the
  // injected better-sqlite3 handle. (Mirrors mcp/compass-mcp finance SQL.)
  let monthlyRows: Array<{
    month: string
    income: number
    expense: number
    txns: number
    net?: number
  }> = []
  let byCategory: Array<{ category: string; spent: number }> = []
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
  return {
    netWorth: {
      assets: round(assets),
      liabilities: round(liabilities),
      net: round(assets - liabilities)
    },
    accountCount: accounts.length,
    monthly: monthlyRows,
    currentMonth: { month: localYm(), byCategory },
    note: 'Aggregate rollup — use list_transactions for individual transactions.'
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt))
}

function listTransactions(sqlite: RawSqlite, input: Record<string, unknown>): unknown {
  const limit = clampInt(input.limit, 1, 50, 20)
  const month = str(input.month)
  if (month && !/^\d{4}-\d{2}$/.test(month)) return { error: 'month must be YYYY-MM' }
  let from = str(input.from)
  let to = str(input.to)
  if (month) {
    from = ''
    to = ''
  }
  if (from && !isRealYmd(from)) return { error: 'from must be a real YYYY-MM-DD date' }
  if (to && !isRealYmd(to)) return { error: 'to must be a real YYYY-MM-DD date' }
  const q = str(input.q)
  const category = str(input.category)
  const rows = sqlite
    .prepare(
      `SELECT date, amount, currency, description, category FROM finance_transactions
        WHERE (@month IS NULL OR substr(date,1,7) = @month)
          AND (@from IS NULL OR date >= @from)
          AND (@to IS NULL OR date <= @to)
          AND (@category IS NULL OR category = @category)
          AND (@q IS NULL OR instr(lower(description), lower(@q)) > 0)
        ORDER BY date DESC, id DESC LIMIT @limit`
    )
    .all({
      month: month || null,
      from: from || null,
      to: to || null,
      category: category || null,
      q: q || null,
      limit
    }) as Array<Record<string, unknown>>
  const result: Record<string, unknown> = { count: rows.length, transactions: rows }
  if (rows.length >= limit) {
    result.note = 'Hit the limit — narrow with month/category/q or raise limit (max 50).'
  }
  return result
}

function searchContactsTool(db: Db, input: Record<string, unknown>): unknown {
  const q = str(input.q).slice(0, 200).toLowerCase()
  if (!q) return { error: 'q (search text) is required' }
  const limit = clampInt(input.limit, 1, 25, 10)
  // Same searchBlob LIKE idiom as contacts:list / ⌘K — never photo/enrichment
  // in the list shape.
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      org: contacts.org,
      jobTitle: contacts.jobTitle,
      relationship: contacts.relationship
    })
    .from(contacts)
    .where(like(contacts.searchBlob, `%${q}%`))
    .limit(limit)
    .all()
  return { query: q, count: rows.length, contacts: rows }
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getContact(db: Db, input: Record<string, unknown>): unknown {
  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) return { error: 'id must be a positive integer' }
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get()
  if (!row) return { error: `No contact with id ${id}` }
  // Full card minus the heavyweight/non-conversational fields: photo (a data
  // URI) and searchBlob (an index). Enrichment is reduced to its cross-source
  // summary — how the user knows this person.
  let crossSource: unknown = null
  try {
    const parsed = row.enrichment ? (JSON.parse(row.enrichment) as Record<string, unknown>) : null
    crossSource = parsed?.crossSource ?? null
  } catch {
    /* malformed enrichment JSON → omit */
  }
  return {
    id: row.id,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    org: row.org,
    jobTitle: row.jobTitle,
    phones: parseJsonArray(row.phones),
    emails: parseJsonArray(row.emails),
    addresses: parseJsonArray(row.addresses),
    birthday: row.birthday,
    url: row.url,
    relationship: row.relationship,
    notes: row.notes,
    source: row.source,
    crossSource
  }
}

const MEDICAL_CATEGORIES = new Set([
  'condition',
  'medication',
  'lab',
  'immunization',
  'allergy',
  'encounter',
  'procedure'
])

function getMedicalRecords(sqlite: RawSqlite, input: Record<string, unknown>): unknown {
  const category = str(input.category)
  if (category && !MEDICAL_CATEGORIES.has(category)) {
    return { error: `category must be one of: ${[...MEDICAL_CATEGORIES].join(', ')}` }
  }
  const status = str(input.status)
  const limit = clampInt(input.limit, 1, 100, 50)
  const rows = sqlite
    .prepare(
      `SELECT category, description, code, status, recorded_at AS recordedAt
         FROM medical_records
        WHERE (@category IS NULL OR category = @category)
          AND (@status IS NULL OR status = @status COLLATE NOCASE)
        ORDER BY recorded_at IS NULL, recorded_at DESC LIMIT @limit`
    )
    .all({ category: category || null, status: status || null, limit }) as Array<
    Record<string, unknown>
  >
  return { count: rows.length, records: rows }
}

function getPaystubs(sqlite: RawSqlite, input: Record<string, unknown>): unknown {
  const limit = clampInt(input.limit, 1, 36, 12)
  const rows = sqlite
    .prepare(
      `SELECT employer, gross_pay AS grossPay, net_pay AS netPay, withholding, deductions,
              currency, period_start AS periodStart, period_end AS periodEnd, paid_at AS paidAt
         FROM argyle_paystubs
        ORDER BY paid_at IS NULL, paid_at DESC LIMIT ?`
    )
    .all(limit) as Array<{ netPay: number | null; grossPay: number | null }>
  const totals = sqlite
    .prepare(
      'SELECT COUNT(*) AS count, ROUND(SUM(net_pay),2) AS totalNet, ROUND(SUM(gross_pay),2) AS totalGross FROM argyle_paystubs'
    )
    .get()
  return {
    paystubs: rows,
    totals,
    note: 'Withholding/deductions are summed per stub — per-tax line detail is never stored.'
  }
}

const VAULT_SEARCH_MAX = 20

function searchVaultTool(deps: AssistantToolDeps, input: Record<string, unknown>): unknown {
  if (!deps.vault) return { error: 'Vault unavailable in this context.' }
  const q = str(input.q).slice(0, 200).toLowerCase()
  if (!q) return { error: 'q (search text) is required' }
  const catFilter = str(input.category)
  if (catFilter === 'credentials') {
    return {
      error:
        'The credentials category (passwords, API keys) is permanently sealed — the assistant can never search or read it.'
    }
  }
  if (catFilter && !VAULT_DOC_SET.has(catFilter)) {
    return { error: `Unknown vault document category: ${catFilter}` }
  }
  const categories = catFilter ? [catFilter] : [...VAULT_DOC_CATEGORIES]
  const entriesOut: Array<Record<string, unknown>> = []
  for (const category of categories) {
    let entries: Array<Record<string, unknown>>
    try {
      entries = deps.vault.readCategory(category)
    } catch {
      continue // category file corrupt/unreadable — skip, keep searching the rest
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const id = typeof entry.id === 'string' ? entry.id : null
      if (!id) continue
      for (const [field, value] of Object.entries(entry)) {
        if (field === 'id' || typeof value !== 'string') continue
        if (!value.toLowerCase().includes(q)) continue
        entriesOut.push({ category, id, matchedField: field, value: value.slice(0, 200) })
        break // one hit per entry
      }
      if (entriesOut.length >= VAULT_SEARCH_MAX) break
    }
    if (entriesOut.length >= VAULT_SEARCH_MAX) break
  }
  return {
    query: q,
    count: entriesOut.length,
    entries: entriesOut,
    note: 'Use get_vault_entry(category, id) to read a full entry.'
  }
}

function getVaultEntry(deps: AssistantToolDeps, input: Record<string, unknown>): unknown {
  if (!deps.vault) return { error: 'Vault unavailable in this context.' }
  const category = str(input.category)
  if (category === 'credentials') {
    return {
      error:
        'The credentials category (passwords, API keys) is permanently sealed — the assistant can never search or read it.'
    }
  }
  if (!VAULT_DOC_SET.has(category)) {
    return { error: `category must be one of: ${VAULT_DOC_CATEGORIES.join(', ')}` }
  }
  const id = str(input.id)
  if (!id) return { error: 'id is required (from search_vault)' }
  let entries: Array<Record<string, unknown>>
  try {
    entries = deps.vault.readCategory(category)
  } catch {
    return { error: `Could not read the ${category} vault category.` }
  }
  const entry = entries.find((e) => e && typeof e === 'object' && e.id === id)
  if (!entry) return { error: `No ${category} entry with id ${id}` }
  // Full entry minus `_history` (prior versions — bulk noise for the model).
  const { _history, ...fields } = entry
  return { category, entry: fields }
}

const MAX_WEEK_TASK_RANGE_DAYS = 31

function getWeekTasks(db: Db, input: Record<string, unknown>): unknown {
  const now = new Date()
  const from = str(input.from) || localYmd(now)
  const to = str(input.to) || localYmd(new Date(now.getTime() + 6 * DAY_MS))
  if (!isRealYmd(from) || !isRealYmd(to)) return { error: 'from/to must be real YYYY-MM-DD dates' }
  if (to < from) return { error: 'to must be on or after from' }
  const days =
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS + 1
  if (days > MAX_WEEK_TASK_RANGE_DAYS) {
    return { error: `range too large — max ${MAX_WEEK_TASK_RANGE_DAYS} days` }
  }
  const tasks = db
    .select({
      listDate: checklistItems.listDate,
      title: checklistItems.title,
      checked: checklistItems.checked,
      category: checklistItems.category,
      source: checklistItems.source
    })
    .from(checklistItems)
    .where(
      and(
        eq(checklistItems.listType, 'daily'),
        gte(checklistItems.listDate, from),
        lte(checklistItems.listDate, to)
      )
    )
    .orderBy(asc(checklistItems.listDate), asc(checklistItems.sortOrder))
    .all()
  return { from, to, tasks }
}

/** Monday of the week containing the given local day — matches Weekly.tsx's weekKey. */
function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localYmd(d)
}

function getWeeklyGoals(db: Db, input: Record<string, unknown>): unknown {
  const date = str(input.date) || localYmd()
  if (!isRealYmd(date)) return { error: 'date must be a real YYYY-MM-DD date' }
  const weekStart = mondayOf(date)
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, `weekly_goals_${weekStart}`))
    .get()
  let goals: string[] = []
  try {
    const parsed: unknown = row?.value ? JSON.parse(row.value) : []
    if (Array.isArray(parsed)) {
      goals = parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    }
  } catch {
    /* malformed stored JSON → treat as no goals */
  }
  return { weekStart, goals }
}

function getHabitStreaks(sqlite: RawSqlite): unknown {
  // Mirrors mcp/compass-mcp's compass_habit_streaks (same local-day semantics
  // as src/lib/habit-streaks.ts): current streak may end today OR yesterday so
  // an as-yet-unchecked today doesn't read as broken.
  const habits = sqlite
    .prepare('SELECT id, name FROM habits WHERE active = 1 ORDER BY id')
    .all() as Array<{ id: number; name: string }>
  const entryStmt = sqlite.prepare(
    'SELECT date FROM habit_entries WHERE habit_id = ? AND completed = 1'
  )
  return habits.map((h) => {
    const days = new Set((entryStmt.all(h.id) as Array<{ date: string }>).map((r) => r.date))
    let current = 0
    const cursor = new Date()
    if (!days.has(localYmd(cursor))) cursor.setDate(cursor.getDate() - 1)
    while (days.has(localYmd(cursor))) {
      current++
      cursor.setDate(cursor.getDate() - 1)
    }
    let longest = 0
    let run = 0
    let prev: number | null = null
    for (const d of [...days].sort()) {
      const t = new Date(`${d}T00:00:00Z`).getTime()
      run = prev !== null && t - prev === DAY_MS ? run + 1 : 1
      if (run > longest) longest = run
      prev = t
    }
    return { name: h.name, current, longest }
  })
}

/** Record-search caps — the user opted in to raw record content, so safety is
 * bounding, not redaction: a capped count + total char budget keep a broad query
 * from blowing the agent's small token window. Payload is never returned. */
const RECORD_SEARCH_DEFAULT = 8
const RECORD_SEARCH_MAX = 25
const RECORD_SEARCH_CHAR_BUDGET = 6000

/** YYYY-MM-DD → epoch ms (UTC). `endOfDay` pushes to 23:59:59.999 for an inclusive `to`. */
function ymdToMs(value: string, endOfDay: boolean): number | null {
  if (!isRealYmd(value)) return null
  const base = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(base)) return null
  return endOfDay ? base + (DAY_MS - 1) : base
}

/**
 * Full-text search over the `records` Timeline, returning the ACTUAL matching
 * records (date, source, kind, title, short detail). Per the data-access
 * policy every domain lives on the spine, so this is the assistant's broadest
 * read. Bounded by a result cap + char budget; payload is never returned
 * (it's raw import JSON — noise for the model, not a secrecy boundary).
 */
function searchRecordsTool(sqlite: RawSqlite, input: Record<string, unknown>): unknown {
  const q = str(input.q)
  if (!q) return { error: 'q (search text) is required' }
  const limit = Math.min(
    RECORD_SEARCH_MAX,
    Math.max(1, Number.isFinite(Number(input.limit)) ? Number(input.limit) : RECORD_SEARCH_DEFAULT)
  )
  const fromRaw = str(input.from)
  const toRaw = str(input.to)
  const from = fromRaw ? ymdToMs(fromRaw, false) : null
  const to = toRaw ? ymdToMs(toRaw, true) : null
  if (fromRaw && from == null) return { error: 'from must be a real YYYY-MM-DD date' }
  if (toRaw && to == null) return { error: 'to must be a real YYYY-MM-DD date' }
  const hits = searchRecords(sqlite, {
    q,
    source: str(input.source) || undefined,
    type: str(input.type) || undefined,
    from,
    to,
    limit,
    includeFirehose: input.includeFirehose === true
  })
  const out: Array<{
    date: string | null
    source: string
    type: string
    title: string
    detail?: string
  }> = []
  let budget = RECORD_SEARCH_CHAR_BUDGET
  let truncated = false
  for (const h of hits) {
    const date = h.occurredAt != null ? new Date(h.occurredAt).toISOString().slice(0, 10) : null
    const detail = h.body ? h.body.slice(0, 200) : undefined
    const cost = h.title.length + (detail?.length ?? 0) + h.source.length + h.type.length + 20
    if (budget - cost < 0 && out.length > 0) {
      truncated = true
      break
    }
    budget -= cost
    out.push({
      date,
      source: h.source,
      type: h.type,
      title: h.title,
      ...(detail ? { detail } : {})
    })
  }
  const result: Record<string, unknown> = { query: q, count: out.length, records: out }
  // A full page (hit the limit) or a char-budget cut means there are likely more.
  if (truncated || hits.length >= limit) {
    result.note =
      'Showing the top matches — add a source/kind/date filter or a more specific query to narrow.'
  }
  return result
}

/**
 * Summarize the unified `records` Timeline for the assistant — AGGREGATES (counts
 * by source/kind/year + the span). Detailed per-record reads go through
 * `search_records`; this stays the shape-of-the-data view. Year buckets use UTC to
 * match the Timeline header + overview.md.
 */
function getTimeline(sqlite: RawSqlite): unknown {
  const total = (sqlite.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n
  if (total === 0) {
    return {
      total: 0,
      note: 'No Timeline records imported yet — drop an export on the Timeline page.'
    }
  }
  const sources = sqlite
    .prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source ORDER BY n DESC, source')
    .all() as Array<{ source: string; n: number }>
  const types = sqlite
    .prepare('SELECT type, COUNT(*) AS n FROM records GROUP BY type ORDER BY n DESC, type')
    .all() as Array<{ type: string; n: number }>
  const span = sqlite
    .prepare(
      'SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM records WHERE occurred_at IS NOT NULL'
    )
    .get() as { lo: number | null; hi: number | null }
  const byYear = sqlite
    .prepare(
      "SELECT CAST(strftime('%Y', occurred_at / 1000, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS n " +
        'FROM records WHERE occurred_at IS NOT NULL GROUP BY year ORDER BY year'
    )
    .all() as Array<{ year: number; n: number }>
  return {
    total,
    sources: sources.map((r) => ({ source: r.source, count: r.n })),
    kinds: types.map((r) => ({ kind: r.type, count: r.n })),
    span:
      span.lo != null && span.hi != null
        ? {
            earliestYear: new Date(span.lo).getUTCFullYear(),
            latestYear: new Date(span.hi).getUTCFullYear()
          }
        : null,
    byYear: byYear.map((r) => ({ year: r.year, count: r.n }))
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
 * caller can feed `data` back to the model (or surface `error`). `deps`
 * carries capabilities only the production wiring can provide (the vault
 * reader); when absent those tools fail cleanly.
 */
export function executeAssistantTool(
  db: Db,
  sqlite: RawSqlite,
  name: string,
  input: Record<string, unknown>,
  deps: AssistantToolDeps = {}
): ToolResult {
  const asResult = (res: unknown): ToolResult => {
    const rec = res as Record<string, unknown>
    if (rec && typeof rec === 'object' && 'error' in rec) {
      return { ok: false, error: String(rec.error) }
    }
    return { ok: true, data: res }
  }
  try {
    switch (name) {
      case 'get_upcoming':
        return { ok: true, data: getUpcoming(db, input) }
      case 'get_finance_summary':
        return { ok: true, data: getFinanceSummary(db, sqlite, input) }
      case 'list_transactions':
        return asResult(listTransactions(sqlite, input))
      case 'search_contacts':
        return asResult(searchContactsTool(db, input))
      case 'get_contact':
        return asResult(getContact(db, input))
      case 'get_medical_records':
        return asResult(getMedicalRecords(sqlite, input))
      case 'get_paystubs':
        return asResult(getPaystubs(sqlite, input))
      case 'search_vault':
        return asResult(searchVaultTool(deps, input))
      case 'get_vault_entry':
        return asResult(getVaultEntry(deps, input))
      case 'get_week_tasks': {
        const res = getWeekTasks(db, input) as Record<string, unknown>
        if ('error' in res) return { ok: false, error: String(res.error) }
        return { ok: true, data: res }
      }
      case 'get_weekly_goals': {
        const res = getWeeklyGoals(db, input) as Record<string, unknown>
        if ('error' in res) return { ok: false, error: String(res.error) }
        return { ok: true, data: res }
      }
      case 'get_habit_streaks':
        return { ok: true, data: getHabitStreaks(sqlite) }
      case 'get_insights':
        return { ok: true, data: buildInsights(db).insights }
      case 'get_timeline':
        return { ok: true, data: getTimeline(sqlite) }
      case 'search_records': {
        const res = searchRecordsTool(sqlite, input) as Record<string, unknown>
        if ('error' in res) return { ok: false, error: String(res.error) }
        return { ok: true, data: res }
      }
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
