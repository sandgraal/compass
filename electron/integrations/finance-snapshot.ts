/**
 * Net-worth balance snapshots (Phase 4.4; live-capture rework 2026-07).
 *
 * Balance source per account, in order of authority:
 *   1. 'live'     — accounts linked to a provider that refreshes
 *                   `finance_accounts.balance` on every sync (SimpleFIN today;
 *                   see hasLiveBalanceAuthority). The synced balance IS the
 *                   truth, so the snapshot records it verbatim.
 *   2. 'manual'   — `manual_asset` accounts (CR property, collectibles) carry
 *                   the user-set balance forward; they have no txns.
 *   3. 'inferred' — unlinked transaction-backed accounts (CSV/statement
 *                   imports) fall back to
 *                   `previous_snapshot.balance + Σ(txns since)`.
 *
 * The capture keeps one row per account per LOCAL calendar day. Live-authority
 * accounts UPDATE today's row in place when the synced balance moves (so a
 * later sync corrects the 00:05 cron row); a same-day 'manual' row always wins
 * until tomorrow. Everything else skips when today's row exists, so the cron
 * is safe to run from multiple entry points without dupes.
 *
 * Pure SQLite — accepts a thin interface so it can run in tests against
 * `better-sqlite3` directly without going through Drizzle.
 */

import { runOnceGated } from '../lib/one-shot-repair'
import { getBaseCurrency, loadFxRates, pickRate } from './finance-fx'
import { NET_WORTH_HOLDINGS_SOURCES, getHoldingsValueAsOf } from './finance-holdings'

export type SnapshotSource = 'manual' | 'inferred' | 'live'

export type SqliteForSnapshot = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

/**
 * Base-currency converter (Phase 11.1). Loads the user's base currency + the FX
 * snapshot once, then values native account balances in the base currency for
 * net-worth rollups. `toBase` returns null when a FOREIGN balance has no rate —
 * the caller keeps that account out of the totals and flags it, rather than
 * misreporting it 1:1. For the common all-USD case base === 'USD' and every
 * account converts trivially, so totals are byte-for-byte unchanged.
 */
function makeBaseConverter(sqlite: SqliteForSnapshot): {
  base: string
  toBase(amount: number, currency: string | null | undefined): number | null
} {
  const base = getBaseCurrency(sqlite)
  const rates = loadFxRates(sqlite)
  return {
    base,
    toBase(amount, currency) {
      const cur = (currency || base).toUpperCase()
      if (cur === base) return round2(amount)
      const rate = pickRate(rates, cur, base)
      if (rate == null) return null
      return round2(amount * rate)
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type AccountRow = {
  id: number
  asset_class: string
  is_debt: number
  balance: number | null
  simplefin_account_id: string | null
}

export type LiveLinkFields = {
  simplefin_account_id: string | null
}

/**
 * True when a provider sync refreshes `finance_accounts.balance` on every run,
 * making the live column authoritative over transaction inference. SimpleFIN
 * only today — the Plaid sync loop does not write balances (extend this to
 * `plaid_account_id` once it does).
 */
export function hasLiveBalanceAuthority(a: LiveLinkFields): boolean {
  return a.simplefin_account_id != null
}

type SnapshotRow = {
  id: number
  account_id: number
  captured_at: number
  balance: number
  source: string
}

/** ms-since-epoch start of the local-time day for the given timestamp. */
export function startOfDayMs(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Format a timestamp as a local-time `YYYY-MM-DD` string.
 *
 * Snapshots are bucketed per LOCAL calendar day (cron at 00:05 local time,
 * idempotency check via `startOfDayMs`), and `finance_transactions.date` is
 * stored as a date-only ISO string with no timezone — so it represents the
 * local day the txn occurred. Comparing transaction dates against a
 * UTC-derived slug (`toISOString().slice(0, 10)`) shifts the boundary by ±1
 * day for users outside UTC, which can include or exclude txns around
 * midnight. This formatter keeps the comparison aligned with capture
 * semantics.
 */
export function localDateString(ts: number): string {
  const d = new Date(ts)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Capture today's snapshot for every account. Returns counts of rows written,
 * updated in place, and skipped. Keeps one row per account per local day.
 *
 * `now` is injected for testability.
 */
export function captureSnapshots(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): { written: number; updated: number; skipped: number } {
  const accounts = sqlite
    .prepare('SELECT id, asset_class, is_debt, balance, simplefin_account_id FROM finance_accounts')
    .all() as AccountRow[]

  const today = startOfDayMs(now)
  const tomorrow = today + 24 * 60 * 60 * 1000

  let written = 0
  let updated = 0
  let skipped = 0

  const latestToday = sqlite.prepare(
    'SELECT id, balance, source FROM finance_balance_snapshots WHERE account_id = ? AND captured_at >= ? AND captured_at < ? ORDER BY captured_at DESC LIMIT 1'
  )
  const insert = sqlite.prepare(
    'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
  )
  const update = sqlite.prepare(
    'UPDATE finance_balance_snapshots SET balance = ?, captured_at = ?, source = ? WHERE id = ?'
  )

  for (const acct of accounts) {
    const todayRow = latestToday.get(acct.id, today, tomorrow) as
      | { id: number; balance: number; source: string }
      | undefined

    if (acct.asset_class === 'manual_asset') {
      if (todayRow) {
        skipped++
        continue
      }
      // No transactions to infer from. The stored `balance` IS the current
      // value; only carry it forward if explicitly set (non-null, non-zero).
      // Zero is treated as "not set yet" — captures of zero would clutter
      // the trajectory with noise.
      if (acct.balance == null || acct.balance === 0) {
        skipped++
        continue
      }
      insert.run(acct.id, now, acct.balance, 'manual')
      written++
      continue
    }

    if (hasLiveBalanceAuthority(acct)) {
      const live = round2(acct.balance ?? 0)
      if (!todayRow) {
        insert.run(acct.id, now, live, 'live')
        written++
        continue
      }
      if (todayRow.source === 'manual') {
        // A same-day user override wins until tomorrow.
        skipped++
        continue
      }
      if (Math.abs(live - todayRow.balance) >= 0.005) {
        // A later sync corrects the earlier same-day row (e.g. the 00:05
        // cron's) in place — still one row per account per day.
        update.run(live, now, 'live', todayRow.id)
        updated++
      } else {
        skipped++
      }
      continue
    }

    if (todayRow) {
      skipped++
      continue
    }
    const inferred = inferBalance(sqlite, acct.id, now)
    insert.run(acct.id, now, inferred, 'inferred')
    written++
  }

  return { written, updated, skipped }
}

/**
 * Infer the current balance of a transaction-backed account from its last
 * snapshot plus all txns since then. Falls back to summing every txn (with a
 * baseline of 0) when there's no prior snapshot.
 *
 * FALLBACK PATH ONLY: used for accounts with no live-balance authority
 * (CSV/statement imports). Live-linked accounts snapshot the synced balance
 * directly — inference over a partial ledger drifts and cannot self-correct.
 *
 * Sign convention: transaction `amount` follows the codebase rule of
 * `negative = expense / charge, positive = income / payment`. For ASSET
 * accounts that maps directly to balance change. For DEBT accounts the sign
 * inverts — a $50 charge (`amount = -50`) INCREASES the amount owed by 50,
 * and a $200 payment (`amount = +200`) DECREASES the amount owed by 200 —
 * because the stored snapshot.balance for a debt is the positive amount owed.
 * A debt is clamped at 0: a partial ledger (payments recorded without the
 * original charges) must never infer "the bank owes you".
 */
export function inferBalance(sqlite: SqliteForSnapshot, accountId: number, asOfMs: number): number {
  const acct = sqlite
    .prepare('SELECT is_debt FROM finance_accounts WHERE id = ? LIMIT 1')
    .get(accountId) as { is_debt: number } | undefined
  const isDebt = acct?.is_debt === 1

  const last = sqlite
    .prepare(
      'SELECT id, account_id, captured_at, balance, source FROM finance_balance_snapshots WHERE account_id = ? AND captured_at <= ? ORDER BY captured_at DESC LIMIT 1'
    )
    .get(accountId, asOfMs) as SnapshotRow | undefined

  // Sum txns strictly after the snapshot's date, up to and including today.
  // Transactions are date-only ('YYYY-MM-DD') in local time, so we use the
  // local-day formatter to keep date math aligned with snapshot semantics.
  const sinceDate = last ? localDateString(last.captured_at) : null
  const upToDate = localDateString(asOfMs)

  const sumRow = sinceDate
    ? sqlite
        .prepare(
          'SELECT COALESCE(SUM(amount), 0) AS s FROM finance_transactions WHERE account_id = ? AND date > ? AND date <= ?'
        )
        .get(accountId, sinceDate, upToDate)
    : sqlite
        .prepare(
          'SELECT COALESCE(SUM(amount), 0) AS s FROM finance_transactions WHERE account_id = ? AND date <= ?'
        )
        .get(accountId, upToDate)

  const sum = (sumRow as { s: number }).s
  const baseline = last ? last.balance : 0
  // For debt accounts the txn sign convention is opposite of the stored
  // balance: charges (-) raise what's owed, payments (+) reduce it.
  const delta = isDebt ? -sum : sum
  const value = Math.round((baseline + delta) * 100) / 100
  return isDebt ? Math.max(0, value) : value
}

/**
 * Write a manual snapshot for an account. Used by the renderer's
 * "Set balance" UI on the Accounts tab. Always writes — even if a snapshot
 * for today exists — so the most recent manual edit wins.
 */
export function setAccountBalance(
  sqlite: SqliteForSnapshot,
  accountId: number,
  balance: number,
  now: number = Date.now()
): void {
  sqlite
    .prepare(
      'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
    )
    .run(accountId, now, balance, 'manual')
  // Keep the legacy `balance` column on finance_accounts in sync so other
  // views that haven't migrated to snapshots still see the latest value.
  sqlite.prepare('UPDATE finance_accounts SET balance = ? WHERE id = ?').run(balance, accountId)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * One-shot repair: for every account with live-balance authority, delete its
 * 'inferred' snapshots (which drifted from bad baselines — they were never
 * anchored to a synced balance) and rebuild daily history by walking the txn
 * ledger BACKWARDS from the live balance: end-of-day(d−1) = end-of-day(d) −
 * that day's net change. 'manual' rows are never touched, and days that carry
 * one are not overwritten.
 *
 * The window is clipped to the account's txn coverage and to 365 days. For a
 * debt the walk stops at the first day it would go below 0 — earlier values
 * are unreconstructable from a partial ledger.
 */
export function rebuildLiveSnapshotHistory(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): { accounts: number; deleted: number; written: number } {
  const accounts = sqlite
    .prepare(
      "SELECT id, asset_class, is_debt, balance, simplefin_account_id FROM finance_accounts WHERE asset_class != 'manual_asset'"
    )
    .all() as AccountRow[]

  const deleteInferred = sqlite.prepare(
    "DELETE FROM finance_balance_snapshots WHERE account_id = ? AND source = 'inferred'"
  )
  const insert = sqlite.prepare(
    'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
  )

  let touched = 0
  let deleted = 0
  let written = 0

  for (const acct of accounts) {
    if (!hasLiveBalanceAuthority(acct)) continue
    touched++
    deleted += deleteInferred.run(acct.id).changes

    const sums = sqlite
      .prepare(
        'SELECT date, COALESCE(SUM(amount), 0) AS s FROM finance_transactions WHERE account_id = ? GROUP BY date'
      )
      .all(acct.id) as Array<{ date: string; s: number }>
    if (sums.length === 0) continue
    const sumByDay = new Map(sums.map((r) => [r.date, r.s]))
    const earliest = sums.reduce((min, r) => (r.date < min ? r.date : min), sums[0].date)

    const manualDays = new Set(
      (
        sqlite
          .prepare(
            "SELECT captured_at FROM finance_balance_snapshots WHERE account_id = ? AND source = 'manual'"
          )
          .all(acct.id) as Array<{ captured_at: number }>
      ).map((r) => localDateString(r.captured_at))
    )

    const isDebt = acct.is_debt === 1
    const floorDay = localDateString(startOfDayMs(now) - 365 * DAY_MS)
    const startDay = earliest > floorDay ? earliest : floorDay

    // Walk backwards from today's live balance. Rows are written at local noon
    // so they sort inside their calendar-day bucket; today itself is left to
    // captureSnapshots(), which writes the authoritative 'live' row.
    let balance = round2(acct.balance ?? 0)
    const cursor = new Date(startOfDayMs(now))
    for (;;) {
      const sum = sumByDay.get(localDateString(cursor.getTime())) ?? 0
      balance = round2(balance - (isDebt ? -sum : sum))
      cursor.setDate(cursor.getDate() - 1) // now at the previous day
      const dayStr = localDateString(cursor.getTime())
      if (dayStr < startDay) break
      if (isDebt && balance < 0) break
      if (!manualDays.has(dayStr)) {
        insert.run(acct.id, cursor.getTime() + DAY_MS / 2, balance, 'inferred')
        written++
      }
    }
  }

  return { accounts: touched, deleted, written }
}

export const SNAPSHOT_REPAIR_KEY = 'financeSnapshotRepairV1'

/**
 * App-launch wrapper for the one-shot repair: runs the history rebuild plus a
 * fresh capture exactly once per install, gated on an app_settings key. The
 * gate is written only AFTER success so a crash mid-repair retries next
 * launch (the rebuild is delete-then-rewrite, so a retry is safe).
 */
export function runSnapshotRepairIfNeeded(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): { ran: boolean } {
  return runOnceGated(
    sqlite,
    SNAPSHOT_REPAIR_KEY,
    () => {
      rebuildLiveSnapshotHistory(sqlite, now)
      captureSnapshots(sqlite, now)
      return {}
    },
    now
  )
}

export type NetWorthSnapshot = {
  // The currency every total below is expressed in (Phase 11.1). 'USD' unless
  // the user picked a different base.
  baseCurrency: string
  assets: number // base currency
  liabilities: number // base currency
  net: number // base currency
  byAccount: Array<{
    accountId: number
    name: string
    assetClass: string
    isDebt: boolean
    currency: string // the account's NATIVE currency
    balance: number // latest balance in the NATIVE currency
    baseBalance: number | null // `balance` converted to base (null = no FX rate)
    capturedAt: number | null
  }>
  // Foreign accounts that couldn't be valued in the base currency (no FX rate
  // on file). Excluded from the totals above so they stay honest; surfaced so
  // the UI can prompt the user to add a rate.
  unconverted: Array<{ accountId: number; name: string; currency: string; balance: number }>
  // Brokerage/investment holdings (Phase 10.2 records snapshots). When
  // `marketValue` is non-null it is ALREADY INCLUDED in `assets`/`net` above;
  // null means no holdings data (or holdings deliberately excluded — see the
  // double-count guard in getNetWorthSnapshot).
  holdings: { marketValue: number | null; asOf: string | null; positions: number }
  deltas: { d30: number | null; d90: number | null; d365: number | null }
}

/**
 * Double-count guard for holdings: if the user has a LIVE-linked investment
 * account (SimpleFIN/Plaid), that account's balance already lands in
 * `finance_accounts` and is counted in the account totals — adding a holdings
 * snapshot of (potentially) the same positions on top would double count. In
 * that case holdings are kept out of the totals entirely (the standalone
 * Holdings card still shows them). This is deliberately coarse: it can't tell
 * whether the linked account and the imported CSV are the same brokerage, so
 * it errs on the side of never over-reporting net worth.
 */
function hasLiveInvestmentAccount(sqlite: SqliteForSnapshot): boolean {
  try {
    const row = sqlite
      .prepare(
        `SELECT 1 FROM finance_accounts
          WHERE type = 'investment'
            AND (plaid_account_id IS NOT NULL OR simplefin_account_id IS NOT NULL)
          LIMIT 1`
      )
      .get()
    return row != null
  } catch {
    // Older DB without the linkage columns — no live accounts, no guard.
    return false
  }
}

/**
 * Latest balance per account + net-worth totals + deltas, rolled up into the
 * user's base currency (Phase 11.1). Each account's balance is taken from its
 * most recent snapshot in its NATIVE currency (or 0 if none yet), then converted
 * to base via the latest FX snapshot. Foreign accounts with no rate are listed
 * in `unconverted` and left out of the totals.
 */
export function getNetWorthSnapshot(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): NetWorthSnapshot {
  const accounts = sqlite
    .prepare(
      `SELECT a.id, a.name, a.asset_class, a.is_debt, a.currency, a.balance
         FROM finance_accounts a`
    )
    .all() as Array<{
    id: number
    name: string
    asset_class: string
    is_debt: number
    currency: string | null
    balance: number | null
  }>

  const { base, toBase } = makeBaseConverter(sqlite)
  const byAccount: NetWorthSnapshot['byAccount'] = []
  const unconverted: NetWorthSnapshot['unconverted'] = []
  let assets = 0
  let liabilities = 0

  for (const a of accounts) {
    const last = sqlite
      .prepare(
        'SELECT balance, captured_at FROM finance_balance_snapshots WHERE account_id = ? AND captured_at <= ? ORDER BY captured_at DESC LIMIT 1'
      )
      .get(a.id, now) as { balance: number; captured_at: number } | undefined

    // Prefer a captured historical snapshot; fall back to the account's LIVE balance
    // (refreshed every sync by SimpleFIN/Plaid) so net worth is real on a fresh
    // install before the 00:05 snapshot cron has ever run, instead of showing $0.
    const balance = last?.balance ?? a.balance ?? 0
    const capturedAt = last?.captured_at ?? null
    const currency = (a.currency || base).toUpperCase()
    const baseBalance = toBase(balance, currency)

    byAccount.push({
      accountId: a.id,
      name: a.name,
      assetClass: a.asset_class,
      isDebt: a.is_debt === 1,
      currency,
      balance,
      baseBalance,
      capturedAt
    })

    if (baseBalance == null) {
      // Foreign balance with no rate — keep it out of the totals, flag it.
      unconverted.push({ accountId: a.id, name: a.name, currency, balance })
      continue
    }
    if (a.is_debt === 1) liabilities += baseBalance
    else assets += baseBalance
  }

  // ── Brokerage/investment holdings (Phase 10.2) ──────────────────────────
  // The latest positions snapshot (records sources in
  // NET_WORTH_HOLDINGS_SOURCES) rolls into the assets total. Holdings payloads
  // store plain numbers with NO currency (see ParsedHolding in
  // finance-holdings.ts), so they are treated as base-currency values —
  // no FX conversion applies. With zero holdings records this whole block is
  // a no-op and the totals are byte-identical to the accounts-only math.
  const holdingsNow = hasLiveInvestmentAccount(sqlite)
    ? null
    : getHoldingsValueAsOf(sqlite, NET_WORTH_HOLDINGS_SOURCES, now)
  if (holdingsNow != null) assets += holdingsNow.marketValue

  const net = assets - liabilities

  return {
    baseCurrency: base,
    assets: round2(assets),
    liabilities: round2(liabilities),
    net: round2(net),
    byAccount,
    unconverted,
    holdings: holdingsNow ?? { marketValue: null, asOf: null, positions: 0 },
    deltas: {
      d30: deltaSince(sqlite, 30, now, net, holdingsNow?.marketValue ?? null),
      d90: deltaSince(sqlite, 90, now, net, holdingsNow?.marketValue ?? null),
      d365: deltaSince(sqlite, 365, now, net, holdingsNow?.marketValue ?? null)
    }
  }
}

/**
 * Net-worth change vs `days` ago, in the base currency. Past native balances
 * are converted at the LATEST rate (constant FX) so the delta reflects real
 * balance movement, not currency swings — FX gain/loss is tracked separately.
 * Foreign accounts with no rate are skipped (same policy as the live totals).
 *
 * Holdings delta rule: `currentHoldings` is the holdings market value that is
 * already inside `currentNet` (null when holdings aren't in the totals).
 * Holdings only participate in a delta when BOTH sides have a value — i.e. a
 * dated holdings snapshot exists at/before the cutoff. If none exists back
 * then (e.g. the first positions CSV was imported last week), including
 * current holdings on only one side would register the entire portfolio as a
 * fake 30/90/365-day "gain" — so holdings are excluded from BOTH sides and
 * the delta reflects account movement only.
 */
function deltaSince(
  sqlite: SqliteForSnapshot,
  days: number,
  now: number,
  currentNet: number,
  currentHoldings: number | null
): number | null {
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const accounts = sqlite
    .prepare('SELECT id, is_debt, currency FROM finance_accounts')
    .all() as Array<{
    id: number
    is_debt: number
    currency: string | null
  }>

  const { toBase } = makeBaseConverter(sqlite)
  let assets = 0
  let liabilities = 0
  let foundAny = false
  let foundAnyAccount = false

  for (const a of accounts) {
    const past = sqlite
      .prepare(
        'SELECT balance FROM finance_balance_snapshots WHERE account_id = ? AND captured_at <= ? ORDER BY captured_at DESC LIMIT 1'
      )
      .get(a.id, cutoff) as { balance: number } | undefined
    if (!past) continue
    const baseBalance = toBase(past.balance, a.currency)
    if (baseBalance == null) continue
    foundAny = true
    foundAnyAccount = true
    if (a.is_debt === 1) liabilities += baseBalance
    else assets += baseBalance
  }

  // Apply the holdings delta rule documented above: match the past holdings
  // snapshot at the cutoff against the current one, or drop holdings from
  // both sides when no snapshot existed back then.
  let effectiveNet = currentNet
  if (currentHoldings != null) {
    const past = getHoldingsValueAsOf(sqlite, NET_WORTH_HOLDINGS_SOURCES, cutoff)
    if (past != null) {
      assets += past.marketValue
      foundAny = true
      // No account balance snapshot existed at the cutoff, so current account
      // balances have no past counterpart. Exclude them from effectiveNet so
      // the delta reflects only holdings movement and doesn't inflate by
      // treating current account balances as a fake gain.
      if (!foundAnyAccount) {
        effectiveNet = currentHoldings
      }
    } else {
      effectiveNet -= currentHoldings
    }
  }

  if (!foundAny) return null
  const pastNet = assets - liabilities
  return round2(effectiveNet - pastNet)
}

export type TrajectoryPoint = {
  accountId: number
  accountName: string
  assetClass: string
  // Snapshot totals (and tile math) classify liabilities by `is_debt`, not by
  // `asset_class`. The Accounts-tab upsert IPC only persists `is_debt` and
  // leaves `asset_class` at the default 'spending' for new debt accounts, so
  // the trajectory must surface `is_debt` too — otherwise the chart and the
  // tiles disagree about which buckets count as liabilities.
  isDebt: boolean
  date: string // 'YYYY-MM-DD'
  currency: string // the account's NATIVE currency (Phase 11.1)
  balance: number // NATIVE-currency balance on that day
  // `balance` converted to the base currency at the LATEST rate (constant FX),
  // so a summed total line across mixed-currency accounts is valid. null when a
  // foreign account has no rate. For USD-only data this equals `balance`.
  baseBalance: number | null
}

/**
 * Returns every snapshot in the requested window, suitable for rendering a
 * trajectory chart. Caller groups by account/date as needed. Each point carries
 * both its native balance and a base-currency value (Phase 11.1) so the caller
 * can sum across accounts in one currency.
 */
export function getNetWorthTrajectory(
  sqlite: SqliteForSnapshot,
  opts: { sinceMs?: number; untilMs?: number } = {}
): TrajectoryPoint[] {
  const since = opts.sinceMs ?? 0
  const until = opts.untilMs ?? Date.now()

  const rows = sqlite
    .prepare(
      `SELECT s.account_id, a.name, a.asset_class, a.is_debt, a.currency, s.captured_at, s.balance
         FROM finance_balance_snapshots s
         JOIN finance_accounts a ON a.id = s.account_id
        WHERE s.captured_at >= ? AND s.captured_at <= ?
     ORDER BY s.captured_at ASC`
    )
    .all(since, until) as Array<{
    account_id: number
    name: string
    asset_class: string
    is_debt: number
    currency: string | null
    captured_at: number
    balance: number
  }>

  const { base, toBase } = makeBaseConverter(sqlite)

  return rows.map((r) => {
    const currency = (r.currency || base).toUpperCase()
    return {
      accountId: r.account_id,
      accountName: r.name,
      assetClass: r.asset_class,
      isDebt: r.is_debt === 1,
      // Local-day formatter — matches the snapshot's local-day bucket.
      date: localDateString(r.captured_at),
      currency,
      balance: r.balance,
      baseBalance: toBase(r.balance, currency)
    }
  })
}
