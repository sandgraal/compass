/**
 * Tests for the Credit hub aggregator (Phase 10.5 — RIGHTS mode).
 *
 * `summarizeCredit` + `creditRecommendations` are pure; `getCreditSummary`
 * round-trips through an in-memory `records` table (mirrors
 * `finance-holdings.test.ts`).
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  type CreditAccountLike,
  type CreditInquiry,
  type CreditTradeline,
  getCreditSummary,
  reconcileTradelines,
  summarizeCredit
} from './finance-credit'

const NO_LATES = { late30: 0, late60: 0, late90: 0, late120: 0, late150: 0, late180: 0 }
const TODAY = Date.parse('2026-07-03T00:00:00')

function tl(over: Partial<CreditTradeline> = {}): CreditTradeline {
  return {
    creditor: 'CARD',
    accountLast4: '0001',
    accountType: 'Credit Card',
    status: 'Pays As Agreed',
    closed: false,
    balance: 0,
    creditLimit: 1000,
    highCredit: null,
    utilization: 0,
    dateOpened: '01/01/2015',
    monthsReviewed: null,
    paymentHistory: { ...NO_LATES },
    ...over
  }
}

const baseOpts = {
  bureau: 'Equifax',
  reportDate: '2026-07-03',
  score: null,
  scoreTrend: [],
  todayMs: TODAY
}

describe('summarizeCredit', () => {
  it('computes utilization over open revolving accounts with a limit', () => {
    const tls = [
      tl({ creditor: 'A', accountLast4: '1', balance: 300, creditLimit: 1000 }),
      tl({ creditor: 'B', accountLast4: '2', balance: 900, creditLimit: 1000 }),
      // installment — excluded from utilization, counted in the mix
      tl({
        creditor: 'C',
        accountLast4: '3',
        accountType: 'Auto',
        balance: 5000,
        creditLimit: null
      })
    ]
    const s = summarizeCredit(tls, [], baseOpts)
    expect(s.totalRevolvingBalance).toBe(1200)
    expect(s.totalRevolvingLimit).toBe(2000)
    expect(s.overallUtilization).toBe(0.6)
    expect(s.perCard).toHaveLength(2)
    expect(s.perCard[0].creditor).toBe('B') // worst-utilized first
    expect(s.accountTypeMix).toContainEqual({ type: 'Auto', count: 1 })
  })

  it('excludes a card with a balance but no reported limit from utilization', () => {
    const s = summarizeCredit([tl({ balance: 800, creditLimit: null })], [], baseOpts)
    expect(s.totalRevolvingBalance).toBe(0)
    expect(s.overallUtilization).toBeNull()
  })

  it('excludes a card with a limit but no balance (TransUnion) — no fake 0%', () => {
    const s = summarizeCredit([tl({ balance: null, creditLimit: 5000 })], [], baseOpts)
    expect(s.totalRevolvingLimit).toBe(0) // unknown balance → limit not counted either
    expect(s.overallUtilization).toBeNull()
    expect(s.perCard).toHaveLength(1) // still listed…
    expect(s.perCard[0].utilization).toBeNull() // …but utilization is unknown, not 0
  })

  it('rolls up on-time vs late accounts and inquiry windows', () => {
    const tls = [
      tl({ creditor: 'ONTIME' }),
      tl({ creditor: 'LATE', closed: true, paymentHistory: { ...NO_LATES, late30: 2, late90: 1 } })
    ]
    const inq: CreditInquiry[] = [
      { company: 'X', inquiryType: 'Hard', inquiryDate: '01/15/2026' }, // ~6mo
      { company: 'Y', inquiryType: 'Soft', inquiryDate: '08/01/2024' } // ~23mo → 24mo only
    ]
    const s = summarizeCredit(tls, inq, baseOpts)
    expect(s.onTimeCount).toBe(1)
    expect(s.lateCount).toBe(1)
    expect(s.hardInquiries12mo).toBe(1)
    expect(s.softInquiries12mo).toBe(0)
    expect(s.softInquiries24mo).toBe(1)
  })

  it('is empty when there is nothing to summarize', () => {
    const s = summarizeCredit([], [], baseOpts)
    expect(s.hasData).toBe(false)
    expect(s.perCard).toEqual([])
  })
})

describe('creditRecommendations (via summarizeCredit)', () => {
  it('flags a maxed card and high overall utilization', () => {
    const s = summarizeCredit(
      [tl({ creditor: 'MAX', accountLast4: '9', balance: 980, creditLimit: 1000 })],
      [],
      baseOpts
    )
    const ids = s.recommendations.map((r) => r.id)
    expect(ids).toContain('util-card-9')
    expect(ids).toContain('util-overall')
    expect(s.recommendations.find((r) => r.id === 'util-overall')?.severity).toBe('high')
  })

  it('flags a thin file', () => {
    const s = summarizeCredit([tl({})], [], baseOpts)
    expect(s.recommendations.map((r) => r.id)).toContain('thin-file')
  })

  it('returns a single healthy note when nothing is wrong', () => {
    const tls = [
      tl({ accountLast4: '1', balance: 10, creditLimit: 10000 }),
      tl({ accountLast4: '2', balance: 5, creditLimit: 9000 }),
      tl({ accountLast4: '3', balance: 0, creditLimit: 8000 })
    ]
    const s = summarizeCredit(tls, [], baseOpts)
    expect(s.recommendations.map((r) => r.id)).toEqual(['healthy'])
  })
})

// ─── DB round-trip ───────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      occurred_at INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE,
      provenance TEXT,
      ingested_at INTEGER
    );
  `)
  return sqlite
}

let seq = 0
function insert(
  sqlite: Database.Database,
  type: string,
  occurredAt: number,
  payload: Record<string, unknown>
): void {
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run('credit-report', type, occurredAt, 'x', JSON.stringify(payload), `h${seq++}`)
}

describe('getCreditSummary', () => {
  it('reads only the latest snapshot and merges a manual score', () => {
    const sqlite = makeDb()
    // Older snapshot (May)
    insert(sqlite, 'credit-report', Date.parse('2026-05-01'), {
      bureau: 'Equifax',
      score: null,
      reportDate: '2026-05-01'
    })
    insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
      creditor: 'OLD',
      accountLast4: '1',
      accountType: 'Credit Card',
      closed: false,
      balance: 500,
      creditLimit: 1000,
      utilization: 0.5,
      dateOpened: '01/01/2015',
      paymentHistory: NO_LATES,
      reportDate: '2026-05-01'
    })
    // Newer snapshot (July)
    insert(sqlite, 'credit-report', Date.parse('2026-07-01'), {
      bureau: 'Equifax',
      score: null,
      reportDate: '2026-07-01'
    })
    insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
      creditor: 'NEW',
      accountLast4: '1',
      accountType: 'Credit Card',
      closed: false,
      balance: 100,
      creditLimit: 1000,
      utilization: 0.1,
      dateOpened: '01/01/2015',
      paymentHistory: NO_LATES,
      reportDate: '2026-07-01'
    })
    // Manual score entry
    insert(sqlite, 'credit-score', Date.parse('2026-07-02'), {
      bureau: 'Credit Karma',
      score: 720,
      reportDate: '2026-07-02',
      manual: true
    })

    const s = getCreditSummary(sqlite, '2026-07-03')
    expect(s.hasData).toBe(true)
    expect(s.reportDate).toBe('2026-07-01')
    expect(s.perCard).toHaveLength(1)
    expect(s.perCard[0].creditor).toBe('NEW') // latest snapshot only
    expect(s.totalRevolvingBalance).toBe(100)
    expect(s.score).toBe(720)
    expect(s.scoreTrend.map((p) => p.score)).toContain(720)
  })

  it('shows one bureau (not a merge) when several report the same day', () => {
    const sqlite = makeDb()
    const mk = (bureau: string, creditor: string, balance: number | null) =>
      insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
        creditor,
        accountLast4: '1',
        accountType: 'Credit Card',
        closed: false,
        balance,
        creditLimit: 1000,
        dateOpened: '01/01/2015',
        paymentHistory: NO_LATES,
        bureau,
        reportDate: '2026-07-03'
      })
    mk('Equifax', 'EQ-CARD', 200)
    mk('Experian', 'EXP-CARD', 300)
    mk('TransUnion', 'TU-CARD', null) // TransUnion carries no balance
    const s = getCreditSummary(sqlite, '2026-07-03')
    expect(s.tradelineCount).toBe(1) // one bureau, not three merged
    expect([...s.bureausAvailable].sort()).toEqual(['Equifax', 'Experian', 'TransUnion'])
    expect(s.bureau).not.toBe('TransUnion') // no-balance snapshot loses the tie
  })

  it('reads all inquiries regardless of the latest tradeline snapshot', () => {
    const sqlite = makeDb()
    insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
      creditor: 'A',
      accountLast4: '1',
      accountType: 'Credit Card',
      closed: false,
      balance: 0,
      creditLimit: 1000,
      dateOpened: '01/01/2015',
      paymentHistory: NO_LATES,
      reportDate: '2026-07-01'
    })
    insert(sqlite, 'credit-inquiry', Date.parse('2026-01-15'), {
      company: 'VERIZON',
      inquiryType: 'Soft',
      inquiryDate: '01/15/2026',
      reportDate: '2026-05-01'
    })
    const s = getCreditSummary(sqlite, '2026-07-03')
    expect(s.softInquiries12mo).toBe(1)
  })

  it('degrades to empty when the records table is absent', () => {
    const s = getCreditSummary(new Database(':memory:'), '2026-07-03')
    expect(s.hasData).toBe(false)
    expect(s.perCard).toEqual([])
  })

  it('is empty when no credit records exist', () => {
    expect(getCreditSummary(makeDb(), '2026-07-03').hasData).toBe(false)
  })

  it('surfaces open tradelines as untracked when finance_accounts is absent', () => {
    const sqlite = makeDb() // records only — no finance_accounts table
    insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
      creditor: 'A',
      accountLast4: '1',
      accountType: 'Credit Card',
      closed: false,
      balance: 100,
      creditLimit: 1000,
      dateOpened: '01/01/2015',
      paymentHistory: NO_LATES,
      reportDate: '2026-07-01'
    })
    const s = getCreditSummary(sqlite, '2026-07-03')
    expect(s.hasData).toBe(true)
    expect(s.reconciliation.matched).toEqual([])
    // The tradeline still surfaces as untracked — accounts list is just empty.
    expect(s.reconciliation.unmatchedTradelines).toHaveLength(1)
    expect(s.reconciliation.unmatchedAccounts).toEqual([])
  })

  it('reconciles the latest snapshot against live debt accounts', () => {
    const sqlite = makeDb()
    sqlite.exec(`
      CREATE TABLE finance_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        institution TEXT NOT NULL DEFAULT '',
        mask TEXT,
        is_debt INTEGER DEFAULT 0,
        balance REAL DEFAULT 0
      );
    `)
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, mask, is_debt, balance) VALUES ('American Express Card (5647)', '5647', 1, 188.53)"
      )
      .run()
    insert(sqlite, 'credit-tradeline', Date.parse('2015-01-01'), {
      creditor: 'AMERICAN EXPRESS',
      accountLast4: '5647',
      accountType: 'Credit Card',
      closed: false,
      balance: 150,
      creditLimit: 1000,
      dateOpened: '01/01/2015',
      paymentHistory: NO_LATES,
      reportDate: '2026-07-01'
    })
    const s = getCreditSummary(sqlite, '2026-07-03')
    expect(s.reconciliation.matched).toHaveLength(1)
    expect(s.reconciliation.matched[0]).toMatchObject({
      creditor: 'AMERICAN EXPRESS',
      accountName: 'American Express Card (5647)',
      reportBalance: 150,
      liveBalance: 188.53,
      drift: 38.53
    })
    expect(s.reconciliation.unmatchedTradelines).toEqual([])
    expect(s.reconciliation.unmatchedAccounts).toEqual([])
  })
})

// ─── Report ↔ live-account reconciliation (pure) ─────────────────────────────

function acct(over: Partial<CreditAccountLike> = {}): CreditAccountLike {
  return {
    id: 1,
    name: 'Card',
    institution: '',
    mask: null,
    isDebt: true,
    balance: 0,
    ...over
  }
}

describe('reconcileTradelines', () => {
  it('pairs by exact last-4 and computes drift as live minus report', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'AMERICAN EXPRESS', accountLast4: '5647', balance: 150 })],
      [acct({ id: 1, name: 'American Express Card (5647)', mask: '5647', balance: 188.53 })]
    )
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].drift).toBe(38.53)
    expect(r.unmatchedTradelines).toEqual([])
    expect(r.unmatchedAccounts).toEqual([])
  })

  it('falls back to the (1234) suffix in the account name when mask is null', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'USAA SB', accountLast4: '3615', balance: 9800 })],
      [acct({ id: 3, name: 'UNSECURED FIXED RATE LOAN (3615)', balance: 9807.24 })]
    )
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].accountId).toBe(3)
  })

  it('ignores non-4-digit or mid-name parentheticals — no false last-4 pairing', () => {
    const r = reconcileTradelines(
      [
        tl({ creditor: 'ZZZ LENDER', accountLast4: '12', balance: 100 }),
        tl({ creditor: 'CARD CO', accountLast4: '3456', balance: 50 })
      ],
      [
        acct({ id: 1, name: 'Loan (12) restructured', balance: 500 }),
        acct({ id: 2, name: 'Card (3456) legacy note', balance: 200 }) // (3456) not at end
      ]
    )
    expect(r.matched).toEqual([])
    expect(r.unmatchedTradelines).toHaveLength(2)
  })

  it('pairs by name when exactly one unmatched account matches', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'HILTON HONORS SURPASS', accountLast4: null, balance: 300 })],
      [
        acct({ id: 1, name: 'Hilton Honors Surpass® Card (3002)', balance: 301.81 }),
        acct({ id: 2, name: 'Chris Checking (0991)', isDebt: false, balance: 337 })
      ]
    )
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].accountId).toBe(1)
  })

  it('leaves an ambiguous name match unmatched instead of guessing', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'AMERICAN EXPRESS', accountLast4: null, balance: 500 })],
      [
        acct({ id: 1, name: 'American Express Card (5647)', balance: 188 }),
        acct({ id: 2, name: 'American Express Platinum (2001)', balance: 7089 })
      ]
    )
    expect(r.matched).toEqual([])
    expect(r.unmatchedTradelines).toHaveLength(1)
    expect(r.unmatchedAccounts).toHaveLength(2)
  })

  it('excludes closed tradelines from both matched and unmatched lists', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'OLD LOAN', accountLast4: '9999', balance: 0, closed: true })],
      [acct({ id: 1, name: 'Something Else', balance: 50 })]
    )
    expect(r.matched).toEqual([])
    expect(r.unmatchedTradelines).toEqual([])
    expect(r.unmatchedAccounts).toHaveLength(1) // the live debt is still flagged
  })

  it('ignores non-debt accounts entirely', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'CHRIS SAVINGS', accountLast4: '0983', balance: 100 })],
      [acct({ id: 1, name: 'Chris Savings (0983)', isDebt: false, balance: 3058 })]
    )
    expect(r.matched).toEqual([])
    expect(r.unmatchedTradelines).toHaveLength(1)
    expect(r.unmatchedAccounts).toEqual([]) // asset accounts are never flagged
  })

  it('null balances yield a null drift, not NaN', () => {
    const r = reconcileTradelines(
      [tl({ creditor: 'TU CARD', accountLast4: '1111', balance: null })],
      [acct({ id: 1, name: 'TU Card (1111)', mask: '1111', balance: 42 })]
    )
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].drift).toBeNull()
  })
})
