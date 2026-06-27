/**
 * Net-worth balance snapshots (Phase 4.4).
 *
 * For accounts with a transaction stream we infer today's balance as
 *   `previous_snapshot.balance + Σ(txns where date > previous_snapshot.capturedAt)`
 * For `manual_asset` accounts (CR property, collectibles) the balance is only
 * updated when the user calls `setAccountBalance()` — they have no txns.
 *
 * The capture is idempotent within a calendar day: if a snapshot for an
 * account already exists for today, captureSnapshots() skips it. This makes
 * the cron safe to run from multiple entry points without dupes.
 *
 * Pure SQLite — accepts a thin interface so it can run in tests against
 * `better-sqlite3` directly without going through Drizzle.
 */

import { getBaseCurrency, loadFxRates, pickRate } from './finance-fx'

export type SnapshotSource = 'manual' | 'inferred' | 'plaid'

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
 * Capture today's snapshot for every account. Returns count of rows written.
 * Skips accounts that already have a snapshot for today (idempotent).
 *
 * `now` is injected for testability.
 */
export function captureSnapshots(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): { written: number; skipped: number } {
  const accounts = sqlite
    .prepare('SELECT id, asset_class, is_debt, balance FROM finance_accounts')
    .all() as AccountRow[]

  const today = startOfDayMs(now)
  const tomorrow = today + 24 * 60 * 60 * 1000

  let written = 0
  let skipped = 0

  const existsToday = sqlite.prepare(
    'SELECT 1 FROM finance_balance_snapshots WHERE account_id = ? AND captured_at >= ? AND captured_at < ? LIMIT 1'
  )
  const insert = sqlite.prepare(
    'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
  )

  for (const acct of accounts) {
    if (existsToday.get(acct.id, today, tomorrow)) {
      skipped++
      continue
    }

    if (acct.asset_class === 'manual_asset') {
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

    const inferred = inferBalance(sqlite, acct.id, now)
    insert.run(acct.id, now, inferred, 'inferred')
    written++
  }

  return { written, skipped }
}

/**
 * Infer the current balance of a transaction-backed account from its last
 * snapshot plus all txns since then. Falls back to summing every txn (with
 * `account.balance` as a baseline of 0) when there's no prior snapshot.
 *
 * Sign convention: transaction `amount` follows the codebase rule of
 * `negative = expense / charge, positive = income / payment`. For ASSET
 * accounts that maps directly to balance change. For DEBT accounts the sign
 * inverts — a $50 charge (`amount = -50`) INCREASES the amount owed by 50,
 * and a $200 payment (`amount = +200`) DECREASES the amount owed by 200 —
 * because the stored snapshot.balance for a debt is the positive amount owed.
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
  return Math.round((baseline + delta) * 100) / 100
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
  deltas: { d30: number | null; d90: number | null; d365: number | null }
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
      `SELECT a.id, a.name, a.asset_class, a.is_debt, a.currency
         FROM finance_accounts a`
    )
    .all() as Array<{
    id: number
    name: string
    asset_class: string
    is_debt: number
    currency: string | null
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

    const balance = last?.balance ?? 0
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

  const net = assets - liabilities

  return {
    baseCurrency: base,
    assets: round2(assets),
    liabilities: round2(liabilities),
    net: round2(net),
    byAccount,
    unconverted,
    deltas: {
      d30: deltaSince(sqlite, 30, now, net),
      d90: deltaSince(sqlite, 90, now, net),
      d365: deltaSince(sqlite, 365, now, net)
    }
  }
}

/**
 * Net-worth change vs `days` ago, in the base currency. Past native balances
 * are converted at the LATEST rate (constant FX) so the delta reflects real
 * balance movement, not currency swings — FX gain/loss is tracked separately.
 * Foreign accounts with no rate are skipped (same policy as the live totals).
 */
function deltaSince(
  sqlite: SqliteForSnapshot,
  days: number,
  now: number,
  currentNet: number
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
    if (a.is_debt === 1) liabilities += baseBalance
    else assets += baseBalance
  }

  if (!foundAny) return null
  const pastNet = assets - liabilities
  return round2(currentNet - pastNet)
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
