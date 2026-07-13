/**
 * Storehouse projectors — turn domain-table data into `records` rows.
 *
 * Compass's cross-reference engine (People / Merchants / Places / Subscriptions /
 * Timeline / Search / On-this-day) is driven entirely by the append-only `records`
 * timeline. File imports feed it through the recognizer registry; live integrations
 * historically did NOT — they wrote only to their own domain tables and never
 * entered the spine. These projectors close that gap: each `project<Source>(rows)`
 * maps a domain table into `RecordInput[]`, so a synced transaction behaves exactly
 * like an imported one.
 *
 * Per the data-access policy (docs/data-access-policy.md): EVERY domain projects
 * onto the spine — habits, tasks, medical, travel, paystubs, utility bills, goals,
 * rental comps, snapshot facts — with ONE exception: raw GPS coordinates
 * (`location_points`) never enter `records` (see electron/ipc/records.ts).
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

/** A GitHub issue/PR/commit reduced to the projector's fields (`github_items`). */
export interface GithubRow {
  externalId: string
  type: string // 'issue' | 'pr' | 'commit'
  repo: string
  title: string
  state: string
  author: string | null // opener/author login; may carry a "[bot]" suffix
  updatedAt: string | null // ISO
}

const GITHUB_TYPES = new Set(['issue', 'pr', 'commit'])

/**
 * Project `github_items` → records (`source:'github'`, `type:'issue'|'pr'|'commit'`).
 *
 * The author login is appended as `· @<login>` so the `github-person` extractor can
 * parse it (and detect a `[bot]` suffix); title = the issue/PR/commit subject;
 * occurredAt is the item's own last-updated / commit time so it sits at the right
 * point on the timeline. Commits carry the developer-productivity signal.
 */
export function projectGithub(rows: GithubRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    const author = r.author?.trim()
    out.push({
      source: 'github',
      type: GITHUB_TYPES.has(r.type) ? r.type : 'issue',
      occurredAt: isoMs(r.updatedAt),
      title: r.title?.trim() || '(untitled)',
      body: `${r.repo} · ${r.state}${author ? ` · @${author}` : ''}`,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** An Oura daily-metrics row reduced to the projector's fields (`oura_daily_metrics`). */
export interface OuraRow {
  date: string // 'YYYY-MM-DD'
  sleepScore: number | null
  readinessScore: number | null
  activityScore: number | null
  steps: number | null
}

/**
 * Project `oura_daily_metrics` → records (`source:'oura'`, `type:'wellness'`).
 *
 * One row per day, occurredAt = that day at local midnight (matches the finance
 * date idiom via `localDayMs`). naturalKey = the date string, so a re-sync
 * upserts the SAME timeline row in place (mutable-occurredAt upsert semantics,
 * like Gmail/Calendar/GitHub/Linear) rather than spamming a new one — scores can
 * be revised after Oura finishes processing a day.
 */
export function projectOuraMetrics(rows: OuraRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.date) continue
    const parts: string[] = []
    if (r.sleepScore != null) parts.push(`Sleep ${r.sleepScore}`)
    if (r.readinessScore != null) parts.push(`Readiness ${r.readinessScore}`)
    if (r.activityScore != null) parts.push(`Activity ${r.activityScore}`)
    const title = parts.length > 0 ? `Oura: ${parts.join(' · ')}` : 'Oura: no scores yet'
    out.push({
      source: 'oura',
      type: 'wellness',
      occurredAt: localDayMs(r.date),
      title,
      body: r.steps != null ? `${r.steps.toLocaleString('en-US')} steps` : undefined,
      payload: r,
      naturalKey: r.date
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

// ── Spine expansion (data-access policy: every domain flows onto the spine) ──

/** A completed habit check joined with its habit (`habit_entries` ⋈ `habits`). */
export interface HabitCheckRow {
  habitId: number
  habitName: string
  date: string // ISO 'YYYY-MM-DD'
  source: string | null // 'oura' (etc.) when auto-filled; null = user-toggled
}

/**
 * Project completed habit checks → records (`source:'habit'`, `type:'habit-check'`).
 *
 * Only COMPLETED entries project (an unchecked day is a non-event); unchecking
 * later removes the spine row via the reconcile-delete in storehouse-sync. The
 * naturalKey `habitId|date` is stable across renames, so renaming a habit
 * re-titles the existing timeline rows in place instead of duplicating them.
 */
export function projectHabitChecks(rows: HabitCheckRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.habitId || !r.date) continue
    out.push({
      source: 'habit',
      type: 'habit-check',
      occurredAt: localDayMs(r.date),
      title: r.habitName?.trim() || 'Habit',
      body: r.source ? `auto-filled · ${r.source}` : 'checked',
      payload: r,
      naturalKey: `${r.habitId}|${r.date}`
    })
  }
  return out
}

/** A checklist item reduced to the projector's fields (`checklist_items`). */
export interface TaskRow {
  id: number
  listType: string // 'daily' | 'weekly' | 'monthly'
  listDate: string // ISO 'YYYY-MM-DD'
  title: string
  body: string | null
  status: string | null // 'unchecked' | 'in_progress' | 'done' | 'snoozed'
  checked: boolean | null
  category: string | null
}

/**
 * Project `checklist_items` → records (`source:'task'`, `type:'task'`). One row
 * per task on its list day; status rides in the body so search finds "done"
 * tasks. naturalKey = the table's autoincrement id (deletes reconcile away).
 */
export function projectTasks(rows: TaskRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.id || !r.listDate) continue
    const status = r.status?.trim() || (r.checked ? 'done' : 'unchecked')
    const parts = [r.listType, status, r.category?.trim() || 'personal']
    if (r.body?.trim()) parts.push(r.body.trim().slice(0, 200))
    out.push({
      source: 'task',
      type: 'task',
      occurredAt: localDayMs(r.listDate),
      title: r.title?.trim() || '(untitled task)',
      body: parts.join(' · '),
      payload: r,
      naturalKey: String(r.id)
    })
  }
  return out
}

/** A clinical record reduced to the projector's fields (`medical_records`). */
export interface MedicalRow {
  externalId: string
  category: string // 'condition' | 'medication' | 'lab' | 'immunization' | 'allergy' | 'encounter' | 'procedure'
  description: string | null
  code: string | null
  status: string | null
  recordedAt: string | null // 'YYYY-MM-DD'
}

/**
 * Project `medical_records` → records (`source:'medical'`, `type:` the clinical
 * category). Per the data-access policy, medical detail IS on the spine (full-
 * detail searchable); the on-this-day sensitivity guard (timeline-memories.ts)
 * keeps it from ever auto-resurfacing unprompted.
 */
export function projectMedicalRecords(rows: MedicalRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId || !r.category) continue
    const parts = [r.status?.trim(), r.code?.trim()].filter((p): p is string => !!p)
    out.push({
      source: 'medical',
      type: r.category,
      occurredAt: r.recordedAt ? localDayMs(r.recordedAt) : null,
      title: r.description?.trim() || r.category,
      body: parts.length > 0 ? parts.join(' · ') : undefined,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** A quantitative lab/vital result reduced to the projector's fields (`lab_results`). */
export interface LabResultRow {
  id: number
  testName: string
  panel: string | null
  value: number | null
  valueText: string | null
  unit: string | null
  flag: string | null
  takenAt: string // 'YYYY-MM-DD'
  encounterId: string | null
}

/** Render one result as "Name value unit (FLAG)", omitting parts that are absent. */
function formatLabResult(r: LabResultRow): string {
  const amount = r.value != null ? `${r.value}${r.unit ? ` ${r.unit}` : ''}` : (r.valueText ?? '')
  const flag = r.flag && r.flag !== 'normal' ? ` (${r.flag})` : ''
  return `${r.testName} ${amount}${flag}`.trim()
}

/**
 * Project `lab_results` → records at PANEL granularity (`source:'lab'`,
 * `type:'lab'`) — one row per (encounter, panel, date) grouping the individual
 * tests drawn together, not one row per test. `lab_results` itself stays the
 * fine-grained source of truth for trends/queries; flooding the Timeline with a
 * row per test (a panel can carry 10-40+) would bury everything else. Abnormal
 * results are called out in the body so the panel's headline is scannable.
 * `type:'lab'` is in timeline-memories.ts's SENSITIVE_TYPES, so it never
 * auto-resurfaces on-this-day, same posture as `medical_records`.
 */
export function projectLabResults(rows: LabResultRow[]): RecordInput[] {
  const groups = new Map<string, LabResultRow[]>()
  for (const r of rows) {
    const testName = r.testName.trim()
    const takenAt = r.takenAt.trim()
    if (!testName || !takenAt) continue
    const encounterId = r.encounterId?.trim() || ''
    const panel = r.panel?.trim() || testName
    const key = `${encounterId}|${panel}|${takenAt}`
    const group = groups.get(key)
    if (group) group.push(r)
    else groups.set(key, [r])
  }
  const out: RecordInput[] = []
  for (const [key, group] of groups) {
    const panel = group[0].panel?.trim() || 'Labs'
    const abnormal = group.filter((r) => r.flag && r.flag !== 'normal')
    out.push({
      source: 'lab',
      type: 'lab',
      occurredAt: localDayMs(group[0].takenAt),
      title: `${panel} · ${group.length} result${group.length === 1 ? '' : 's'}`,
      body:
        abnormal.length > 0
          ? abnormal.map(formatLabResult).join(' · ')
          : `${group.length} result${group.length === 1 ? '' : 's'}, all in normal range`,
      payload: {
        panel,
        takenAt: group[0].takenAt,
        encounterId: group[0].encounterId,
        results: group
      },
      naturalKey: key
    })
  }
  return out
}

/** A logged trip reduced to the projector's fields (`travel_segments`). */
export interface TravelSegmentRow {
  id: number
  country: string // ISO-3166 alpha-2
  startDate: string // 'YYYY-MM-DD' (inclusive)
  endDate: string // 'YYYY-MM-DD' (inclusive)
  notes: string | null
}

/** 'CR' → 'Costa Rica' (falls back to the raw code on anything unmappable). */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/**
 * Project `travel_segments` → records (`source:'travel'`, `type:'trip'`). This is
 * the ONLY location-flavored stream on the spine — country + date window, the
 * coarse derived layer; raw GPS points stay in `location_points`, off the spine
 * and off every AI surface (the one exclusion in the data-access policy).
 */
export function projectTravelSegments(rows: TravelSegmentRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.id || !r.country || !r.startDate) continue
    const window =
      r.endDate && r.endDate !== r.startDate ? `${r.startDate} → ${r.endDate}` : r.startDate
    out.push({
      source: 'travel',
      type: 'trip',
      occurredAt: localDayMs(r.startDate),
      title: `Trip to ${countryName(r.country)}`,
      body: r.notes?.trim() ? `${window} · ${r.notes.trim().slice(0, 200)}` : window,
      payload: r,
      naturalKey: String(r.id)
    })
  }
  return out
}

/** A paystub reduced to the projector's fields (`argyle_paystubs`). */
export interface PaystubRow {
  externalId: string
  employer: string | null
  grossPay: number | null
  netPay: number | null
  currency: string
  periodStart: string | null // 'YYYY-MM-DD'
  periodEnd: string | null
  paidAt: string | null // 'YYYY-MM-DD'
}

/**
 * Project `argyle_paystubs` → records (`source:'paystub'`, `type:'paycheck'`).
 * The net-pay amount rides in the FIRST body segment (money-first, like finance
 * txns) so `parseMoney`-style consumers read it back.
 */
export function projectPaystubs(rows: PaystubRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    const parts: string[] = []
    const amount = r.netPay ?? r.grossPay
    if (amount != null) parts.push(moneySegment(amount, r.currency))
    if (r.netPay != null && r.grossPay != null)
      parts.push(`gross ${moneySegment(r.grossPay, r.currency)}`)
    if (r.periodStart && r.periodEnd) parts.push(`${r.periodStart}–${r.periodEnd}`)
    out.push({
      source: 'paystub',
      type: 'paycheck',
      occurredAt: r.paidAt ? localDayMs(r.paidAt) : null,
      title: r.employer?.trim() ? `Paycheck — ${r.employer.trim()}` : 'Paycheck',
      body: parts.length > 0 ? parts.join(' · ') : undefined,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** A utility statement reduced to the projector's fields (`utility_bills`). */
export interface UtilityBillRow {
  externalId: string
  provider: string | null
  serviceAddress: string | null
  statementDate: string | null // 'YYYY-MM-DD'
  amount: number | null
  currency: string
}

/**
 * Project `utility_bills` → records (`source:'utility'`, `type:'bill'`). The
 * STATEMENT is what's on the timeline; the bank payment stays a separate
 * `finance|txn` row (two records, one expense — spend math reads
 * `finance_transactions` only, so nothing double-counts).
 */
export function projectUtilityBills(rows: UtilityBillRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.externalId) continue
    const parts: string[] = []
    if (r.amount != null) parts.push(moneySegment(r.amount, r.currency))
    if (r.serviceAddress?.trim()) parts.push(r.serviceAddress.trim())
    out.push({
      source: 'utility',
      type: 'bill',
      occurredAt: r.statementDate ? localDayMs(r.statementDate) : null,
      title: r.provider?.trim() ? `${r.provider.trim()} bill` : 'Utility bill',
      body: parts.length > 0 ? parts.join(' · ') : undefined,
      payload: r,
      naturalKey: r.externalId
    })
  }
  return out
}

/** A savings goal reduced to the projector's fields (`financial_goals`). */
export interface FinancialGoalRow {
  id: number
  name: string
  category: string
  targetAmount: number
  targetDate: string | null // 'YYYY-MM-DD'
  createdAt: number | null // epoch ms
}

/**
 * Project `financial_goals` → records (`source:'goal'`, `type:'financial-goal'`).
 * Dated at creation (that's when the intention became real); edits re-project in
 * place via the stable row-id key.
 */
export function projectFinancialGoals(rows: FinancialGoalRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.id || !r.name?.trim()) continue
    const parts = [r.category, `target ${moneySegment(r.targetAmount, null)}`]
    if (r.targetDate) parts.push(`by ${r.targetDate}`)
    out.push({
      source: 'goal',
      type: 'financial-goal',
      occurredAt: r.createdAt,
      title: r.name.trim(),
      body: parts.join(' · '),
      payload: r,
      naturalKey: String(r.id)
    })
  }
  return out
}

/** A rental comp reduced to the projector's fields (`rental_comps`). */
export interface RentalCompRow {
  id: number
  name: string
  zone: string
  bedrooms: number
  nightlyUsd: number | null
  savedAt: string | null // 'YYYY-MM-DD'
  createdAt: number | null // epoch ms
}

/**
 * Project `rental_comps` → records (`source:'rental-comp'`, `type:'comp'`).
 * Dated at capture (`savedAt`, falling back to the row's createdAt).
 */
export function projectRentalComps(rows: RentalCompRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.id) continue
    const parts = [r.zone, `${r.bedrooms}bd`]
    if (r.nightlyUsd != null) parts.push(`$${r.nightlyUsd}/nt`)
    out.push({
      source: 'rental-comp',
      type: 'comp',
      occurredAt: r.savedAt ? localDayMs(r.savedAt) : r.createdAt,
      title: r.name?.trim() || 'Rental comp',
      body: parts.join(' · '),
      payload: r,
      naturalKey: String(r.id)
    })
  }
  return out
}

/** A snapshot fact reduced to the projector's fields (`snapshot_facts`). */
export interface SnapshotFactRow {
  source: string // 'facebook' (etc.)
  category: string // 'ad-profile' | 'profile' | 'off-meta-apps' | 'security'
  label: string | null
  value: string
  dedupHash: string
}

/**
 * Project `snapshot_facts` → records (`type:'fact'`, source = the fact's own
 * source). UNDATED (`occurredAt: null`) — these describe *who you are*, not
 * *what happened*, so they're searchable but never sit on the dated timeline.
 * naturalKey reuses the fact's own content-addressed dedup hash.
 */
export function projectSnapshotFacts(rows: SnapshotFactRow[]): RecordInput[] {
  const out: RecordInput[] = []
  for (const r of rows) {
    if (!r.dedupHash || !r.value?.trim()) continue
    out.push({
      source: r.source,
      type: 'fact',
      occurredAt: null,
      title: r.label?.trim() ? `${r.label.trim()}` : r.category,
      body: r.value.trim().slice(0, 500),
      payload: r,
      naturalKey: r.dedupHash
    })
  }
  return out
}
