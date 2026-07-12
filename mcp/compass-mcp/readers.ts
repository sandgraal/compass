/**
 * Read-only query helpers for the expanded MCP surface (Phase 7 Track C).
 *
 * Pure functions over an injected better-sqlite3 handle so they're testable
 * with an in-memory DB — index.ts owns opening/closing the real `compass.db`
 * (read-only) per call, same as every other tool there.
 */
import type Database from 'better-sqlite3'
import { localYmd } from './dates.js'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
/** Range cap so a careless agent can't ask for years of tasks at once. */
export const MAX_TASK_RANGE_DAYS = 31
export const MAX_RECENT_NOTES = 50

export type TaskRange = { ok: true; from: string; to: string } | { ok: false; error: string }

/**
 * Normalize/validate a task date range. Defaults to today → today+6
 * (a rolling week — the gap the plan-my-week / weekly-review skills had).
 */
export function normalizeTaskRange(
  fromArg?: unknown,
  toArg?: unknown,
  now = new Date()
): TaskRange {
  const from = fromArg == null ? localYmd(now) : String(fromArg)
  const to =
    toArg == null ? localYmd(new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000)) : String(toArg)
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
    return { ok: false, error: 'from/to must be YYYY-MM-DD' }
  }
  if (to < from) return { ok: false, error: 'to must be on or after from' }
  const days =
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) /
      (24 * 60 * 60 * 1000) +
    1
  if (days > MAX_TASK_RANGE_DAYS) {
    return { ok: false, error: `range too large — max ${MAX_TASK_RANGE_DAYS} days` }
  }
  return { ok: true, from, to }
}

export interface TaskRow {
  id: number
  listDate: string
  title: string
  category: string | null
  checked: number
  source: string | null
}

/** Daily-checklist tasks across a date range, oldest day first. */
export function readTasksRange(
  db: Database.Database,
  from: string,
  to: string,
  includeChecked = true
): TaskRow[] {
  const base =
    'SELECT id, list_date AS listDate, title, category, checked, source FROM checklist_items ' +
    "WHERE list_type = 'daily' AND list_date >= ? AND list_date <= ?"
  const sql = includeChecked
    ? `${base} ORDER BY list_date, sort_order`
    : `${base} AND checked = 0 ORDER BY list_date, sort_order`
  return db.prepare(sql).all(from, to) as TaskRow[]
}

export interface RecentNoteRow {
  path: string
  title: string
  lastModified: number | null
  wordCount: number | null
}

/**
 * Most recently modified knowledge files (titles + paths only — bodies stay
 * behind compass_read_knowledge_file so the agent reads deliberately).
 */
export function readRecentNotes(db: Database.Database, limit = 10): RecentNoteRow[] {
  const capped = Math.max(1, Math.min(Math.floor(limit), MAX_RECENT_NOTES))
  return db
    .prepare(
      'SELECT path, title, last_modified AS lastModified, word_count AS wordCount ' +
        'FROM knowledge_files WHERE last_modified IS NOT NULL ORDER BY last_modified DESC LIMIT ?'
    )
    .all(capped) as RecentNoteRow[]
}

export interface TimelineSummary {
  total: number
  sources: Array<{ source: string; count: number }>
  kinds: Array<{ kind: string; count: number }>
  span: { earliestYear: number; latestYear: number } | null
  byYear: Array<{ year: number; count: number }>
}

const EMPTY_TIMELINE: TimelineSummary = { total: 0, sources: [], kinds: [], span: null, byYear: [] }

/**
 * Content-light summary of the unified `records` Timeline — counts by source and
 * kind, the UTC year span, and per-year totals. No raw records or titles here —
 * not as a boundary (readTimelineSearch returns full detail) but because this is
 * the shape-of-the-data view; keeping it content-light keeps it cheap and small.
 * Returns an empty summary when nothing's imported, or when the `records` table
 * doesn't exist yet (an older DB predating the Acquisition Engine migration).
 */
export function readTimelineSummary(db: Database.Database): TimelineSummary {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'")
    .get()
  if (!hasTable) return EMPTY_TIMELINE
  const total = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n
  if (total === 0) return EMPTY_TIMELINE

  const sources = db
    .prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source ORDER BY n DESC, source')
    .all() as Array<{ source: string; n: number }>
  const kinds = db
    .prepare('SELECT type, COUNT(*) AS n FROM records GROUP BY type ORDER BY n DESC, type')
    .all() as Array<{ type: string; n: number }>
  const span = db
    .prepare(
      'SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM records WHERE occurred_at IS NOT NULL'
    )
    .get() as { lo: number | null; hi: number | null }
  const byYear = db
    .prepare(
      "SELECT CAST(strftime('%Y', occurred_at / 1000, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS n " +
        'FROM records WHERE occurred_at IS NOT NULL GROUP BY year ORDER BY year'
    )
    .all() as Array<{ year: number; n: number }>

  return {
    total,
    sources: sources.map((r) => ({ source: r.source, count: r.n })),
    kinds: kinds.map((r) => ({ kind: r.type, count: r.n })),
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

export interface TimelineSearchHit {
  date: string | null
  source: string
  type: string
  title: string
  detail?: string
}

export interface TimelineSearchResult {
  query: string
  count: number
  records: TimelineSearchHit[]
  note?: string
}

export const TIMELINE_SEARCH_DEFAULT = 8
export const TIMELINE_SEARCH_MAX = 25
const TIMELINE_SEARCH_CHAR_BUDGET = 6000

/**
 * FTS5 MATCH builder — each whitespace token double-quoted (so operators/punctuation
 * are literal), last token prefix-matched. Mirrors electron/lib/records-search.ts
 * (duplicated because the MCP is a separate package that can't import `electron/`).
 */
function toFtsMatchQuery(q: string): string | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
  if (terms.length === 0) return null
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ')
}

function hasObject(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))
}

/** YYYY-MM-DD → epoch ms (UTC); `endOfDay` makes an inclusive upper bound. Ignores junk. */
function ymdMs(value: string | undefined, endOfDay: boolean): number | null {
  if (!value || !YMD_RE.test(value)) return null
  const base = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(base)) return null
  return endOfDay ? base + (86_400_000 - 1) : base
}

/**
 * Full-text search over the `records` Timeline, returning the ACTUAL matching
 * records (date, source, kind, title, short detail). Per the data-access policy
 * every domain lives on the spine, so this is the MCP's broadest read. Bounded
 * by a result cap + char budget; payload is never returned (raw import JSON —
 * noise, not a secrecy boundary). Empty/guarded when the FTS index or the
 * table is absent (older DB).
 */
/**
 * Firehose-tier sources excluded from search hits by default. KEEP IN SYNC
 * with `FIREHOSE_SOURCES` in `electron/lib/source-tiers.ts` (this package
 * can't import `electron/`, so the list is duplicated by design — like the
 * FTS SQL itself).
 */
const FIREHOSE_SOURCES = ['browser', 'generic', 'habit', 'task']

export function readTimelineSearch(
  db: Database.Database,
  opts: {
    q: string
    source?: string
    type?: string
    from?: string
    to?: string
    limit?: number
    includeFirehose?: boolean
  }
): TimelineSearchResult {
  const q = (opts.q ?? '').trim()
  const match = toFtsMatchQuery(q)
  if (!match) return { query: q, count: 0, records: [] }
  if (!hasObject(db, 'records') || !hasObject(db, 'records_fts')) {
    return { query: q, count: 0, records: [], note: 'Timeline search index not available.' }
  }
  const limit = Math.max(
    1,
    Math.min(Math.floor(opts.limit ?? TIMELINE_SEARCH_DEFAULT), TIMELINE_SEARCH_MAX)
  )
  // High-volume telemetry stays out of hits unless asked for — or unless the
  // caller explicitly filters to a firehose source.
  const excludeFirehose =
    !opts.includeFirehose && !(opts.source != null && FIREHOSE_SOURCES.includes(opts.source))
  const firehoseClause = excludeFirehose
    ? `AND r.source NOT IN (${FIREHOSE_SOURCES.map((s) => `'${s}'`).join(', ')})`
    : ''
  const rows = db
    .prepare(
      `SELECT r.occurred_at AS occurredAt, r.source AS source, r.type AS type,
              r.title AS title, r.body AS body,
              bm25(records_fts, 10.0, 5.0, 1.0) AS rank
         FROM records_fts
         JOIN records r ON r.id = records_fts.rowid
        WHERE records_fts MATCH @match
          AND (@source IS NULL OR r.source = @source)
          AND (@type   IS NULL OR r.type   = @type)
          AND (@from   IS NULL OR r.occurred_at >= @from)
          AND (@to     IS NULL OR r.occurred_at <= @to)
          ${firehoseClause}
        ORDER BY rank
        LIMIT @limit`
    )
    .all({
      match,
      source: opts.source ? String(opts.source) : null,
      type: opts.type ? String(opts.type) : null,
      from: ymdMs(opts.from, false),
      to: ymdMs(opts.to, true),
      limit
    }) as Array<{
    occurredAt: number | null
    source: string
    type: string
    title: string
    body: string | null
  }>

  const records: TimelineSearchHit[] = []
  let budget = TIMELINE_SEARCH_CHAR_BUDGET
  let truncated = false
  for (const r of rows) {
    const date = r.occurredAt != null ? new Date(r.occurredAt).toISOString().slice(0, 10) : null
    const detail = r.body ? r.body.slice(0, 200) : undefined
    const cost = r.title.length + (detail?.length ?? 0) + r.source.length + r.type.length + 20
    if (budget - cost < 0 && records.length > 0) {
      truncated = true
      break
    }
    budget -= cost
    records.push({
      date,
      source: r.source,
      type: r.type,
      title: r.title,
      ...(detail ? { detail } : {})
    })
  }
  const result: TimelineSearchResult = { query: q, count: records.length, records }
  // A full page (hit the limit) or a char-budget cut means there are likely more.
  if (truncated || rows.length >= limit) {
    result.note = 'Showing the top matches — add a source/kind/date filter or refine the query.'
  }
  return result
}

// ── Full-detail readers (data-access policy) ─────────────────────────────────
// Every domain is readable in detail. The exclusions live elsewhere: raw GPS
// never enters the DB tables these read, and the vault isn't reachable from
// this process at all (no Keychain — vault documents are in-app-assistant-only).

const YM_RE = /^\d{4}-\d{2}$/

export interface TransactionsResult {
  count: number
  transactions: Array<Record<string, unknown>>
  note?: string
  error?: string
}

export const TRANSACTIONS_DEFAULT = 20
export const TRANSACTIONS_MAX = 50

/** Individual finance transactions, newest first, with month/range/category/substring filters. */
export function readTransactions(
  db: Database.Database,
  opts: {
    from?: string
    to?: string
    month?: string
    category?: string
    q?: string
    limit?: number
  }
): TransactionsResult {
  if (!hasObject(db, 'finance_transactions')) {
    return { count: 0, transactions: [], note: 'No finance data yet.' }
  }
  const month = opts.month?.trim() || null
  if (month && !YM_RE.test(month))
    return { count: 0, transactions: [], error: 'month must be YYYY-MM' }
  const from = month ? null : opts.from?.trim() || null
  const to = month ? null : opts.to?.trim() || null
  if (from && !YMD_RE.test(from))
    return { count: 0, transactions: [], error: 'from must be YYYY-MM-DD' }
  if (to && !YMD_RE.test(to)) return { count: 0, transactions: [], error: 'to must be YYYY-MM-DD' }
  const limit = Math.max(
    1,
    Math.min(Math.floor(opts.limit ?? TRANSACTIONS_DEFAULT), TRANSACTIONS_MAX)
  )
  const rows = db
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
      month,
      from,
      to,
      category: opts.category?.trim() || null,
      q: opts.q?.trim() || null,
      limit
    }) as Array<Record<string, unknown>>
  const result: TransactionsResult = { count: rows.length, transactions: rows }
  if (rows.length >= limit) {
    result.note = 'Hit the limit — narrow with month/category/q or raise limit (max 50).'
  }
  return result
}

export interface ContactHit {
  id: number
  displayName: string
  org: string | null
  jobTitle: string | null
  relationship: string | null
}

export const CONTACTS_MAX = 25
export const CONTACT_QUERY_MAX = 200

/**
 * Address-book search over the precomputed search blob (name/org/email/phone/
 * nickname). Explicit column list — never photo (a data URI) or enrichment.
 */
export function readContacts(db: Database.Database, q: string, limit = 10): ContactHit[] {
  if (!hasObject(db, 'contacts')) return []
  const needle = q.slice(0, CONTACT_QUERY_MAX).trim().toLowerCase()
  if (!needle) return []
  const capped = Math.max(1, Math.min(Math.floor(limit), CONTACTS_MAX))
  return db
    .prepare(
      `SELECT id, display_name AS displayName, org, job_title AS jobTitle, relationship
         FROM contacts WHERE search_blob LIKE ? ORDER BY display_name LIMIT ?`
    )
    .all(`%${needle}%`, capped) as ContactHit[]
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

export interface MedicalRecordsResult {
  count: number
  records: Array<Record<string, unknown>>
  error?: string
}

export const MEDICAL_MAX = 100

/** Full clinical rows (description, code, status, date) with optional filters. */
export function readMedicalRecords(
  db: Database.Database,
  opts: { category?: string; status?: string; limit?: number }
): MedicalRecordsResult {
  if (!hasObject(db, 'medical_records')) return { count: 0, records: [] }
  const category = opts.category?.trim() || null
  if (category && !MEDICAL_CATEGORIES.has(category)) {
    return {
      count: 0,
      records: [],
      error: `category must be one of: ${[...MEDICAL_CATEGORIES].join(', ')}`
    }
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50), MEDICAL_MAX))
  const rows = db
    .prepare(
      `SELECT category, description, code, status, recorded_at AS recordedAt
         FROM medical_records
        WHERE (@category IS NULL OR category = @category)
          AND (@status IS NULL OR status = @status COLLATE NOCASE)
        ORDER BY recorded_at IS NULL, recorded_at DESC LIMIT @limit`
    )
    .all({ category, status: opts.status?.trim() || null, limit }) as Array<Record<string, unknown>>
  return { count: rows.length, records: rows }
}

export interface PaystubsResult {
  paystubs: Array<Record<string, unknown>>
  totals: Record<string, unknown> | null
  note: string
}

export const PAYSTUBS_MAX = 36

/** Per-paystub rows newest-first plus running totals. */
export function readPaystubs(db: Database.Database, limit = 12): PaystubsResult {
  const note = 'Withholding/deductions are summed per stub — per-tax line detail is never stored.'
  if (!hasObject(db, 'argyle_paystubs')) return { paystubs: [], totals: null, note }
  const capped = Math.max(1, Math.min(Math.floor(limit), PAYSTUBS_MAX))
  const rows = db
    .prepare(
      `SELECT employer, gross_pay AS grossPay, net_pay AS netPay, withholding, deductions,
              currency, period_start AS periodStart, period_end AS periodEnd, paid_at AS paidAt
         FROM argyle_paystubs
        ORDER BY paid_at IS NULL, paid_at DESC LIMIT ?`
    )
    .all(capped) as Array<Record<string, unknown>>
  const totals = db
    .prepare(
      'SELECT COUNT(*) AS count, ROUND(SUM(net_pay),2) AS totalNet, ROUND(SUM(gross_pay),2) AS totalGross FROM argyle_paystubs'
    )
    .get() as Record<string, unknown>
  return { paystubs: rows, totals, note }
}
