/**
 * Tests for the proactive-insights aggregator (Phase 7 Track E). Real
 * in-memory SQLite; the clock is pinned so month/window math is
 * deterministic. Each detector gets a flagged case, a below-threshold case,
 * and its exclusion rules.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

const db = () => drizzle(sqlite, { schema })

// Pinned mid-month so the current month has meaningful data.
const NOW = new Date('2026-06-15T12:00:00')

function addTxn(date: string, amount: number, category: string): void {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?, ?, ?, ?, ?)'
    )
    .run(`${date}-${amount}-${category}-${Math.random()}`, date, amount, 'test txn', category)
}

function addHabit(name: string, active = 1): number {
  const r = sqlite.prepare('INSERT INTO habits (name, active) VALUES (?, ?)').run(name, active)
  return Number(r.lastInsertRowid)
}

function addEntry(habitId: number, date: string, completed = 1): void {
  sqlite
    .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (?, ?, ?)')
    .run(habitId, date, completed)
}

function addNote(path: string, title: string, lastModified: Date, autoUpdated = 0): void {
  sqlite
    .prepare(
      'INSERT INTO knowledge_files (path, title, last_modified, auto_updated) VALUES (?, ?, ?, ?)'
    )
    .run(path, title, lastModified.getTime(), autoUpdated)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      account_id INTEGER,
      category TEXT DEFAULT 'Uncategorized',
      subcategory TEXT,
      notes TEXT,
      geo TEXT NOT NULL DEFAULT 'US',
      purpose TEXT,
      tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      tax_tag_source TEXT NOT NULL DEFAULT 'auto',
      tax_year INTEGER,
      source_file TEXT,
      ingested_at INTEGER
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT DEFAULT '#6272f1',
      active INTEGER DEFAULT 1,
      created_at INTEGER,
      auto_link_source TEXT,
      auto_link_threshold REAL
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      source TEXT
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0,
      auto_updated INTEGER DEFAULT 0
    );
  `)
})

// The cross-domain domain tables are created PER-DESCRIBE (matching the
// goal/renewal/paycheck/utility convention above) — the shared beforeEach
// deliberately omits them so each detector's safeDetect guard is exercised by
// the empty-DB test.
function createRecordsTable(): void {
  sqlite.exec(`CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
    occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
    dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
  );`)
}
function createSubscriptionsTable(): void {
  sqlite.exec(`CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
    status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, payment_account TEXT,
    cancel_url TEXT, notes TEXT, source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER, updated_at INTEGER
  );`)
}
function createPaystubsTable(): void {
  sqlite.exec(`CREATE TABLE argyle_paystubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
    gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
    currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT, paid_at TEXT,
    pay_cycle TEXT, ingested_at INTEGER
  );`)
}

let recSeq = 0
function addRecord(
  source: string,
  type: string,
  occurredAt: number | null,
  opts: { title?: string; payload?: unknown } = {}
): void {
  recSeq++
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(
      source,
      type,
      occurredAt,
      opts.title ?? `${source} ${type}`,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
      `rec-${recSeq}`
    )
}

let subSeq = 0
function addSubscription(
  name: string,
  cost: number,
  opts: { cadence?: string; status?: string } = {}
): void {
  subSeq++
  sqlite
    .prepare(
      'INSERT INTO subscriptions (external_id, name, cost, cadence, status) VALUES (?,?,?,?,?)'
    )
    .run(
      `sub-${name}-${subSeq}`,
      name,
      cost,
      opts.cadence ?? 'monthly',
      opts.status ?? 'active'
    )
}

let paystubSeq = 0
function addPaystub(paidAt: string, netPay: number, employer = 'Initech'): void {
  paystubSeq++
  sqlite
    .prepare(
      'INSERT INTO argyle_paystubs (external_id, employer, net_pay, paid_at) VALUES (?,?,?,?)'
    )
    .run(`ps-${paidAt}-${paystubSeq}`, employer, netPay, paidAt)
}

/** epoch ms for a local 'YYYY-MM-DD' at midnight (matches the projectors' idiom). */
function ymdMs(ymd: string): number {
  return new Date(`${ymd}T00:00:00`).getTime()
}

afterEach(() => {
  sqlite.close()
})

describe('buildInsights — empty DB', () => {
  it('returns no insights', async () => {
    const { buildInsights } = await import('./insights')
    const r = buildInsights(db(), NOW)
    expect(r.insights).toEqual([])
    expect(r.generatedAt).toBe(NOW.toISOString())
  })
})

describe('spending anomalies', () => {
  it('flags a category well above its 3-month average', async () => {
    const { buildInsights } = await import('./insights')
    // Baseline: $100/mo Dining for Mar–May. Current month: $300.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Dining')
    addTxn('2026-06-05', -180, 'Dining')
    addTxn('2026-06-10', -120, 'Dining')

    const r = buildInsights(db(), NOW)
    const anomaly = r.insights.find((i) => i.kind === 'spending-anomaly')
    expect(anomaly).toBeDefined()
    expect(anomaly?.title).toContain('Dining')
    expect(anomaly?.title).toContain('200%') // 300 vs 100 avg
    expect(anomaly?.severity).toBe('warn')
  })

  it('does not flag below the ratio or delta floors, and ignores Transfers + income', async () => {
    const { buildInsights } = await import('./insights')
    // 40% over: below the 1.5x ratio.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Groceries')
    addTxn('2026-06-05', -140, 'Groceries')
    // Tiny category: ratio met but < $50 delta.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -10, 'Coffee')
    addTxn('2026-06-05', -40, 'Coffee')
    // Transfers always excluded; income (positive) never counts as spend.
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Transfers')
    addTxn('2026-06-05', -900, 'Transfers')
    addTxn('2026-06-05', 5000, 'Income')

    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'spending-anomaly')).toEqual([])
  })

  it('caps anomalies at 3, ordered by dollar delta', async () => {
    const { buildInsights } = await import('./insights')
    const cats = ['A', 'B', 'C', 'D']
    cats.forEach((cat, i) => {
      for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, cat)
      addTxn('2026-06-05', -(300 + i * 100), cat) // D has the largest delta
    })
    const r = buildInsights(db(), NOW)
    const anomalies = r.insights.filter((i) => i.kind === 'spending-anomaly')
    expect(anomalies).toHaveLength(3)
    expect(anomalies[0].title).toContain('D')
  })
})

describe('uncategorized spend', () => {
  it('flags when count or total crosses the floor, within the window', async () => {
    const { buildInsights } = await import('./insights')
    addTxn('2026-06-01', -150, 'Uncategorized') // total ≥ $100 triggers alone
    addTxn('2026-01-01', -900, 'Uncategorized') // outside the 60-day window
    const r = buildInsights(db(), NOW)
    const insight = r.insights.find((i) => i.kind === 'uncategorized-spend')
    expect(insight?.title).toContain('$150')
    expect(insight?.detail).toContain('1 transaction')
  })

  it('treats legacy NULL categories as uncategorized', async () => {
    const { buildInsights } = await import('./insights')
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (hash, date, amount, description, category) VALUES (?, ?, ?, ?, NULL)'
      )
      .run('null-cat', '2026-06-01', -150, 'legacy row')
    const r = buildInsights(db(), NOW)
    expect(r.insights.find((i) => i.kind === 'uncategorized-spend')?.title).toContain('$150')
  })

  it('stays quiet below both floors', async () => {
    const { buildInsights } = await import('./insights')
    addTxn('2026-06-01', -20, 'Uncategorized')
    addTxn('2026-06-02', -30, 'Uncategorized')
    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'uncategorized-spend')).toEqual([])
  })
})

describe('habit slippage', () => {
  it('flags a previously consistent habit with ≤1 check-in this week', async () => {
    const { buildInsights } = await import('./insights')
    const id = addHabit('Meditation')
    // Prior three weeks (May 19 – Jun 8): 18 completions — well over the 50% floor.
    for (let d = 19; d <= 31; d++) addEntry(id, `2026-05-${d}`)
    for (let d = 1; d <= 5; d++) addEntry(id, `2026-06-0${d}`)
    // This week (Jun 9–15): one lone check-in.
    addEntry(id, '2026-06-12')

    const r = buildInsights(db(), NOW)
    const slip = r.insights.find((i) => i.kind === 'habit-slippage')
    expect(slip?.title).toBe('Meditation is slipping')
    expect(slip?.detail).toContain('1 check-in this week')
  })

  it('ignores habits still on track, inactive habits, and sparse habits', async () => {
    const { buildInsights } = await import('./insights')
    // On track: checked nearly every day including this week.
    const onTrack = addHabit('Reading')
    for (let d = 1; d <= 15; d++) addEntry(onTrack, `2026-06-${String(d).padStart(2, '0')}`)
    // Inactive habit with slippage pattern — excluded.
    const inactive = addHabit('Old habit', 0)
    for (let d = 19; d <= 31; d++) addEntry(inactive, `2026-05-${d}`)
    // Sparse habit (never consistent) — prior rate below floor.
    const sparse = addHabit('Stretching')
    addEntry(sparse, '2026-05-20')
    addEntry(sparse, '2026-05-28')

    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'habit-slippage')).toEqual([])
  })
})

describe('stale notes', () => {
  it('flags old user-authored notes, oldest first, excluding auto-updated + mirrors', async () => {
    const { buildInsights } = await import('./insights')
    addNote('profile/goals.md', 'Goals', new Date('2025-12-01'))
    addNote('work/old-plan.md', 'Old Plan', new Date('2026-01-15'))
    addNote('calendar/upcoming.md', 'Upcoming', new Date('2025-11-01'), 1) // auto-updated
    addNote('notion/imported.md', 'Imported', new Date('2025-11-01')) // mirror namespace
    addNote('obsidian/vault-note.md', 'Vault Note', new Date('2025-11-01')) // mirror namespace
    addNote('profile/fresh.md', 'Fresh', new Date('2026-06-01')) // recent

    const r = buildInsights(db(), NOW)
    const stale = r.insights.find((i) => i.kind === 'stale-notes')
    expect(stale?.title).toContain('2 notes')
    expect(stale?.detail).toContain('Goals')
    expect(stale?.detail).not.toContain('Imported')
    expect(stale?.detail).not.toContain('Upcoming')
  })
})

// ── Cross-domain detectors (data-access policy wiring) ───────────────────────
// Their tables are created per-describe; the shared beforeEach deliberately
// omits them so the empty-DB test also proves safeDetect() guards older DBs.

describe('goal off-track', () => {
  function createGoals(): void {
    sqlite.exec(`
      CREATE TABLE financial_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
        target_amount REAL NOT NULL DEFAULT 0, target_date TEXT, source TEXT NOT NULL DEFAULT 'manual',
        manual_current REAL NOT NULL DEFAULT 0, monthly_contribution REAL NOT NULL DEFAULT 0,
        notes TEXT, created_at INTEGER, updated_at INTEGER
      );
    `)
  }
  function addGoal(
    name: string,
    target: number,
    targetDate: string,
    current: number,
    monthly: number
  ): void {
    sqlite
      .prepare(
        "INSERT INTO financial_goals (name, target_amount, target_date, manual_current, monthly_contribution, source) VALUES (?,?,?,?,?,'manual')"
      )
      .run(name, target, targetDate, current, monthly)
  }

  it('flags a goal whose planned contribution cannot reach the target in time', async () => {
    createGoals()
    // ~6 months left, $24k to go → needs ~$4k/mo; planned $500/mo.
    addGoal('Tax reserve', 25000, '2026-12-15', 1000, 500)
    const { buildInsights } = await import('./insights')
    const hit = buildInsights(db(), NOW).insights.find((i) => i.kind === 'goal-off-track')
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('warn')
    expect(hit?.title).toContain('Tax reserve')
  })

  it('stays quiet for on-track, funded, or past-date goals', async () => {
    createGoals()
    addGoal('On track', 6000, '2026-12-15', 3000, 600) // needs ~$500/mo, planned $600
    addGoal('Funded', 5000, '2026-12-15', 5000, 0) // already there
    addGoal('Past', 5000, '2026-01-01', 0, 0) // date behind us
    const { buildInsights } = await import('./insights')
    expect(buildInsights(db(), NOW).insights.some((i) => i.kind === 'goal-off-track')).toBe(false)
  })
})

describe('renewals due', () => {
  function createTables(): void {
    sqlite.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'other',
        name TEXT NOT NULL, value REAL, provider TEXT, reference TEXT, renewal_date TEXT,
        status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
        status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, payment_account TEXT,
        cancel_url TEXT, notes TEXT, source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER, updated_at INTEGER
      );
    `)
  }

  it('surfaces assets + long-cadence subscriptions renewing in the window', async () => {
    createTables()
    sqlite
      .prepare(
        "INSERT INTO assets (external_id, type, name, renewal_date) VALUES ('a1', 'insurance', 'Car insurance', '2026-07-01')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO subscriptions (external_id, name, cost, cadence, next_renewal) VALUES ('s1', 'Domain', 120, 'yearly', '2026-06-20')"
      )
      .run()
    // Outside window / routine cadence — must NOT appear.
    sqlite
      .prepare(
        "INSERT INTO subscriptions (external_id, name, cost, cadence, next_renewal) VALUES ('s2', 'Netflix', 15, 'monthly', '2026-06-20')"
      )
      .run()
    const { buildInsights } = await import('./insights')
    const hit = buildInsights(db(), NOW).insights.find((i) => i.kind === 'renewal-due')
    expect(hit).toBeTruthy()
    expect(hit?.title).toContain('2 renewals')
    expect(hit?.detail).toContain('Car insurance')
    expect(hit?.detail).toContain('Domain')
    expect(hit?.detail).not.toContain('Netflix')
  })
})

describe('paycheck anomaly', () => {
  function createPaystubs(): void {
    sqlite.exec(`
      CREATE TABLE argyle_paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
        gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
        currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT, paid_at TEXT,
        pay_cycle TEXT, ingested_at INTEGER
      );
    `)
  }
  function addStub(id: string, net: number, paidAt: string): void {
    sqlite
      .prepare(
        "INSERT INTO argyle_paystubs (external_id, employer, net_pay, paid_at) VALUES (?, 'Initech', ?, ?)"
      )
      .run(id, net, paidAt)
  }

  it('flags a latest paycheck far from the trailing median', async () => {
    createPaystubs()
    addStub('p1', 3000, '2026-05-01')
    addStub('p2', 3000, '2026-05-15')
    addStub('p3', 3010, '2026-06-01')
    addStub('p4', 2200, '2026-06-14') // ~$800 under median
    const { buildInsights } = await import('./insights')
    const hit = buildInsights(db(), NOW).insights.find((i) => i.kind === 'paycheck-anomaly')
    expect(hit).toBeTruthy()
    expect(hit?.title).toContain('lower')
  })

  it('stays quiet for a normal paycheck or thin history', async () => {
    createPaystubs()
    addStub('p1', 3000, '2026-05-01')
    addStub('p2', 3010, '2026-05-15')
    addStub('p3', 3005, '2026-06-01')
    const { buildInsights } = await import('./insights')
    expect(buildInsights(db(), NOW).insights.some((i) => i.kind === 'paycheck-anomaly')).toBe(false)
  })
})

describe('utility spike', () => {
  it('flags a latest bill well above the provider average', async () => {
    sqlite.exec(`
      CREATE TABLE utility_bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, provider TEXT,
        service_address TEXT, statement_date TEXT, period_start TEXT, period_end TEXT,
        amount REAL, currency TEXT NOT NULL DEFAULT 'USD', usage_kwh REAL, ingested_at INTEGER
      );
    `)
    const add = (id: string, amount: number, date: string): void => {
      sqlite
        .prepare(
          "INSERT INTO utility_bills (external_id, provider, amount, statement_date) VALUES (?, 'CNFL', ?, ?)"
        )
        .run(id, amount, date)
    }
    add('u1', 80, '2026-03-20')
    add('u2', 85, '2026-04-20')
    add('u3', 82, '2026-05-20')
    add('u4', 160, '2026-06-10') // ~2× the trailing average
    const { buildInsights } = await import('./insights')
    const hit = buildInsights(db(), NOW).insights.find((i) => i.kind === 'utility-spike')
    expect(hit).toBeTruthy()
    expect(hit?.title).toContain('CNFL')
  })
})

// ── Cross-domain detectors (leverage layer) ─────────────────────────────────

describe('unused subscriptions (subs × media-usage records)', () => {
  beforeEach(() => {
    createRecordsTable()
    createSubscriptionsTable()
  })
  it('flags an active streaming sub with zero usage in the window', async () => {
    const { buildInsights } = await import('./insights')
    addSubscription('Netflix', 15.99)
    // Spotify HAS a recent play → not flagged; Netflix has none → flagged.
    addSubscription('Spotify', 11.99)
    addRecord('spotify', 'listen', ymdMs('2026-06-10'))
    const r = buildInsights(db(), NOW)
    const unused = r.insights.filter((i) => i.kind === 'unused-subscription')
    expect(unused).toHaveLength(1)
    expect(unused[0].title).toContain('Netflix')
  })

  it('does not flag a sub with usage inside the window, nor an unrecognized service', async () => {
    const { buildInsights } = await import('./insights')
    addSubscription('Netflix', 15.99)
    addRecord('netflix', 'watch', ymdMs('2026-06-01')) // used recently
    addSubscription('Adobe Creative Cloud', 54.99) // not in STREAMING_USAGE → never guessed
    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'unused-subscription')).toHaveLength(0)
  })

  it('ignores a paused subscription', async () => {
    const { buildInsights } = await import('./insights')
    addSubscription('Netflix', 15.99, { status: 'paused' })
    const r = buildInsights(db(), NOW)
    expect(r.insights.filter((i) => i.kind === 'unused-subscription')).toHaveLength(0)
  })
})

describe('sleep vs spend (apple-health × finance, weekly)', () => {
  beforeEach(() => createRecordsTable())
  // 8 weeks: alternate low-sleep+high-spend vs high-sleep+low-spend.
  function seedWeeks(): void {
    for (let w = 0; w < 8; w++) {
      // Mondays walking back from a fixed anchor before NOW.
      const monday = new Date('2026-06-08T00:00:00')
      monday.setDate(monday.getDate() - w * 7)
      const ymd = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
      const lowSleep = w % 2 === 0
      addRecord('apple-health', 'sleep', ymdMs(ymd), {
        payload: { day: ymd, ms: (lowSleep ? 5 : 8) * 3_600_000 }
      })
      addTxn(ymd, lowSleep ? -180 : -60, 'Dining')
    }
  }

  it('surfaces when low-sleep weeks average materially more discretionary spend', async () => {
    const { buildInsights } = await import('./insights')
    seedWeeks()
    const r = buildInsights(db(), NOW)
    const hit = r.insights.filter((i) => i.kind === 'sleep-vs-spend')
    expect(hit).toHaveLength(1)
    expect(hit[0].detail).toMatch(/discretionary spend/)
  })

  it('stays quiet with too few overlapping weeks', async () => {
    const { buildInsights } = await import('./insights')
    for (let w = 0; w < 3; w++) {
      const ymd = `2026-05-${String(4 + w * 7).padStart(2, '0')}`
      addRecord('apple-health', 'sleep', ymdMs(ymd), { payload: { ms: 5 * 3_600_000 } })
      addTxn(ymd, -180, 'Dining')
    }
    expect(
      buildInsights(db(), NOW).insights.filter((i) => i.kind === 'sleep-vs-spend')
    ).toHaveLength(0)
  })
})

describe('savings rate (paystubs × finance)', () => {
  beforeEach(() => createPaystubsTable())
  it('flags a materially worse latest completed month vs the trailing average', async () => {
    const { buildInsights } = await import('./insights')
    // Need ≥ SAVINGS_MIN_MONTHS(3) prior + 1 latest = 4 completed months (all < June).
    for (const m of ['2026-02', '2026-03', '2026-04', '2026-05']) addPaystub(`${m}-15`, 4000)
    // Feb–Apr save ~70% (expense 1200/4000); May crashes to ~10% (expense 3600).
    addTxn('2026-02-10', -1200, 'Dining')
    addTxn('2026-03-10', -1200, 'Dining')
    addTxn('2026-04-10', -1200, 'Dining')
    addTxn('2026-05-10', -3600, 'Dining')
    const r = buildInsights(db(), NOW)
    const hit = r.insights.filter((i) => i.kind === 'savings-rate')
    expect(hit).toHaveLength(1)
    expect(hit[0].severity).toBe('warn')
  })

  it('stays quiet when the latest month holds its trailing rate', async () => {
    const { buildInsights } = await import('./insights')
    for (const m of ['2026-02', '2026-03', '2026-04', '2026-05']) {
      addPaystub(`${m}-15`, 4000)
      addTxn(`${m}-10`, -1200, 'Dining')
    }
    expect(buildInsights(db(), NOW).insights.filter((i) => i.kind === 'savings-rate')).toHaveLength(
      0
    )
  })
})

describe('medical out-of-pocket (medical records × finance)', () => {
  beforeEach(() => createRecordsTable())
  it('ties an encounter to health-category spend in the following window', async () => {
    const { buildInsights } = await import('./insights')
    addRecord('medical', 'encounter', ymdMs('2026-06-03'), { title: 'Cardiology visit' })
    addTxn('2026-06-05', -140, 'Pharmacy')
    addTxn('2026-06-08', -100, 'Medical')
    // An unrelated dining charge in the window must NOT count.
    addTxn('2026-06-06', -50, 'Dining')
    const r = buildInsights(db(), NOW)
    const hit = r.insights.filter((i) => i.kind === 'medical-out-of-pocket')
    expect(hit).toHaveLength(1)
    expect(hit[0].title).toContain('Cardiology visit')
    expect(hit[0].title).toContain('$240')
  })

  it('stays quiet when health spend falls outside the window or below the floor', async () => {
    const { buildInsights } = await import('./insights')
    addRecord('medical', 'encounter', ymdMs('2026-06-03'), { title: 'Checkup' })
    addTxn('2026-06-25', -140, 'Pharmacy') // 22 days later → outside the 14-day window
    expect(
      buildInsights(db(), NOW).insights.filter((i) => i.kind === 'medical-out-of-pocket')
    ).toHaveLength(0)
  })
})

describe('cross-domain detectors survive a missing table', () => {
  it('does not throw when records/subscriptions/paystubs tables are absent', async () => {
    // The shared beforeEach creates none of them — this is the default state.
    const { buildInsights } = await import('./insights')
    expect(() => buildInsights(db(), NOW)).not.toThrow()
    expect(
      buildInsights(db(), NOW).insights.filter((i) => i.kind === 'unused-subscription')
    ).toEqual([])
  })
})

describe('ordering + IPC registration', () => {
  it('sorts warnings before infos and registers insights:get', async () => {
    const mod = await import('./insights')
    // One info (stale note) + one warn (anomaly).
    addNote('profile/goals.md', 'Goals', new Date('2025-12-01'))
    for (const m of ['2026-03', '2026-04', '2026-05']) addTxn(`${m}-10`, -100, 'Dining')
    addTxn('2026-06-05', -300, 'Dining')

    const r = mod.buildInsights(db(), NOW)
    expect(r.insights.map((i) => i.severity)).toEqual(['warn', 'info'])

    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    mod.registerInsightsHandlers({
      handle: (channel: string, h: (...args: unknown[]) => unknown) => {
        handlers[channel] = h
      }
    } as unknown as IpcMain)
    const viaIpc = (await handlers['insights:get']({})) as { insights: unknown[] }
    expect(viaIpc.insights.length).toBeGreaterThan(0)
  })
})
