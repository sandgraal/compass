/**
 * Credit hub aggregator (Phase 10.5 — RIGHTS mode, credit reports).
 *
 * A dropped credit-report PDF is parsed by `CREDIT_REPORT_RECOGNIZER`
 * (`electron/lib/pdf.ts`) into dated `records` — one summary, one per tradeline,
 * one per inquiry — exactly like the brokerage-holdings snapshot pattern
 * (`finance-holdings.ts`). Re-dropping next month's report adds a new snapshot,
 * so trend-over-time is free.
 *
 * This module reads those records back and computes the Credit tab view:
 * utilization, per-card health, account age/mix, on-time vs late history,
 * inquiries, a score trend (report scores + manual entries), and a pure
 * improvement-recommendation rules engine. `summarizeCredit` +
 * `creditRecommendations` are pure; the DB layer is thin (mirrors
 * `getLatestHoldings`). No dedicated table — everything lives in `records`.
 */

import { parseWhen } from '../lib/dates'

export const CREDIT_SOURCE = 'credit-report'

export type CreditPaymentLates = {
  late30: number
  late60: number
  late90: number
  late120: number
  late150: number
  late180: number
}

/** Tradeline fields the hub uses (a subset of the recognizer's payload). */
export type CreditTradeline = {
  creditor: string
  accountLast4: string | null
  accountType: string | null
  status: string | null
  closed: boolean
  balance: number | null
  creditLimit: number | null
  highCredit: number | null
  utilization: number | null
  dateOpened: string | null
  monthsReviewed: number | null
  paymentHistory: CreditPaymentLates
}

export type CreditInquiry = {
  company: string
  inquiryType: string
  inquiryDate: string
}

export type CreditScorePoint = { date: string; score: number }

export type CreditPerCard = {
  creditor: string
  accountLast4: string | null
  balance: number | null
  limit: number | null
  utilization: number | null
}

export type CreditRecommendation = {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
}

/** A live finance_accounts row, as much of it as reconciliation needs. */
export type CreditAccountLike = {
  id: number
  name: string
  institution: string
  mask: string | null
  isDebt: boolean
  balance: number | null
}

export type CreditReconciliationMatch = {
  creditor: string
  accountLast4: string | null
  reportBalance: number | null
  accountId: number
  accountName: string
  liveBalance: number | null
  /** live − report; positive = you owe more now than the report showed. */
  drift: number | null
}

export type CreditReconciliation = {
  /** Open tradelines paired with a live debt account. */
  matched: CreditReconciliationMatch[]
  /** Open tradelines with no live account — candidate untracked liabilities. */
  unmatchedTradelines: Array<{
    creditor: string
    accountLast4: string | null
    accountType: string | null
    balance: number | null
  }>
  /** Live debt accounts absent from the shown report. */
  unmatchedAccounts: Array<{ accountId: number; name: string; balance: number | null }>
}

const EMPTY_RECONCILIATION: CreditReconciliation = {
  matched: [],
  unmatchedTradelines: [],
  unmatchedAccounts: []
}

export type CreditSummary = {
  hasData: boolean
  bureau: string | null
  bureausAvailable: string[]
  reportDate: string | null
  score: number | null
  scoreTrend: CreditScorePoint[]
  totalRevolvingBalance: number
  totalRevolvingLimit: number
  overallUtilization: number | null
  perCard: CreditPerCard[]
  openCount: number
  closedCount: number
  tradelineCount: number
  accountTypeMix: Array<{ type: string; count: number }>
  oldestAccountMonths: number | null
  averageAccountAgeMonths: number | null
  onTimeCount: number
  lateCount: number
  hardInquiries12mo: number
  softInquiries12mo: number
  hardInquiries24mo: number
  softInquiries24mo: number
  recommendations: CreditRecommendation[]
  reconciliation: CreditReconciliation
}

const EMPTY: CreditSummary = {
  hasData: false,
  bureau: null,
  bureausAvailable: [],
  reportDate: null,
  score: null,
  scoreTrend: [],
  totalRevolvingBalance: 0,
  totalRevolvingLimit: 0,
  overallUtilization: null,
  perCard: [],
  openCount: 0,
  closedCount: 0,
  tradelineCount: 0,
  accountTypeMix: [],
  oldestAccountMonths: null,
  averageAccountAgeMonths: null,
  onTimeCount: 0,
  lateCount: 0,
  hardInquiries12mo: 0,
  softInquiries12mo: 0,
  hardInquiries24mo: 0,
  softInquiries24mo: 0,
  recommendations: [],
  reconciliation: EMPTY_RECONCILIATION
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

const isRevolving = (type: string | null): boolean => /credit card|charge/i.test(type ?? '')

function totalLates(p: CreditPaymentLates): number {
  return p.late30 + p.late60 + p.late90 + p.late120 + p.late150 + p.late180
}

/** Whole-month age between an opened date and now (0 when unparseable). */
function ageMonths(dateOpened: string | null, todayMs: number): number | null {
  const ms = parseWhen(dateOpened ?? '')
  if (ms == null) return null
  const a = new Date(ms)
  const b = new Date(todayMs)
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  if (b.getDate() < a.getDate()) m -= 1
  return Math.max(0, m)
}

/**
 * Pure rollups over the latest tradeline snapshot + all inquiries. Utilization is
 * computed ONLY over open revolving accounts that report a credit limit — a card
 * with a balance but no reported limit is excluded from both sides (its
 * utilization is unknowable), rather than inflating the ratio.
 */
export function summarizeCredit(
  tradelines: CreditTradeline[],
  inquiries: CreditInquiry[],
  opts: {
    bureau: string | null
    reportDate: string | null
    score: number | null
    scoreTrend: CreditScorePoint[]
    reportAvgAgeMonths?: number | null
    bureausAvailable?: string[]
    todayMs: number
    reconciliation?: CreditReconciliation
  }
): CreditSummary {
  if (tradelines.length === 0 && inquiries.length === 0 && opts.scoreTrend.length === 0) {
    return { ...EMPTY }
  }

  const open = tradelines.filter((t) => !t.closed)
  const openRevolvingWithLimit = open.filter(
    (t) => isRevolving(t.accountType) && t.creditLimit != null && t.creditLimit > 0
  )

  let totalRevolvingBalance = 0
  let totalRevolvingLimit = 0
  const perCard: CreditPerCard[] = []
  for (const t of openRevolvingWithLimit) {
    const lim = t.creditLimit as number
    // Only a KNOWN balance counts toward utilization. A dropped balance (e.g.
    // TransUnion, whose payment-history balance is unreliable) must NOT read as
    // 0% or inflate the denominator — its per-card utilization stays null.
    if (t.balance != null) {
      totalRevolvingBalance += t.balance
      totalRevolvingLimit += lim
    }
    perCard.push({
      creditor: t.creditor,
      accountLast4: t.accountLast4,
      balance: t.balance,
      limit: t.creditLimit,
      utilization: t.balance != null ? round4(t.balance / lim) : null
    })
  }
  totalRevolvingBalance = round2(totalRevolvingBalance)
  totalRevolvingLimit = round2(totalRevolvingLimit)
  const overallUtilization =
    totalRevolvingLimit > 0 ? round4(totalRevolvingBalance / totalRevolvingLimit) : null
  // Worst-utilized card first — that's what a reader acts on.
  perCard.sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))

  const openCount = open.length
  const closedCount = tradelines.length - openCount

  const typeCounts = new Map<string, number>()
  for (const t of tradelines) {
    const key = t.accountType?.trim() || 'Other'
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1)
  }
  const accountTypeMix = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)

  const ages = tradelines
    .map((t) => ageMonths(t.dateOpened, opts.todayMs))
    .filter((m): m is number => m != null)
  const oldestAccountMonths = ages.length ? Math.max(...ages) : null
  const averageAccountAgeMonths = ages.length
    ? Math.round(ages.reduce((s, m) => s + m, 0) / ages.length)
    : (opts.reportAvgAgeMonths ?? null)

  const lateCount = tradelines.filter((t) => totalLates(t.paymentHistory) > 0).length
  const onTimeCount = tradelines.length - lateCount

  const day = 86400000
  const within = (dateStr: string, days: number): boolean => {
    const ms = parseWhen(dateStr)
    return ms != null && opts.todayMs - ms <= days * day && opts.todayMs - ms >= 0
  }
  const hard = inquiries.filter((q) => /hard/i.test(q.inquiryType))
  const soft = inquiries.filter((q) => !/hard/i.test(q.inquiryType))

  const summary: CreditSummary = {
    hasData: tradelines.length > 0 || inquiries.length > 0 || opts.scoreTrend.length > 0,
    bureau: opts.bureau,
    bureausAvailable: opts.bureausAvailable ?? [],
    reportDate: opts.reportDate,
    score: opts.score,
    scoreTrend: opts.scoreTrend,
    totalRevolvingBalance,
    totalRevolvingLimit,
    overallUtilization,
    perCard,
    openCount,
    closedCount,
    tradelineCount: tradelines.length,
    accountTypeMix,
    oldestAccountMonths,
    averageAccountAgeMonths,
    onTimeCount,
    lateCount,
    hardInquiries12mo: hard.filter((q) => within(q.inquiryDate, 365)).length,
    softInquiries12mo: soft.filter((q) => within(q.inquiryDate, 365)).length,
    hardInquiries24mo: hard.filter((q) => within(q.inquiryDate, 730)).length,
    softInquiries24mo: soft.filter((q) => within(q.inquiryDate, 730)).length,
    recommendations: [],
    reconciliation: opts.reconciliation ?? EMPTY_RECONCILIATION
  }
  summary.recommendations = creditRecommendations(summary)
  return summary
}

// ─── Report ↔ live-account reconciliation ────────────────────────────────────

const normName = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * An account's last-4: the `mask` column, else a `(1234)` suffix at the END of
 * its name. Exactly 4 digits, anchored — a stray "(12)" mid-name must not
 * create a false pairing.
 */
function accountLast4(a: CreditAccountLike): string | null {
  if (a.mask?.trim()) return a.mask.trim()
  const m = a.name.match(/\((\d{4})\)\s*$/)
  return m ? m[1] : null
}

function nameMatches(creditor: string, a: CreditAccountLike): boolean {
  const c = normName(creditor)
  const acct = normName(`${a.name} ${a.institution}`)
  if (c.length < 4 || acct.length < 4) return false
  return acct.includes(c) || c.includes(acct)
}

/**
 * Pair the report's OPEN tradelines with live debt accounts so the Credit tab
 * can show report-balance vs live-balance drift, flag tradelines Compass isn't
 * tracking (candidate missing liabilities), and flag tracked debts absent from
 * the report. DISPLAY-ONLY: tradelines duplicate already-synced card accounts,
 * so their balances are never summed into net-worth liabilities.
 *
 * Matching: (1) exact last-4 (tradeline.accountLast4 vs the account's mask or
 * a `(1234)` suffix in its name); (2) a name/institution containment match,
 * but only when exactly ONE unmatched account matches — an ambiguous creditor
 * (three AmEx cards, no last-4 on the tradeline) stays unmatched rather than
 * guessing wrong. Closed tradelines are excluded entirely.
 */
export function reconcileTradelines(
  tradelines: CreditTradeline[],
  accounts: CreditAccountLike[]
): CreditReconciliation {
  const open = tradelines.filter((t) => !t.closed)
  const debts = accounts.filter((a) => a.isDebt)
  if (open.length === 0 && debts.length === 0) return { ...EMPTY_RECONCILIATION }

  const matchedAccountIds = new Set<number>()
  const pair = new Map<CreditTradeline, CreditAccountLike>()

  // Pass 1: exact last-4.
  for (const t of open) {
    if (!t.accountLast4) continue
    const hit = debts.find(
      (a) => !matchedAccountIds.has(a.id) && accountLast4(a) === t.accountLast4
    )
    if (hit) {
      pair.set(t, hit)
      matchedAccountIds.add(hit.id)
    }
  }
  // Pass 2: unambiguous name match among the remainder.
  for (const t of open) {
    if (pair.has(t)) continue
    const hits = debts.filter((a) => !matchedAccountIds.has(a.id) && nameMatches(t.creditor, a))
    if (hits.length === 1) {
      pair.set(t, hits[0])
      matchedAccountIds.add(hits[0].id)
    }
  }

  const matched: CreditReconciliationMatch[] = [...pair.entries()].map(([t, a]) => ({
    creditor: t.creditor,
    accountLast4: t.accountLast4,
    reportBalance: t.balance,
    accountId: a.id,
    accountName: a.name,
    liveBalance: a.balance,
    drift: t.balance != null && a.balance != null ? round2(a.balance - t.balance) : null
  }))
  matched.sort((x, y) => Math.abs(y.drift ?? 0) - Math.abs(x.drift ?? 0))

  const unmatchedTradelines = open
    .filter((t) => !pair.has(t))
    .map((t) => ({
      creditor: t.creditor,
      accountLast4: t.accountLast4,
      accountType: t.accountType,
      balance: t.balance
    }))
    .sort((x, y) => (y.balance ?? 0) - (x.balance ?? 0))

  const unmatchedAccounts = debts
    .filter((a) => !matchedAccountIds.has(a.id))
    .map((a) => ({ accountId: a.id, name: a.name, balance: a.balance }))
    .sort((x, y) => (y.balance ?? 0) - (x.balance ?? 0))

  return { matched, unmatchedTradelines, unmatchedAccounts }
}

/** Pure improvement-recommendation rules engine over a computed summary. */
export function creditRecommendations(s: CreditSummary): CreditRecommendation[] {
  const out: CreditRecommendation[] = []

  for (const c of s.perCard) {
    if (c.utilization == null) continue
    const pct = Math.round(c.utilization * 100)
    const name = `${c.creditor}${c.accountLast4 ? ` ••${c.accountLast4}` : ''}`
    if (c.utilization > 0.9) {
      out.push({
        id: `util-card-${c.accountLast4 ?? c.creditor}`,
        severity: 'high',
        title: `${name} is nearly maxed (${pct}%)`,
        detail: 'Paying this card down below 30% of its limit is the fastest utilization win.'
      })
    } else if (c.utilization > 0.3) {
      out.push({
        id: `util-card-${c.accountLast4 ?? c.creditor}`,
        severity: 'medium',
        title: `${name} utilization is high (${pct}%)`,
        detail: 'Keeping each card under 30% of its limit helps your score.'
      })
    }
  }

  if (s.overallUtilization != null) {
    const pct = Math.round(s.overallUtilization * 100)
    if (s.overallUtilization > 0.3) {
      out.push({
        id: 'util-overall',
        severity: 'high',
        title: `Overall utilization is ${pct}%`,
        detail:
          'Total revolving balances are above 30% of your total limits — pay down or request higher limits.'
      })
    } else if (s.overallUtilization > 0.1) {
      out.push({
        id: 'util-overall',
        severity: 'medium',
        title: `Overall utilization is ${pct}%`,
        detail: 'Under 10% overall utilization is ideal for scoring.'
      })
    }
  }

  if (s.lateCount > 0) {
    out.push({
      id: 'late-payments',
      severity: 'medium',
      title: `${s.lateCount} account${s.lateCount > 1 ? 's' : ''} with past late payments`,
      detail:
        'On-time payments from here forward matter most; older delinquencies age off over time.'
    })
  }

  if (s.hardInquiries12mo >= 3) {
    out.push({
      id: 'many-hard-inquiries',
      severity: 'medium',
      title: `${s.hardInquiries12mo} hard inquiries in the last year`,
      detail: 'Frequent new-credit applications can lower your score — space them out.'
    })
  }

  if (s.tradelineCount > 0 && s.tradelineCount < 3) {
    out.push({
      id: 'thin-file',
      severity: 'medium',
      title: 'Thin credit file',
      detail: 'Few accounts limit your history depth — a well-managed additional account can help.'
    })
  }

  if (s.averageAccountAgeMonths != null && s.averageAccountAgeMonths < 24) {
    out.push({
      id: 'aging-file',
      severity: 'low',
      title: 'Young average account age',
      detail:
        'Keep older accounts open — average age of accounts grows with time and helps your score.'
    })
  }

  if (out.length === 0 && (s.tradelineCount > 0 || s.scoreTrend.length > 0)) {
    out.push({
      id: 'healthy',
      severity: 'low',
      title: 'Your credit profile looks healthy',
      detail:
        'Low utilization and accounts in good standing — keep paying on time and staying under 30%.'
    })
  }

  return out
}

// ─── DB layer (records-backed; no dedicated table) ───────────────────────────

export type SqliteForCredit = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

type CreditRow = { type: string; occurred_at: number | null; payload: string | null }

/**
 * Read the credit-report records back into a `CreditSummary`. Tradelines are
 * scoped to the latest report snapshot (by ISO reportDate); inquiries are read
 * across ALL reports (they dedupe by event, and a two-year-old inquiry may only
 * appear in an older report); the score trend merges report scores + manual
 * `credit-score` entries. Degrades to an empty summary when `records` is absent.
 */
export function getCreditSummary(sqlite: SqliteForCredit, today: string): CreditSummary {
  const todayMs = parseWhen(today) ?? Date.parse(`${today}T00:00:00`)
  let rows: CreditRow[] = []
  try {
    rows = sqlite
      .prepare('SELECT type, occurred_at, payload FROM records WHERE source = ?')
      .all(CREDIT_SOURCE) as CreditRow[]
  } catch {
    return { ...EMPTY }
  }
  if (rows.length === 0) return { ...EMPTY }

  type Parsed = { type: string; occurredAt: number | null; p: Record<string, unknown> }
  const parsed: Parsed[] = []
  for (const r of rows) {
    if (!r.payload) continue
    try {
      parsed.push({
        type: r.type,
        occurredAt: r.occurred_at,
        p: JSON.parse(r.payload) as Record<string, unknown>
      })
    } catch {
      // skip a corrupt payload
    }
  }

  // Each bureau's report is its own snapshot. Group tradelines by bureau+date and
  // show the single freshest, most-complete one — so three reports pulled the same
  // day (Equifax + Experian + TransUnion) don't merge and triple-count. Ties break
  // toward the snapshot with the most balances present (TransUnion carries none).
  const tradelineRows = parsed.filter((r) => r.type === 'credit-tradeline')
  const groups = new Map<string, { bureau: string; reportDate: string; rows: Parsed[] }>()
  for (const r of tradelineRows) {
    const bureau = typeof r.p.bureau === 'string' ? r.p.bureau : ''
    const rd = typeof r.p.reportDate === 'string' ? r.p.reportDate : ''
    const key = `${bureau}|${rd}`
    const g = groups.get(key)
    if (g) g.rows.push(r)
    else groups.set(key, { bureau, reportDate: rd, rows: [r] })
  }
  const bureausAvailable = [
    ...new Set([...groups.values()].map((g) => g.bureau).filter(Boolean))
  ].sort()
  const withBalance = (rows: Parsed[]): number => rows.filter((r) => r.p.balance != null).length
  let best: { bureau: string; reportDate: string; rows: Parsed[] } | null = null
  for (const g of groups.values()) {
    const better =
      !best ||
      g.reportDate > best.reportDate ||
      (g.reportDate === best.reportDate &&
        (withBalance(g.rows) > withBalance(best.rows) ||
          (withBalance(g.rows) === withBalance(best.rows) && g.rows.length > best.rows.length)))
    if (better) best = { bureau: g.bureau, reportDate: g.reportDate, rows: g.rows }
  }

  const tradelines: CreditTradeline[] = best
    ? best.rows.map((r) => r.p as unknown as CreditTradeline)
    : []
  const selBureau = best?.bureau || null

  // Inquiries: only the shown bureau's — each bureau sees different inquiries, so
  // merging would double-count.
  const inquiries: CreditInquiry[] = parsed
    .filter((r) => r.type === 'credit-inquiry' && (!selBureau || r.p.bureau === selBureau))
    .map((r) => r.p as unknown as CreditInquiry)

  // Score trend: report summaries + manual credit-score entries with a score.
  const scoreTrend: CreditScorePoint[] = parsed
    .filter((r) => r.type === 'credit-report' || r.type === 'credit-score')
    .map((r) => {
      const raw = r.p.score
      const score = typeof raw === 'number' ? raw : Number(raw)
      const date =
        typeof r.p.reportDate === 'string'
          ? r.p.reportDate
          : r.occurredAt != null
            ? new Date(r.occurredAt).toISOString().slice(0, 10)
            : ''
      return { date, score }
    })
    .filter((pt) => Number.isFinite(pt.score) && pt.score > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  // Summary record for the SELECTED bureau — bureau / reportDate / stated avg age.
  const summaryRow = parsed
    .filter((r) => r.type === 'credit-report' && (!selBureau || r.p.bureau === selBureau))
    .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0]
  const bureau =
    selBureau ??
    (summaryRow && typeof summaryRow.p.bureau === 'string' ? summaryRow.p.bureau : null)
  const reportDate =
    best?.reportDate ??
    (summaryRow && typeof summaryRow.p.reportDate === 'string' ? summaryRow.p.reportDate : null)
  const reportAvgAgeMonths =
    summaryRow && typeof summaryRow.p.avgAccountAgeMonths === 'number'
      ? summaryRow.p.avgAccountAgeMonths
      : null
  const score = scoreTrend.length ? scoreTrend[scoreTrend.length - 1].score : null

  // Live debt accounts for the report↔accounts reconciliation. If finance_accounts
  // is absent (records-only DBs, older schemas), we fall back to "no accounts",
  // which makes OPEN tradelines surface as "untracked" in the reconciliation UI.
  let accounts: CreditAccountLike[] = []
  try {
    accounts = (
      sqlite
        .prepare('SELECT id, name, institution, mask, is_debt, balance FROM finance_accounts')
        .all() as Array<{
        id: number
        name: string
        institution: string | null
        mask: string | null
        is_debt: number
        balance: number | null
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      institution: r.institution ?? '',
      mask: r.mask,
      isDebt: r.is_debt === 1,
      balance: r.balance
    }))
  } catch {
    /* reconciliation is optional garnish — never break the summary */
  }

  return summarizeCredit(tradelines, inquiries, {
    bureau,
    reportDate,
    score,
    scoreTrend,
    reportAvgAgeMonths,
    bureausAvailable,
    todayMs,
    reconciliation: reconcileTradelines(tradelines, accounts)
  })
}
