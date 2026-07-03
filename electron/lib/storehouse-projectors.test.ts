import { describe, expect, it } from 'vitest'
import { parseMoney } from './entities'
import {
  type CalendarRow,
  type FinanceTxnRow,
  type GithubRow,
  type GmailRow,
  type LinearRow,
  projectCalendar,
  projectFinanceTransactions,
  projectGithub,
  projectGmail,
  projectLinear
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
