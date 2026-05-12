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

export type SnapshotSource = 'manual' | 'inferred' | 'plaid'

export type SqliteForSnapshot = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
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
  // Transactions are date-only ('YYYY-MM-DD'), so we compare as ISO strings.
  const sinceDate = last ? new Date(last.captured_at).toISOString().slice(0, 10) : null
  const upToDate = new Date(asOfMs).toISOString().slice(0, 10)

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
  assets: number
  liabilities: number
  net: number
  byAccount: Array<{
    accountId: number
    name: string
    assetClass: string
    isDebt: boolean
    balance: number
    capturedAt: number | null
  }>
  deltas: { d30: number | null; d90: number | null; d365: number | null }
}

/**
 * Latest balance per account + net-worth totals + deltas. The account-side
 * balance comes from the most recent snapshot (or 0 if no snapshots exist
 * for that account yet, e.g. brand-new install).
 */
export function getNetWorthSnapshot(
  sqlite: SqliteForSnapshot,
  now: number = Date.now()
): NetWorthSnapshot {
  const accounts = sqlite
    .prepare(
      `SELECT a.id, a.name, a.asset_class, a.is_debt
         FROM finance_accounts a`
    )
    .all() as Array<{ id: number; name: string; asset_class: string; is_debt: number }>

  const byAccount: NetWorthSnapshot['byAccount'] = []
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

    byAccount.push({
      accountId: a.id,
      name: a.name,
      assetClass: a.asset_class,
      isDebt: a.is_debt === 1,
      balance,
      capturedAt
    })

    if (a.is_debt === 1) liabilities += balance
    else assets += balance
  }

  const net = assets - liabilities

  return {
    assets: Math.round(assets * 100) / 100,
    liabilities: Math.round(liabilities * 100) / 100,
    net: Math.round(net * 100) / 100,
    byAccount,
    deltas: {
      d30: deltaSince(sqlite, 30, now, net),
      d90: deltaSince(sqlite, 90, now, net),
      d365: deltaSince(sqlite, 365, now, net)
    }
  }
}

function deltaSince(
  sqlite: SqliteForSnapshot,
  days: number,
  now: number,
  currentNet: number
): number | null {
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const accounts = sqlite.prepare('SELECT id, is_debt FROM finance_accounts').all() as Array<{
    id: number
    is_debt: number
  }>

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
    foundAny = true
    if (a.is_debt === 1) liabilities += past.balance
    else assets += past.balance
  }

  if (!foundAny) return null
  const pastNet = assets - liabilities
  return Math.round((currentNet - pastNet) * 100) / 100
}

export type TrajectoryPoint = {
  accountId: number
  accountName: string
  assetClass: string
  date: string // 'YYYY-MM-DD'
  balance: number
}

/**
 * Returns every snapshot in the requested window, suitable for rendering a
 * trajectory chart. Caller groups by account/date as needed.
 */
export function getNetWorthTrajectory(
  sqlite: SqliteForSnapshot,
  opts: { sinceMs?: number; untilMs?: number } = {}
): TrajectoryPoint[] {
  const since = opts.sinceMs ?? 0
  const until = opts.untilMs ?? Date.now()

  const rows = sqlite
    .prepare(
      `SELECT s.account_id, a.name, a.asset_class, s.captured_at, s.balance
         FROM finance_balance_snapshots s
         JOIN finance_accounts a ON a.id = s.account_id
        WHERE s.captured_at >= ? AND s.captured_at <= ?
     ORDER BY s.captured_at ASC`
    )
    .all(since, until) as Array<{
    account_id: number
    name: string
    asset_class: string
    captured_at: number
    balance: number
  }>

  return rows.map((r) => ({
    accountId: r.account_id,
    accountName: r.name,
    assetClass: r.asset_class,
    date: new Date(r.captured_at).toISOString().slice(0, 10),
    balance: r.balance
  }))
}
