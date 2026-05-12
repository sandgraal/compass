import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  captureSnapshots,
  getNetWorthSnapshot,
  getNetWorthTrajectory,
  inferBalance,
  setAccountBalance,
  startOfDayMs
} from './finance-snapshot'

const DAY_MS = 24 * 60 * 60 * 1000

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      asset_class TEXT NOT NULL DEFAULT 'spending'
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER REFERENCES finance_accounts(id),
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX idx_snap_acct_cap ON finance_balance_snapshots(account_id, captured_at);
  `)
  return sqlite
}

let sqlite: Database.Database

beforeEach(() => {
  sqlite = makeDb()
})

describe('startOfDayMs', () => {
  it('rounds to local midnight', () => {
    const ts = new Date('2026-05-11T15:42:33.123').getTime()
    const start = startOfDayMs(ts)
    const d = new Date(start)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMilliseconds()).toBe(0)
  })
})

describe('inferBalance', () => {
  it('returns 0 for an empty account', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()
    expect(inferBalance(sqlite, 1, Date.now())).toBe(0)
  })

  it('sums all transactions when there is no prior snapshot', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-04-01', 1000)"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-04-15', -200)"
      )
      .run()
    expect(inferBalance(sqlite, 1, new Date('2026-05-01').getTime())).toBe(800)
  })

  it('applies snapshot baseline + only newer transactions', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()
    // Old txns that should be IGNORED because they predate the snapshot.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-03-01', 500)"
      )
      .run()
    // Snapshot taken on 2026-04-01 says balance = 1000 (the txn above is rolled in).
    sqlite
      .prepare(
        "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (1, ?, 1000, 'manual')"
      )
      .run(new Date('2026-04-01T00:00:00').getTime())
    // Newer txns AFTER the snapshot.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-04-10', 300)"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-04-20', -50)"
      )
      .run()
    expect(inferBalance(sqlite, 1, new Date('2026-05-01').getTime())).toBe(1250)
  })
})

describe('captureSnapshots', () => {
  it('creates one snapshot per non-manual_asset account on first run', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, asset_class) VALUES (1, 'Chase', 'spending')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, asset_class) VALUES (2, 'Amex', 'liability')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (account_id, date, amount) VALUES (1, '2026-05-10', 100)"
      )
      .run()

    const result = captureSnapshots(sqlite, new Date('2026-05-11T08:00:00').getTime())
    expect(result.written).toBe(2)
    expect(result.skipped).toBe(0)
  })

  it('is idempotent within a single calendar day', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()

    const morning = new Date('2026-05-11T08:00:00').getTime()
    const evening = new Date('2026-05-11T22:00:00').getTime()

    expect(captureSnapshots(sqlite, morning).written).toBe(1)
    const second = captureSnapshots(sqlite, evening)
    expect(second.written).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('captures again on a new day', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()

    captureSnapshots(sqlite, new Date('2026-05-11T08:00:00').getTime())
    const dayTwo = captureSnapshots(sqlite, new Date('2026-05-12T08:00:00').getTime())
    expect(dayTwo.written).toBe(1)
  })

  it('skips manual_asset accounts that have no balance set', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, asset_class, balance) VALUES (1, 'CR Property', 'manual_asset', 0)"
      )
      .run()
    const result = captureSnapshots(sqlite)
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('captures manual_asset accounts that DO have a balance', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, asset_class, balance) VALUES (1, 'CR Property', 'manual_asset', 250000)"
      )
      .run()
    captureSnapshots(sqlite)
    const row = sqlite.prepare('SELECT balance, source FROM finance_balance_snapshots').get() as {
      balance: number
      source: string
    }
    expect(row.balance).toBe(250000)
    expect(row.source).toBe('manual')
  })
})

describe('setAccountBalance', () => {
  it('writes a manual snapshot and updates the legacy balance column', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name, balance) VALUES (1, 'Chase', 0)").run()
    setAccountBalance(sqlite, 1, 12500)

    const snap = sqlite.prepare('SELECT balance, source FROM finance_balance_snapshots').get() as {
      balance: number
      source: string
    }
    expect(snap.balance).toBe(12500)
    expect(snap.source).toBe('manual')

    const acct = sqlite.prepare('SELECT balance FROM finance_accounts WHERE id = 1').get() as {
      balance: number
    }
    expect(acct.balance).toBe(12500)
  })

  it('always writes — even if a snapshot for today exists', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()
    setAccountBalance(sqlite, 1, 100)
    setAccountBalance(sqlite, 1, 200)
    const count = sqlite.prepare('SELECT COUNT(*) as n FROM finance_balance_snapshots').get() as {
      n: number
    }
    expect(count.n).toBe(2)
  })
})

describe('getNetWorthSnapshot', () => {
  it('computes assets - liabilities = net from latest per-account snapshots', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, is_debt, asset_class) VALUES (1, 'Chase', 0, 'spending')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, is_debt, asset_class) VALUES (2, 'Amex', 1, 'liability')"
      )
      .run()
    setAccountBalance(sqlite, 1, 5000)
    setAccountBalance(sqlite, 2, 1200)

    const snap = getNetWorthSnapshot(sqlite)
    expect(snap.assets).toBe(5000)
    expect(snap.liabilities).toBe(1200)
    expect(snap.net).toBe(3800)
    expect(snap.byAccount).toHaveLength(2)
  })

  it('returns 0 balance for accounts with no snapshots', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'New Account')").run()
    const snap = getNetWorthSnapshot(sqlite)
    expect(snap.byAccount[0].balance).toBe(0)
    expect(snap.byAccount[0].capturedAt).toBeNull()
  })

  it('returns null deltas when there are no historical snapshots in the window', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name, is_debt) VALUES (1, 'Chase', 0)").run()
    setAccountBalance(sqlite, 1, 5000)
    const snap = getNetWorthSnapshot(sqlite)
    expect(snap.deltas.d30).toBeNull()
    expect(snap.deltas.d90).toBeNull()
    expect(snap.deltas.d365).toBeNull()
  })

  it('computes a 30-day delta from a snapshot 31 days ago', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name, is_debt) VALUES (1, 'Chase', 0)").run()
    const now = Date.now()
    sqlite
      .prepare(
        "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (1, ?, 1000, 'manual')"
      )
      .run(now - 31 * DAY_MS)
    sqlite
      .prepare(
        "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (1, ?, 1500, 'manual')"
      )
      .run(now)

    const snap = getNetWorthSnapshot(sqlite, now)
    expect(snap.net).toBe(1500)
    expect(snap.deltas.d30).toBe(500)
  })
})

describe('getNetWorthTrajectory', () => {
  it('returns every snapshot in chronological order with account metadata', () => {
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (id, name, asset_class) VALUES (1, 'Chase', 'spending')"
      )
      .run()
    const t1 = new Date('2026-01-01T00:00:00').getTime()
    const t2 = new Date('2026-02-01T00:00:00').getTime()
    sqlite
      .prepare(
        "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (1, ?, 100, 'manual'), (1, ?, 200, 'manual')"
      )
      .run(t1, t2)

    const traj = getNetWorthTrajectory(sqlite)
    expect(traj).toHaveLength(2)
    expect(traj[0].balance).toBe(100)
    expect(traj[1].balance).toBe(200)
    expect(traj[0].accountName).toBe('Chase')
    expect(traj[0].assetClass).toBe('spending')
    expect(traj[0].date).toBe('2026-01-01')
  })

  it('clips to the requested window', () => {
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Chase')").run()
    const old = new Date('2025-01-01').getTime()
    const recent = new Date('2026-04-01').getTime()
    sqlite
      .prepare(
        "INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (1, ?, 100, 'manual'), (1, ?, 200, 'manual')"
      )
      .run(old, recent)

    const traj = getNetWorthTrajectory(sqlite, {
      sinceMs: new Date('2026-01-01').getTime(),
      untilMs: new Date('2026-12-31').getTime()
    })
    expect(traj).toHaveLength(1)
    expect(traj[0].balance).toBe(200)
  })
})
