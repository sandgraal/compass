import { describe, expect, it } from 'vitest'
import { parseMoney } from './entities'
import {
  type CalendarRow,
  type FinanceTxnRow,
  type FinancialGoalRow,
  type GithubRow,
  type GmailRow,
  type HabitCheckRow,
  type LabResultRow,
  type LifeRecordProjRow,
  type LinearRow,
  type MedicalRow,
  type OuraRow,
  type PaystubRow,
  type RentalCompRow,
  type SnapshotFactRow,
  type TaskRow,
  type TravelSegmentRow,
  type UtilityBillRow,
  projectCalendar,
  projectFinanceTransactions,
  projectFinancialGoals,
  projectGithub,
  projectGmail,
  projectHabitChecks,
  projectLabResults,
  projectLifeRecords,
  projectLinear,
  projectMedicalRecords,
  projectOuraMetrics,
  projectPaystubs,
  projectRentalComps,
  projectSnapshotFacts,
  projectTasks,
  projectTravelSegments,
  projectUtilityBills
} from './storehouse-projectors'

const txn = (partial: Partial<FinanceTxnRow> & Pick<FinanceTxnRow, 'hash'>): FinanceTxnRow => ({
  date: '2026-06-01',
  amount: -25,
  currency: 'USD',
  description: 'Starbucks',
  category: 'Dining',
  ...partial
})

describe('projectFinanceTransactions', () => {
  it('maps a transaction to the records shape', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1' })])
    expect(r.source).toBe('finance')
    expect(r.type).toBe('txn')
    expect(r.title).toBe('Starbucks')
    expect(r.naturalKey).toBe('h1') // reuses the txn's unique hash → idempotent re-projection
    // occurredAt is the LOCAL day, not UTC midnight (avoids off-by-one on the timeline).
    expect(r.occurredAt).toBe(new Date('2026-06-01T00:00:00').getTime())
    expect(r.payload).toEqual(txn({ hash: 'h1' }))
  })

  it('formats the body so parseMoney (the merchant extractor) reads back the spend', () => {
    // This coupling is load-bearing: the finance-merchant extractor recovers the
    // amount via parseMoney(body). If the body format drifts, Merchants/Subscriptions
    // silently lose spend — so assert the round-trip explicitly.
    const [expense] = projectFinanceTransactions([
      txn({ hash: 'h1', amount: -25, currency: 'USD' })
    ])
    expect(expense.body).toBe('-25.00 USD · Dining')
    expect(parseMoney(expense.body ?? null)).toEqual({ amount: -25, currency: 'USD' })

    const [income] = projectFinanceTransactions([
      txn({ hash: 'h2', amount: 1500, currency: 'USD', category: 'Salary' })
    ])
    expect(income.body).toBe('1500.00 USD · Salary')
    expect(parseMoney(income.body ?? null)).toEqual({ amount: 1500, currency: 'USD' })
  })

  it('defaults a missing currency to USD and a missing category to Uncategorized', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', currency: null, category: null })])
    expect(r.body).toBe('-25.00 USD · Uncategorized')
  })

  it('falls back to a generic title when the description is blank', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', description: '   ' })])
    expect(r.title).toBe('Transaction')
  })

  it('yields a null occurredAt for an unparseable date rather than NaN', () => {
    const [r] = projectFinanceTransactions([txn({ hash: 'h1', date: 'not-a-date' })])
    expect(r.occurredAt).toBeNull()
  })

  it('skips rows without a stable hash (cannot dedupe safely)', () => {
    expect(projectFinanceTransactions([txn({ hash: '' })])).toHaveLength(0)
  })
})

describe('projectGmail', () => {
  const mail = (p: Partial<GmailRow> & Pick<GmailRow, 'threadId'>): GmailRow => ({
    subject: 'Lunch?',
    fromAddress: 'Jane Doe <jane@example.com>',
    snippet: 'are you free',
    receivedAt: 1700000000000,
    ...p
  })

  it('maps an email with the sender in the first body segment', () => {
    const [r] = projectGmail([mail({ threadId: 't1' })])
    expect(r.source).toBe('gmail')
    expect(r.type).toBe('email')
    expect(r.title).toBe('Lunch?')
    expect(r.body).toBe('Jane Doe <jane@example.com> · are you free')
    expect(r.body?.split(' · ')[0]).toBe('Jane Doe <jane@example.com>') // gmail-person reads this
    expect(r.naturalKey).toBe('t1')
    expect(r.occurredAt).toBe(1700000000000)
  })

  it('omits the preview separator when there is no snippet, and defaults a blank subject', () => {
    const [r] = projectGmail([mail({ threadId: 't1', snippet: null, subject: '  ' })])
    expect(r.body).toBe('Jane Doe <jane@example.com>')
    expect(r.title).toBe('(no subject)')
  })

  it('skips rows without a thread id', () => {
    expect(projectGmail([mail({ threadId: '' })])).toHaveLength(0)
  })
})

describe('projectCalendar', () => {
  const ev = (p: Partial<CalendarRow> & Pick<CalendarRow, 'externalId'>): CalendarRow => ({
    title: 'Team offsite',
    location: 'Cartago, CR',
    startAt: 1700000000000,
    ...p
  })

  it('maps an event with the location as the body (feeds the gcal-place extractor)', () => {
    const [r] = projectCalendar([ev({ externalId: 'e1' })])
    expect(r.source).toBe('gcal')
    expect(r.type).toBe('event')
    expect(r.title).toBe('Team offsite')
    expect(r.body).toBe('Cartago, CR')
    expect(r.naturalKey).toBe('e1')
    expect(r.occurredAt).toBe(1700000000000)
  })

  it('leaves the body undefined when there is no location', () => {
    const [r] = projectCalendar([ev({ externalId: 'e1', location: null })])
    expect(r.body).toBeUndefined()
  })

  it('skips rows without an external id', () => {
    expect(projectCalendar([ev({ externalId: '' })])).toHaveLength(0)
  })
})

describe('projectGithub', () => {
  const gh = (p: Partial<GithubRow> & Pick<GithubRow, 'externalId'>): GithubRow => ({
    type: 'issue',
    repo: 'acme/app',
    title: 'Fix the bug',
    state: 'open',
    author: 'jane-doe',
    updatedAt: '2026-06-01T12:00:00Z',
    ...p
  })

  it('maps an issue/PR with the author appended to the body for extraction', () => {
    const [r] = projectGithub([gh({ externalId: 'g1', type: 'pr' })])
    expect(r.source).toBe('github')
    expect(r.type).toBe('pr')
    expect(r.title).toBe('Fix the bug')
    expect(r.body).toBe('acme/app · open · @jane-doe')
    expect(r.naturalKey).toBe('g1')
    expect(r.occurredAt).toBe(Date.parse('2026-06-01T12:00:00Z'))
  })

  it('omits the author segment when there is no author', () => {
    const [r] = projectGithub([gh({ externalId: 'g1', author: null })])
    expect(r.body).toBe('acme/app · open')
  })

  it('skips rows without an external id', () => {
    expect(projectGithub([gh({ externalId: '' })])).toHaveLength(0)
  })

  it('projects a commit as type "commit" (the dev-productivity stream)', () => {
    const [r] = projectGithub([
      gh({
        externalId: 'abc123sha',
        type: 'commit',
        title: 'fix: null guard',
        state: 'committed'
      })
    ])
    expect(r.type).toBe('commit')
    expect(r.title).toBe('fix: null guard')
    expect(r.body).toBe('acme/app · committed · @jane-doe')
    expect(r.naturalKey).toBe('abc123sha')
  })

  it('falls back to issue for an unknown type', () => {
    const [r] = projectGithub([gh({ externalId: 'g9', type: 'discussion' })])
    expect(r.type).toBe('issue')
  })
})

describe('projectLinear', () => {
  const li = (p: Partial<LinearRow> & Pick<LinearRow, 'externalId'>): LinearRow => ({
    identifier: 'ENG-12',
    title: 'Ship the thing',
    state: 'In Progress',
    team: 'ENG',
    updatedAt: '2026-06-01T12:00:00Z',
    ...p
  })

  it('maps an issue as "IDENT Title" with a team · state body', () => {
    const [r] = projectLinear([li({ externalId: 'l1' })])
    expect(r.source).toBe('linear')
    expect(r.type).toBe('issue')
    expect(r.title).toBe('ENG-12 Ship the thing')
    expect(r.body).toBe('ENG · In Progress')
    expect(r.naturalKey).toBe('l1')
    expect(r.occurredAt).toBe(Date.parse('2026-06-01T12:00:00Z'))
  })

  it('drops the team prefix when there is no team', () => {
    const [r] = projectLinear([li({ externalId: 'l1', team: null })])
    expect(r.body).toBe('In Progress')
  })
})

describe('projectOuraMetrics', () => {
  const day = (p: Partial<OuraRow> & Pick<OuraRow, 'date'>): OuraRow => ({
    sleepScore: 82,
    readinessScore: 78,
    activityScore: 91,
    steps: 8412,
    ...p
  })

  it('maps a day to a wellness record with scores in the title and steps in the body', () => {
    const [r] = projectOuraMetrics([day({ date: '2026-06-12' })])
    expect(r.source).toBe('oura')
    expect(r.type).toBe('wellness')
    expect(r.title).toBe('Oura: Sleep 82 · Readiness 78 · Activity 91')
    expect(r.body).toBe('8,412 steps')
    expect(r.naturalKey).toBe('2026-06-12')
    // occurredAt is the LOCAL day at midnight (avoids off-by-one on the timeline).
    expect(r.occurredAt).toBe(new Date('2026-06-12T00:00:00').getTime())
  })

  it('omits missing scores from the title and omits the body when steps is null', () => {
    const [r] = projectOuraMetrics([day({ date: '2026-06-12', readinessScore: null, steps: null })])
    expect(r.title).toBe('Oura: Sleep 82 · Activity 91')
    expect(r.body).toBeUndefined()
  })

  it('falls back to a placeholder title when every score is null', () => {
    const [r] = projectOuraMetrics([
      day({ date: '2026-06-12', sleepScore: null, readinessScore: null, activityScore: null })
    ])
    expect(r.title).toBe('Oura: no scores yet')
  })

  it('skips rows without a date', () => {
    expect(projectOuraMetrics([day({ date: '' })])).toHaveLength(0)
  })

  it('naturalKey is the date, so a re-sync upserts the same timeline row', () => {
    const [a] = projectOuraMetrics([day({ date: '2026-06-12', sleepScore: 50 })])
    const [b] = projectOuraMetrics([day({ date: '2026-06-12', sleepScore: 90 })])
    expect(a.naturalKey).toBe(b.naturalKey)
  })
})

// ── Spine expansion (data-access policy) ─────────────────────────────────────

describe('projectHabitChecks', () => {
  const check = (p: Partial<HabitCheckRow> = {}): HabitCheckRow => ({
    habitId: 3,
    habitName: 'Meditate',
    date: '2026-07-01',
    source: null,
    ...p
  })

  it('maps a completed check with a habitId|date key stable across renames', () => {
    const [r] = projectHabitChecks([check()])
    expect(r.source).toBe('habit')
    expect(r.type).toBe('habit-check')
    expect(r.title).toBe('Meditate')
    expect(r.body).toBe('checked')
    expect(r.naturalKey).toBe('3|2026-07-01')
    expect(r.occurredAt).toBe(new Date('2026-07-01T00:00:00').getTime())
  })

  it('labels auto-filled checks with their source', () => {
    const [r] = projectHabitChecks([check({ source: 'oura' })])
    expect(r.body).toBe('auto-filled · oura')
  })

  it('skips rows without a habit id or date', () => {
    expect(projectHabitChecks([check({ habitId: 0 })])).toHaveLength(0)
    expect(projectHabitChecks([check({ date: '' })])).toHaveLength(0)
  })
})

describe('projectTasks', () => {
  const task = (p: Partial<TaskRow> = {}): TaskRow => ({
    id: 7,
    listType: 'daily',
    listDate: '2026-07-02',
    title: 'Call the bank',
    body: null,
    status: 'done',
    checked: true,
    category: 'personal',
    ...p
  })

  it('maps a task with list/status/category in the body and the row id as key', () => {
    const [r] = projectTasks([task()])
    expect(r.source).toBe('task')
    expect(r.type).toBe('task')
    expect(r.title).toBe('Call the bank')
    expect(r.body).toBe('daily · done · personal')
    expect(r.naturalKey).toBe('7')
    expect(r.occurredAt).toBe(new Date('2026-07-02T00:00:00').getTime())
  })

  it('derives status from checked when the status column is empty, and appends the note', () => {
    const [r] = projectTasks([task({ status: null, checked: false, body: 'ext. 204' })])
    expect(r.body).toBe('daily · unchecked · personal · ext. 204')
  })

  it('skips rows without an id or list date', () => {
    expect(projectTasks([task({ id: 0 })])).toHaveLength(0)
    expect(projectTasks([task({ listDate: '' })])).toHaveLength(0)
  })
})

describe('projectMedicalRecords', () => {
  const med = (p: Partial<MedicalRow> = {}): MedicalRow => ({
    externalId: 'metriport:MedicationRequest:1',
    category: 'medication',
    description: 'Aspirin 81mg',
    code: 'RxNorm:243670',
    status: 'active',
    recordedAt: '2026-03-10',
    ...p
  })

  it('maps a clinical row with the category as the record type (full detail on the spine)', () => {
    const [r] = projectMedicalRecords([med()])
    expect(r.source).toBe('medical')
    expect(r.type).toBe('medication')
    expect(r.title).toBe('Aspirin 81mg')
    expect(r.body).toBe('active · RxNorm:243670')
    expect(r.naturalKey).toBe('metriport:MedicationRequest:1')
    expect(r.occurredAt).toBe(new Date('2026-03-10T00:00:00').getTime())
  })

  it('is undated when there is no recorded date, and falls back to the category title', () => {
    const [r] = projectMedicalRecords([med({ recordedAt: null, description: null })])
    expect(r.occurredAt).toBeNull()
    expect(r.title).toBe('medication')
  })

  it('omits the body when neither status nor code is present', () => {
    const [r] = projectMedicalRecords([med({ status: null, code: null })])
    expect(r.body).toBeUndefined()
  })

  it('skips rows without an external id or category', () => {
    expect(projectMedicalRecords([med({ externalId: '' })])).toHaveLength(0)
    expect(projectMedicalRecords([med({ category: '' })])).toHaveLength(0)
  })
})

describe('projectLabResults', () => {
  const lab = (p: Partial<LabResultRow> = {}): LabResultRow => ({
    id: 1,
    testName: 'Cholesterol',
    panel: 'Coronary Risk Profile',
    value: 305,
    valueText: null,
    unit: 'mg/dL',
    flag: 'high',
    takenAt: '2026-04-17',
    encounterId: 'L00094302617',
    ...p
  })

  it('groups same-panel/encounter/date results into one panel-level record', () => {
    const rows = [
      lab({ id: 1, testName: 'Cholesterol', value: 305, flag: 'high' }),
      lab({ id: 2, testName: 'HDL Cholesterol', value: 38, flag: 'low' }),
      lab({ id: 3, testName: 'Triglycerides', value: 331, unit: 'mg/dL', flag: 'normal' })
    ]
    const [r] = projectLabResults(rows)
    expect(r.source).toBe('lab')
    expect(r.type).toBe('lab')
    expect(r.title).toBe('Coronary Risk Profile · 3 results')
    expect(r.body).toBe('Cholesterol 305 mg/dL (high) · HDL Cholesterol 38 mg/dL (low)')
    expect(r.naturalKey).toBe('L00094302617|Coronary Risk Profile|2026-04-17')
    expect(r.occurredAt).toBe(new Date('2026-04-17T00:00:00').getTime())
  })

  it('separates a different panel, date, or encounter into its own record', () => {
    const rows = [lab(), lab({ id: 2, panel: 'Chem 7 Profile' })]
    expect(projectLabResults(rows)).toHaveLength(2)
  })

  it('summarizes as all-normal when nothing is flagged', () => {
    const [r] = projectLabResults([lab({ flag: 'normal' })])
    expect(r.body).toBe('1 result, all in normal range')
  })

  it('skips rows without a test name or taken date', () => {
    expect(projectLabResults([lab({ testName: '' })])).toHaveLength(0)
    expect(projectLabResults([lab({ takenAt: '' })])).toHaveLength(0)
  })
})

describe('projectTravelSegments', () => {
  const seg = (p: Partial<TravelSegmentRow> = {}): TravelSegmentRow => ({
    id: 4,
    country: 'CR',
    startDate: '2026-02-01',
    endDate: '2026-02-14',
    notes: null,
    ...p
  })

  it('maps a trip with the country display name and date window (coarse — never raw GPS)', () => {
    const [r] = projectTravelSegments([seg()])
    expect(r.source).toBe('travel')
    expect(r.type).toBe('trip')
    expect(r.title).toBe('Trip to Costa Rica')
    expect(r.body).toBe('2026-02-01 → 2026-02-14')
    expect(r.naturalKey).toBe('4')
    expect(r.occurredAt).toBe(new Date('2026-02-01T00:00:00').getTime())
  })

  it('collapses a single-day window and appends notes', () => {
    const [r] = projectTravelSegments([seg({ endDate: '2026-02-01', notes: 'visa run' })])
    expect(r.body).toBe('2026-02-01 · visa run')
  })

  it('falls back to the raw code for an unmappable country', () => {
    const [r] = projectTravelSegments([seg({ country: 'ZZ' })])
    expect(r.title).toContain('Trip to')
  })

  it('skips rows without an id, country, or start date', () => {
    expect(projectTravelSegments([seg({ id: 0 })])).toHaveLength(0)
    expect(projectTravelSegments([seg({ country: '' })])).toHaveLength(0)
    expect(projectTravelSegments([seg({ startDate: '' })])).toHaveLength(0)
  })
})

describe('projectPaystubs', () => {
  const stub = (p: Partial<PaystubRow> = {}): PaystubRow => ({
    externalId: 'ps-1',
    employer: 'Initech',
    grossPay: 4000,
    netPay: 3000,
    currency: 'USD',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-15',
    paidAt: '2026-06-16',
    ...p
  })

  it('maps a paystub with a money-first body parseMoney can read back', () => {
    const [r] = projectPaystubs([stub()])
    expect(r.source).toBe('paystub')
    expect(r.type).toBe('paycheck')
    expect(r.title).toBe('Paycheck — Initech')
    expect(r.body).toBe('3000.00 USD · gross 4000.00 USD · 2026-06-01–2026-06-15')
    expect(parseMoney(r.body ?? null)).toEqual({ amount: 3000, currency: 'USD' })
    expect(r.naturalKey).toBe('ps-1')
    expect(r.occurredAt).toBe(new Date('2026-06-16T00:00:00').getTime())
  })

  it('falls back to gross when net is missing, and to a generic title without an employer', () => {
    const [r] = projectPaystubs([stub({ netPay: null, employer: null })])
    expect(r.title).toBe('Paycheck')
    expect(r.body).toBe('4000.00 USD · 2026-06-01–2026-06-15')
  })

  it('skips rows without an external id', () => {
    expect(projectPaystubs([stub({ externalId: '' })])).toHaveLength(0)
  })
})

describe('projectUtilityBills', () => {
  const bill = (p: Partial<UtilityBillRow> = {}): UtilityBillRow => ({
    externalId: 'ub-1',
    provider: 'CNFL',
    serviceAddress: '123 Calle Real, Cartago',
    statementDate: '2026-06-20',
    amount: 84.5,
    currency: 'USD',
    ...p
  })

  it('maps a statement with amount and service address in the body', () => {
    const [r] = projectUtilityBills([bill()])
    expect(r.source).toBe('utility')
    expect(r.type).toBe('bill')
    expect(r.title).toBe('CNFL bill')
    expect(r.body).toBe('84.50 USD · 123 Calle Real, Cartago')
    expect(r.naturalKey).toBe('ub-1')
  })

  it('handles a missing provider/amount/address gracefully', () => {
    const [r] = projectUtilityBills([bill({ provider: null, amount: null, serviceAddress: null })])
    expect(r.title).toBe('Utility bill')
    expect(r.body).toBeUndefined()
  })

  it('skips rows without an external id', () => {
    expect(projectUtilityBills([bill({ externalId: '' })])).toHaveLength(0)
  })
})

describe('projectFinancialGoals', () => {
  const goal = (p: Partial<FinancialGoalRow> = {}): FinancialGoalRow => ({
    id: 2,
    name: 'Emergency fund',
    category: 'emergency',
    targetAmount: 25000,
    targetDate: '2027-01-01',
    createdAt: 1750000000000,
    ...p
  })

  it('maps a goal dated at creation with target details in the body', () => {
    const [r] = projectFinancialGoals([goal()])
    expect(r.source).toBe('goal')
    expect(r.type).toBe('financial-goal')
    expect(r.title).toBe('Emergency fund')
    expect(r.body).toBe('emergency · target 25000.00 USD · by 2027-01-01')
    expect(r.naturalKey).toBe('2')
    expect(r.occurredAt).toBe(1750000000000)
  })

  it('omits the date segment for an open-ended goal', () => {
    const [r] = projectFinancialGoals([goal({ targetDate: null })])
    expect(r.body).toBe('emergency · target 25000.00 USD')
  })

  it('skips rows without an id or name', () => {
    expect(projectFinancialGoals([goal({ id: 0 })])).toHaveLength(0)
    expect(projectFinancialGoals([goal({ name: '  ' })])).toHaveLength(0)
  })
})

describe('projectRentalComps', () => {
  const comp = (p: Partial<RentalCompRow> = {}): RentalCompRow => ({
    id: 9,
    name: 'Casa Verde',
    zone: 'Cartago',
    bedrooms: 2,
    nightlyUsd: 95,
    savedAt: '2026-05-05',
    createdAt: 1746000000000,
    ...p
  })

  it('maps a comp dated at capture', () => {
    const [r] = projectRentalComps([comp()])
    expect(r.source).toBe('rental-comp')
    expect(r.type).toBe('comp')
    expect(r.title).toBe('Casa Verde')
    expect(r.body).toBe('Cartago · 2bd · $95/nt')
    expect(r.naturalKey).toBe('9')
    expect(r.occurredAt).toBe(new Date('2026-05-05T00:00:00').getTime())
  })

  it('falls back to createdAt when savedAt is missing, and to a generic title', () => {
    const [r] = projectRentalComps([comp({ savedAt: null, name: '' })])
    expect(r.occurredAt).toBe(1746000000000)
    expect(r.title).toBe('Rental comp')
  })

  it('skips rows without an id', () => {
    expect(projectRentalComps([comp({ id: 0 })])).toHaveLength(0)
  })
})

describe('projectSnapshotFacts', () => {
  const fact = (p: Partial<SnapshotFactRow> = {}): SnapshotFactRow => ({
    source: 'facebook',
    category: 'ad-profile',
    label: 'Interest',
    value: 'Woodworking',
    dedupHash: 'fh-1',
    ...p
  })

  it('maps a fact as an UNDATED record (searchable, never on the dated timeline)', () => {
    const [r] = projectSnapshotFacts([fact()])
    expect(r.source).toBe('facebook')
    expect(r.type).toBe('fact')
    expect(r.title).toBe('Interest')
    expect(r.body).toBe('Woodworking')
    expect(r.naturalKey).toBe('fh-1')
    expect(r.occurredAt).toBeNull()
  })

  it('falls back to the category when there is no label', () => {
    const [r] = projectSnapshotFacts([fact({ label: null })])
    expect(r.title).toBe('ad-profile')
  })

  it('skips rows without a dedup hash or value', () => {
    expect(projectSnapshotFacts([fact({ dedupHash: '' })])).toHaveLength(0)
    expect(projectSnapshotFacts([fact({ value: '  ' })])).toHaveLength(0)
  })
})

describe('projectLifeRecords', () => {
  const life = (p: Partial<LifeRecordProjRow> = {}): LifeRecordProjRow => ({
    externalId: 'vault:l1',
    category: 'legal',
    title: 'Will',
    fields: { documentType: 'Will', parties: 'Chris', date: '2024-05-01' },
    notes: 'fireproof box',
    createdAt: 1700000000000,
    ...p
  })

  it('maps a record with source life, type = category, dated by the category date field', () => {
    const [r] = projectLifeRecords([life()])
    expect(r.source).toBe('life')
    expect(r.type).toBe('legal')
    expect(r.title).toBe('Will')
    expect(r.naturalKey).toBe('vault:l1')
    expect(r.body).toContain('Chris')
    // fields.date wins over createdAt so a migrated will sits at its real date.
    expect(new Date(r.occurredAt as number).getFullYear()).toBe(2024)
  })

  it('falls back to createdAt when no field date parses', () => {
    const [r] = projectLifeRecords([life({ fields: { documentType: 'Deed' } })])
    expect(r.occurredAt).toBe(1700000000000)
  })

  it('is structurally secret-free: the payload carries only the plaintext row', () => {
    const [r] = projectLifeRecords([
      life({ category: 'financial', fields: { institution: 'USAA', lastFour: '1003' } })
    ])
    const json = JSON.stringify(r)
    // The projector input CANNOT contain secret keys — they never enter the table.
    expect(json).not.toContain('accountNumber')
    expect(json).not.toContain('routingNumber')
  })

  it('skips rows without an externalId or title', () => {
    expect(projectLifeRecords([life({ externalId: '' })])).toHaveLength(0)
    expect(projectLifeRecords([life({ title: '  ' })])).toHaveLength(0)
  })
})
