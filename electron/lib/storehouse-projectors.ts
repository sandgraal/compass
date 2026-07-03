/**
 * Storehouse projectors — turn LIVE-integration data into `records` rows.
 *
 * Compass's cross-reference engine (People / Merchants / Places / Subscriptions /
 * Timeline / Search / On-this-day) is driven entirely by the append-only `records`
 * timeline. File imports feed it through the recognizer registry; live integrations
 * historically did NOT — they wrote only to their own domain tables and never
 * entered the spine. These projectors close that gap: each `project<Source>(rows)`
 * maps a domain table into `RecordInput[]`, so a synced transaction behaves exactly
 * like an imported one.
 *
 * Every projector is PURE (no DB, no Electron) and individually testable against
 * plain row arrays. The impure read-insert-refresh orchestration lives in
 * `electron/ipc/storehouse-sync.ts`.
 *
 * Idempotency is inherited, not reimplemented: `naturalKey` reuses each table's
 * existing unique key (finance `hash`, etc.) so `hashRecord()` → `records.dedupHash`
 * UNIQUE → `insertRecords`'s `onConflictDoNothing` make whole-table re-projection on
 * every sync a no-op for rows already present.
 */
import type { RecordInput } from './recognizers'

/**
 * A finance transaction reduced to the fields the projector needs. Matches the
 * normalized columns of `finance_transactions` (schema.ts) — NOT the raw import.
 */
export interface FinanceTxnRow {
  hash: string
  date: string // ISO 'YYYY-MM-DD' (a LOCAL day, per the finance date idiom)
  amount: number // signed; negative = expense
  currency: string | null // ISO 4217; defaults to USD when absent
  description: string // merchant / payee
  category: string | null
}

/** Parse a finance `date` ('YYYY-MM-DD') as a LOCAL-day epoch ms, or null. */
function localDayMs(date: string): number | null {
  // `${date}T00:00:00` (no Z) parses in local time — matches the rest of the app's
  // treatment of date-only finance columns as local days, avoiding UTC off-by-one.
  const t = new Date(`${date}T00:00:00`).getTime()
  return Number.isFinite(t) ? t : null
}

/** Parse an ISO-8601 timestamp (e.g. GitHub/Linear `updated_at`) to epoch ms, or null. */
function isoMs(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * Format the money segment so `parseMoney` (entities.ts) reads it back: it looks at
 * the FIRST ' · '-separated body segment and matches an optional leading '-', digits,
 * and an optional 3-letter code — e.g. "-25.00 USD". The sign carries the
 * expense/income direction; the currency lets a CR colón charge report its true code.
 */
function moneySegment(amount: number, currency: string | null): string {
  const cur = (currency || 'USD').toUpperCase()
  // toFixed(2) keeps a leading '-' for expenses; positive amounts stay unsigned.
  return `${amount.toFixed(2)} ${cur}`
}

/**
 * Project `finance_transactions` → records (`source:'finance'`, `type:'txn'`).
 *
 * body = "<amount> <CUR> · <category>" so the `finance-merchant` extractor's
 * `parseMoney(body)` recovers the spend; title = the merchant/payee description so
 * the extractor derives the merchant name from it.
 */
export function projectFinanceTransactions(rows: FinanceTxnRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.hash) continue // no stable key → skip (can't dedupe safely)
    const title = r.description?.trim() || 'Transaction'
    const category = r.category?.trim() || 'Uncategorized'
    out.push({
      source: 'finance',
      type: 'txn',
      occurredAt: localDayMs(r.date),
      title,
      body: `${moneySegment(r.amount, r.currency)} · ${category}`,
      payload: r,
      naturalKey: r.hash
    })
  }
  return out
}

/** A Gmail inbox row reduced to the fields the projector needs (`gmail_actions`). */
export interface GmailRow {
  threadId: string
  subject: string
  fromAddress: string
  snippet: string | null
  receivedAt: number | null // epoch ms
}

/**
 * Project `gmail_actions` → records (`source:'gmail'`, `type:'email'`).
 *
 * The sender rides in the FIRST body segment so the `gmail-person` extractor can
 * parse a display name from it (`body.split(' · ')[0]`); the snippet follows as a
 * preview line. title = the subject. naturalKey = the thread id.
 */
export function projectGmail(rows: GmailRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.threadId) continue
    const from = r.fromAddress?.trim() || '(unknown sender)'
    const snippet = r.snippet?.trim()
    out.push({
      source: 'gmail',
      type: 'email',
      occurredAt: r.receivedAt ?? null,
      title: r.subject?.trim() || '(no subject)',
      body: snippet ? `${from} · ${snippet}` : from,
      payload: r,
      naturalKey: r.threadId
    })
  }
  return out
}

/** A calendar event reduced to the fields the projector needs (`calendar_events`). */
export interface CalendarRow {
  externalId: string
  title: string
  location: string | null
  startAt: number | null // epoch ms
}

/**
 * Project `calendar_events` → records (`source:'gcal'`, `type:'event'`).
 *
 * body = the location so the EXISTING `gcal-place` extractor (which reads `body` as
 * the place name) derives Places from event locations — the same shape the Google
 * Takeout `.ics` recognizer already emits, so live + imported calendar unify.
 */
export function projectCalendar(rows: CalendarRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    out.push({
      source: 'gcal',
      type: 'event',
      occurredAt: r.startAt ?? null,
      title: r.title?.trim() || '(untitled event)',
      body: r.location?.trim() || undefined,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** A GitHub issue/PR reduced to the projector's fields (`github_items`). */
export interface GithubRow {
  externalId: string
  type: string // 'issue' | 'pr'
  repo: string
  title: string
  state: string
  author: string | null // opener login; may carry a "[bot]" suffix
  updatedAt: string | null // ISO
}

/**
 * Project `github_items` → records (`source:'github'`, `type:'issue'|'pr'`).
 *
 * The opener login is appended as `· @<login>` so the `github-person` extractor can
 * parse it (and detect a `[bot]` suffix); title = the issue/PR title; occurredAt is
 * the item's own last-updated time so it sits at the right point on the timeline.
 */
export function projectGithub(rows: GithubRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    const author = r.author?.trim()
    out.push({
      source: 'github',
      type: r.type === 'pr' ? 'pr' : 'issue',
      occurredAt: isoMs(r.updatedAt),
      title: r.title?.trim() || '(untitled)',
      body: `${r.repo} · ${r.state}${author ? ` · @${author}` : ''}`,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** A Linear issue reduced to the projector's fields (`linear_issues`). */
export interface LinearRow {
  externalId: string
  identifier: string
  title: string
  state: string
  team: string | null
  updatedAt: string | null // ISO
}

/**
 * Project `linear_issues` → records (`source:'linear'`, `type:'issue'`). title =
 * "IDENT Title"; body = "team · state". No person extractor: the sync only fetches
 * the viewer's OWN assigned issues, so there's no other-people signal to derive.
 */
export function projectLinear(rows: LinearRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    const title = `${r.identifier ?? ''} ${r.title ?? ''}`.trim() || '(untitled)'
    out.push({
      source: 'linear',
      type: 'issue',
      occurredAt: isoMs(r.updatedAt),
      title,
      body: r.team ? `${r.team} · ${r.state}` : r.state,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}
