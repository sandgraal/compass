import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_RETIREMENT_CONFIG,
  DEFAULT_RETIRE_ENGINE_CONFIG,
  type RetirementConfig,
  buildRetirementPlan,
  buildRetirementProjection,
  defaultStartingAssets,
  getRetireEngineConfig,
  getRetirementConfig,
  hasSsaStatement,
  projectRetirement,
  setRetireEngineConfig,
  setRetirementConfig,
  ssAnnualBenefit
} from './finance-retirement'

describe('ssAnnualBenefit', () => {
  const FRA = 67
  const PIA = 2000 // monthly
  it('pays 100% of PIA at FRA', () => {
    expect(ssAnnualBenefit(PIA, 67, FRA)).toBe(2000 * 12)
  })
  it('reduces to ~70% of PIA when claiming at 62 (FRA 67)', () => {
    expect(ssAnnualBenefit(PIA, 62, FRA)).toBeCloseTo(2000 * 0.7 * 12, 2) // 16,800
  })
  it('boosts to ~124% of PIA when claiming at 70 (FRA 67)', () => {
    expect(ssAnnualBenefit(PIA, 70, FRA)).toBeCloseTo(2000 * 1.24 * 12, 0) // 29,760
  })
  it('returns 0 for a zero PIA and clamps the claim age to 62–70', () => {
    expect(ssAnnualBenefit(0, 65, FRA)).toBe(0)
    expect(ssAnnualBenefit(PIA, 50, FRA)).toBe(ssAnnualBenefit(PIA, 62, FRA))
    expect(ssAnnualBenefit(PIA, 99, FRA)).toBe(ssAnnualBenefit(PIA, 70, FRA))
  })
})

const CFG: RetirementConfig = {
  ...DEFAULT_RETIREMENT_CONFIG,
  currentAge: 60,
  retirementAge: 65,
  horizonAge: 90,
  annualContribution: 10_000,
  realReturnPct: 5,
  annualSpending: 50_000,
  ssMonthlyAtFra: 2000,
  ssClaimAge: 67,
  fra: 67,
  airbnbAnnualNet: 6_000,
  otherAnnualIncome: 0,
  stressReturnPct: -10,
  stressYears: 3
}

describe('projectRetirement', () => {
  it('accumulates (contributions + growth) until the retirement age', () => {
    const p = projectRetirement(CFG, 500_000, 2026)
    const first = p.rows[0]
    expect(first.phase).toBe('accumulation')
    expect(first.age).toBe(60)
    // 500k + 10k contribution, grown at 5%: (500000+10000)*1.05 = 535,500.
    expect(first.endBalance).toBe(535_500)
    expect(p.rows.find((r) => r.age === 65)?.phase).toBe('decumulation')
    expect(p.retirementYear).toBe(2031)
  })

  it('draws down spending net of SS + Airbnb in retirement', () => {
    const p = projectRetirement(CFG, 500_000, 2026)
    const at66 = p.rows.find((r) => r.age === 66)
    // Before SS claim (67): income = airbnb 6k only → withdrawal = 50k - 6k = 44k.
    expect(at66?.ssIncome).toBe(0)
    expect(at66?.withdrawal).toBe(44_000)
    const at68 = p.rows.find((r) => r.age === 68)
    // SS claimed at 67 → 24k/yr; withdrawal = 50k - 24k - 6k = 20k.
    expect(at68?.ssIncome).toBe(24_000)
    expect(at68?.withdrawal).toBe(20_000)
  })

  it('flags the depletion age when the portfolio runs out', () => {
    const broke = { ...CFG, ssMonthlyAtFra: 0, airbnbAnnualNet: 0, annualSpending: 80_000 }
    const p = projectRetirement(broke, 100_000, 2026)
    expect(p.depletionAge).not.toBeNull()
    expect(p.endBalance).toBe(0)
    // Every row at/after depletion stays at 0.
    const after = p.rows.find((r) => r.age === (p.depletionAge as number) + 1)
    expect(after?.endBalance).toBe(0)
  })

  it('a sequence-of-returns stress ends worse than the baseline', () => {
    const base = projectRetirement(CFG, 500_000, 2026, { stress: false })
    const stress = projectRetirement(CFG, 500_000, 2026, { stress: true })
    expect(stress.endBalance).toBeLessThan(base.endBalance)
  })

  it('lasts to the horizon when income covers spending (no withdrawals)', () => {
    const flush = { ...CFG, annualSpending: 5_000, ssMonthlyAtFra: 3000, airbnbAnnualNet: 20_000 }
    const p = projectRetirement(flush, 400_000, 2026)
    expect(p.depletionAge).toBeNull()
    expect(p.endBalance).toBeGreaterThan(400_000) // grew, never drawn down
  })
})

// ─── DB layer ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, base TEXT NOT NULL,
      quote TEXT NOT NULL, rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      asset_class TEXT NOT NULL DEFAULT 'spending'
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL, balance REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, dedup_hash TEXT NOT NULL UNIQUE
    );
  `)
  return sqlite
}

function addAccount(
  sqlite: Database.Database,
  name: string,
  assetClass: string,
  balance: number
): void {
  const info = sqlite
    .prepare('INSERT INTO finance_accounts (name, asset_class) VALUES (?, ?)')
    .run(name, assetClass)
  sqlite
    .prepare(
      'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (?, ?, ?)'
    )
    .run(Number(info.lastInsertRowid), Date.now(), balance)
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('buildRetirementPlan (rich engine, deep integration)', () => {
  it('seeds the engine from the net-worth snapshot and runs a deterministic Monte Carlo', () => {
    addAccount(sqlite, '401k', 'retirement', 400_000)
    addAccount(sqlite, 'Brokerage', 'savings', 200_000)
    addAccount(sqlite, 'Checking', 'spending', 9_000) // excluded from investable buckets
    addAccount(sqlite, 'CR Property', 'real_estate', 300_000) // excluded
    setRetirementConfig(sqlite, {
      currentAge: 55,
      retirementAge: 56,
      horizonAge: 90,
      annualSpending: 40_000,
      ssMonthlyAtFra: 2000,
      ssClaimAge: 67
    })
    const a = buildRetirementPlan(sqlite)
    const b = buildRetirementPlan(sqlite)

    // Deep integration: starting assets = retirement + savings (others excluded).
    expect(a.startingAssets).toBe(600_000)
    // Engine inputs seeded from the snapshot buckets + legacy config.
    expect(a.inputs.k401CurrentBalance).toBe(400_000)
    expect(a.inputs.currentSavings).toBe(200_000)
    expect(a.inputs.annualExpenses).toBe(40_000)
    expect(a.inputs.retirementAge).toBe(56)
    // Rich outputs present + deterministic (pinned seed).
    expect(a.plan.projection.length).toBeGreaterThan(0)
    expect(Number.isFinite(a.plan.startBalance)).toBe(true)
    expect(Number.parseFloat(a.monteCarlo.successRate)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(a.monteCarlo.successRate)).toBeLessThanOrEqual(100)
    expect(a.monteCarlo.successRate).toBe(b.monteCarlo.successRate)
    expect(a.baseCurrency).toBe('USD')
  })

  it('respects a startingAssets override (treated as liquid taxable)', () => {
    addAccount(sqlite, '401k', 'retirement', 400_000)
    setRetirementConfig(sqlite, { startingAssets: 1_000_000 })
    const r = buildRetirementPlan(sqlite)
    expect(r.startingAssets).toBe(1_000_000)
    expect(r.inputs.currentSavings).toBe(1_000_000)
    expect(r.inputs.k401CurrentBalance).toBe(0)
  })

  it('flows legacy airbnbAnnualNet into the projection as rental income', () => {
    addAccount(sqlite, '401k', 'retirement', 800_000)
    setRetirementConfig(sqlite, {
      currentAge: 56,
      retirementAge: 56,
      horizonAge: 90,
      annualSpending: 48_000,
      airbnbAnnualNet: 24_000
    })
    const r = buildRetirementPlan(sqlite)
    expect(r.inputs.includeRental).toBe(true)
    expect(r.inputs.rentalNetMonthly).toBe(2000) // 24k / 12
    expect(r.plan.projection[0].rentalIncome).toBe(24_000)
  })
})

describe('retire engine config (rich fields)', () => {
  it('round-trips engine config (numbers, boolean, filingStatus)', () => {
    expect(getRetireEngineConfig(sqlite).postRetireReturn).toBe(
      DEFAULT_RETIRE_ENGINE_CONFIG.postRetireReturn
    )
    setRetireEngineConfig(sqlite, {
      postRetireReturn: 0.045,
      ltcEnabled: true,
      filingStatus: 'mfj',
      cajaMonthly: 300
    })
    const c = getRetireEngineConfig(sqlite)
    expect(c.postRetireReturn).toBe(0.045)
    expect(c.ltcEnabled).toBe(true)
    expect(c.filingStatus).toBe('mfj')
    expect(c.cajaMonthly).toBe(300)
    // Untouched fields keep their defaults.
    expect(c.meanReturn).toBe(DEFAULT_RETIRE_ENGINE_CONFIG.meanReturn)
  })

  it('engine-config overrides flow into buildRetirementPlan (LTC lowers success)', () => {
    addAccount(sqlite, '401k', 'retirement', 800_000)
    setRetirementConfig(sqlite, {
      currentAge: 56,
      retirementAge: 56,
      horizonAge: 90,
      annualSpending: 40_000
    })
    const base = buildRetirementPlan(sqlite)
    setRetireEngineConfig(sqlite, {
      ltcEnabled: true,
      ltcMonthly: 4000,
      ltcStartAge: 82,
      ltcYears: 5
    })
    const withLtc = buildRetirementPlan(sqlite)
    expect(withLtc.engineConfig.ltcEnabled).toBe(true)
    expect(withLtc.inputs.ltcEnabled).toBe(true)
    // A late-life LTC shock never raises the success rate (seeded MC → comparable).
    expect(Number.parseFloat(withLtc.monteCarlo.successRate)).toBeLessThanOrEqual(
      Number.parseFloat(base.monteCarlo.successRate)
    )
  })
})

describe('retirement config + sourcing', () => {
  it('defaults config then round-trips a saved patch', () => {
    expect(getRetirementConfig(sqlite).realReturnPct).toBe(DEFAULT_RETIREMENT_CONFIG.realReturnPct)
    setRetirementConfig(sqlite, {
      realReturnPct: 4.5,
      ssMonthlyAtFra: 2500,
      startingAssets: 750_000
    })
    const cfg = getRetirementConfig(sqlite)
    expect(cfg.realReturnPct).toBe(4.5)
    expect(cfg.ssMonthlyAtFra).toBe(2500)
    expect(cfg.startingAssets).toBe(750_000)
    // Clearing the override returns to auto (null).
    setRetirementConfig(sqlite, { startingAssets: null })
    expect(getRetirementConfig(sqlite).startingAssets).toBeNull()
  })

  it('sums retirement + savings net-worth assets for the default starting balance', () => {
    addAccount(sqlite, '401k', 'retirement', 400_000)
    addAccount(sqlite, 'Emergency', 'savings', 50_000)
    addAccount(sqlite, 'Checking', 'spending', 9_000) // excluded
    addAccount(sqlite, 'CR Property', 'real_estate', 300_000) // excluded
    expect(defaultStartingAssets(sqlite)).toBe(450_000)
  })

  it('detects an ingested SSA statement', () => {
    expect(hasSsaStatement(sqlite)).toBe(false)
    sqlite
      .prepare(
        "INSERT INTO records (source, type, title, dedup_hash) VALUES ('social-security', 'social-security', 'SSA 2025', 'h1')"
      )
      .run()
    expect(hasSsaStatement(sqlite)).toBe(true)
  })
})

describe('buildRetirementProjection', () => {
  it('resolves the starting balance from net worth and runs baseline + stress', () => {
    addAccount(sqlite, '401k', 'retirement', 600_000)
    setRetirementConfig(sqlite, {
      currentAge: 64,
      retirementAge: 65,
      horizonAge: 85,
      ssMonthlyAtFra: 2000,
      stressReturnPct: -15,
      stressYears: 4
    })
    const res = buildRetirementProjection(sqlite, 2026)
    expect(res.startingAssets).toBe(600_000) // from net worth (no config override)
    expect(res.baseCurrency).toBe('USD')
    expect(res.baseline.rows[0].age).toBe(64)
    expect(res.stress.endBalance).toBeLessThanOrEqual(res.baseline.endBalance)
  })

  it('honors a config startingAssets override', () => {
    addAccount(sqlite, '401k', 'retirement', 600_000)
    setRetirementConfig(sqlite, { startingAssets: 1_000_000 })
    expect(buildRetirementProjection(sqlite, 2026).startingAssets).toBe(1_000_000)
  })
})
