import { describe, expect, it } from 'vitest'
import {
  type EntityRecordRow,
  type OwnedRefs,
  deriveEntities,
  isBankNoise,
  parseMoney,
  subscriptionKey
} from './entities'

const NO_OWNED: OwnedRefs = { contacts: [], subscriptionExternalIds: [] }
const day = (iso: string) => new Date(iso).getTime()

function rec(
  partial: Partial<EntityRecordRow> & Pick<EntityRecordRow, 'source' | 'type' | 'title'>
): EntityRecordRow {
  return { body: null, occurredAt: null, ...partial }
}

describe('parseMoney', () => {
  it('reads the amount + currency from every money-body shape', () => {
    expect(parseMoney('-25.00 USD · Money Sent')).toEqual({ amount: -25, currency: 'USD' })
    expect(parseMoney('- $25.00 · A → B')).toEqual({ amount: -25, currency: null })
    expect(parseMoney('$42.00')).toEqual({ amount: 42, currency: null })
    expect(parseMoney('42.00 USD')).toEqual({ amount: 42, currency: 'USD' })
    expect(parseMoney(null)).toBeNull()
  })
})

describe('deriveEntities — people', () => {
  it('merges the same person seen through different sources into one entry', () => {
    const rows = [
      rec({
        source: 'linkedin',
        type: 'connection',
        title: 'Connected with Jane Doe',
        occurredAt: day('2025-01-01')
      }),
      rec({
        source: 'facebook',
        type: 'connection',
        title: 'Became friends with Jane Doe',
        occurredAt: day('2026-01-01')
      })
    ]
    const people = deriveEntities(rows, NO_OWNED).filter((e) => e.kind === 'person')
    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('Jane Doe')
    expect(people[0].count).toBe(2)
    expect(people[0].sources).toEqual(['facebook', 'linkedin'])
    expect(people[0].firstSeen).toBe(day('2025-01-01'))
    expect(people[0].lastSeen).toBe(day('2026-01-01'))
    expect(people[0].promotedId).toBeNull()
  })

  it('links a derived person to an existing contact by normalized name', () => {
    const rows = [
      rec({ source: 'imessage', type: 'messages', title: '12 messages with Bob Smith' })
    ]
    const owned: OwnedRefs = {
      contacts: [{ id: 7, displayName: 'bob  smith' }],
      subscriptionExternalIds: []
    }
    const [p] = deriveEntities(rows, owned).filter((e) => e.kind === 'person')
    expect(p.name).toBe('Bob Smith')
    expect(p.promotedId).toBe(7)
    expect(p.promotedKind).toBe('contact')
  })

  it('splits Venmo counterparties out of the body and classifies people vs merchants', () => {
    const rows = [
      rec({
        source: 'venmo',
        type: 'payment',
        title: 'Dinner',
        body: '- $25.00 · Jane Doe → Starbucks LLC'
      })
    ]
    const out = deriveEntities(rows, NO_OWNED)
    expect(out.find((e) => e.kind === 'person')?.name).toBe('Jane Doe')
    expect(out.find((e) => e.kind === 'merchant')?.name).toBe('Starbucks LLC')
  })
})

describe('deriveEntities — merchants & subscriptions', () => {
  it('rolls up merchant spend and detects a recurring subscription candidate', () => {
    const rows = [
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD · Subscription',
        occurredAt: day('2026-01-15')
      }),
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD · Subscription',
        occurredAt: day('2026-02-15')
      }),
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD · Subscription',
        occurredAt: day('2026-03-15')
      })
    ]
    const out = deriveEntities(rows, NO_OWNED)
    const merchant = out.find((e) => e.kind === 'merchant')
    expect(merchant?.name).toBe('Netflix')
    expect(merchant?.key).toBe('netflix')
    expect(merchant?.attrs.totalSpend).toBeCloseTo(47.97, 2)

    const sub = out.find((e) => e.kind === 'subscription-candidate')
    expect(sub?.name).toBe('Netflix')
    expect(sub?.attrs.cadence).toBe('monthly')
    expect(sub?.attrs.medianAmount).toBeCloseTo(15.99, 2)
    expect(sub?.attrs.annualCost).toBeCloseTo(191.88, 2)
    expect(sub?.promotedKind).toBeNull()
  })

  it('flags a subscription candidate as tracked by MERCHANT, even under a different account', () => {
    const rows = [
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD',
        occurredAt: day('2026-01-15')
      }),
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD',
        occurredAt: day('2026-02-15')
      }),
      rec({
        source: 'paypal',
        type: 'payment',
        title: 'Netflix',
        body: '-15.99 USD',
        occurredAt: day('2026-03-15')
      })
    ]
    // Finance audit already tracked Netflix under a BANK-ACCOUNT name (not 'paypal').
    const owned: OwnedRefs = {
      contacts: [],
      subscriptionExternalIds: [subscriptionKey('netflix', 'Chase Sapphire')]
    }
    const sub = deriveEntities(rows, owned).find((e) => e.kind === 'subscription-candidate')
    expect(sub?.promotedKind).toBe('subscription')
  })

  it('does not flag a non-recurring merchant as a subscription', () => {
    const rows = [
      rec({
        source: 'amazon',
        type: 'order',
        title: 'Widget',
        body: '$9.99',
        occurredAt: day('2026-01-01')
      }),
      rec({
        source: 'amazon',
        type: 'order',
        title: 'Gadget',
        body: '$4.99',
        occurredAt: day('2026-01-02')
      })
    ]
    const out = deriveEntities(rows, NO_OWNED)
    expect(out.find((e) => e.kind === 'merchant')?.name).toBe('Amazon')
    expect(out.some((e) => e.kind === 'subscription-candidate')).toBe(false)
  })
})

describe('deriveEntities — live finance transactions', () => {
  // Bodies here match projectFinanceTransactions' output ("<amt> <CUR> · <category>").
  const fin = (title: string, body: string, iso: string): EntityRecordRow =>
    rec({ source: 'finance', type: 'txn', title, body, occurredAt: day(iso) })

  it('derives a merchant with spend from a synced transaction', () => {
    const [m] = deriveEntities([fin('Starbucks', '-6.50 USD · Dining', '2026-06-01')], NO_OWNED)
    expect(m.kind).toBe('merchant')
    expect(m.name).toBe('Starbucks')
    expect(m.attrs.totalSpend).toBe(6.5)
    expect(m.attrs.currency).toBe('USD')
  })

  it('promotes a recurring monthly charge to a subscription candidate', () => {
    const rows = [
      fin('Netflix', '-15.99 USD · Entertainment', '2026-01-15'),
      fin('Netflix', '-15.99 USD · Entertainment', '2026-02-15'),
      fin('Netflix', '-15.99 USD · Entertainment', '2026-03-15')
    ]
    const sub = deriveEntities(rows, NO_OWNED).find((e) => e.kind === 'subscription-candidate')
    expect(sub?.name).toBe('Netflix')
    expect(sub?.attrs.cadence).toBe('monthly')
  })

  it('ignores the generic-title fallback so blank descriptions do not pollute Merchants', () => {
    const out = deriveEntities(
      [fin('Transaction', '-1.00 USD · Uncategorized', '2026-06-01')],
      NO_OWNED
    )
    expect(out.some((e) => e.kind === 'merchant')).toBe(false)
  })

  it('does not derive merchants from internal bank plumbing', () => {
    // Real SimpleFIN memos that are transfers/payments/interest — searchable as
    // records, but never a merchant or a bogus subscription.
    const rows = [
      fin('USAA FUNDS TRANSFER DB', '-800.00 USD · Transfer', '2026-01-01'),
      fin('AMEX EPAYMENT    ACH PMT    ***4592', '-500.00 USD · Payment', '2026-02-01'),
      fin('ONLINE PAYMENT - THANK YOU', '-1000.00 USD · Payment', '2026-03-01'),
      fin('INTEREST PAID', '0.39 USD · Interest', '2026-03-02')
    ]
    expect(deriveEntities(rows, NO_OWNED).some((e) => e.kind === 'merchant')).toBe(false)
  })
})

describe('deriveEntities — Gmail senders & calendar places', () => {
  const email = (from: string, subject = 'hi'): EntityRecordRow =>
    rec({ source: 'gmail', type: 'email', title: subject, body: `${from} · preview text` })

  it('derives a person from a multi-word email sender', () => {
    const [p] = deriveEntities([email('Jane Doe <jane@example.com>')], NO_OWNED)
    expect(p.kind).toBe('person')
    expect(p.name).toBe('Jane Doe')
  })

  it('does NOT derive people from brand / automated senders', () => {
    const rows = [
      email('GitHub <noreply@github.com>'), // single-word display + no-reply
      email('notifications@github.com'), // role alias, no display name
      email('Google Alerts <googlealerts-noreply@google.com>'), // multi-word but automated
      email('Snowflake via LinkedIn <newsletters-noreply@linkedin.com>') // "via" forward
    ]
    expect(deriveEntities(rows, NO_OWNED).some((e) => e.kind === 'person')).toBe(false)
  })

  it('derives a place from a calendar event location', () => {
    const [place] = deriveEntities(
      [rec({ source: 'gcal', type: 'event', title: 'Offsite', body: 'Cartago, CR' })],
      NO_OWNED
    )
    expect(place.kind).toBe('place')
    expect(place.name).toBe('Cartago, CR')
  })
})

describe('isBankNoise', () => {
  it('flags transfers, card/ACH payments, interest and reference codes', () => {
    for (const noise of [
      'USAA FUNDS TRANSFER CR',
      'AMEX EPAYMENT    ACH PMT    ***4592',
      'ONLINE PAYMENT - THANK YOU',
      'USAA CREDIT CARD PAYMENT',
      'INTEREST PAID',
      'INTEREST',
      'PRINCIPAL',
      'ICPAYMENT',
      'AMZ_STORECRD_PMT PAYMENT    ***0615',
      '020001643                CARTAGO' // leading ATM/branch reference code
    ]) {
      expect(isBankNoise(noise), noise).toBe(true)
    }
  })

  it('does NOT flag real merchants or utility payees', () => {
    for (const real of [
      'Uber Trip help.uber.com CA',
      'AMAZON MARKETPLACE',
      'WALGREENS WEST PALM BEACH FL',
      'FPL DIRECT DEBIT ELEC PYMT', // Florida Power & Light — a real utility
      'MICROSOFT*XBOX GAME PA REDMOND WA',
      'SUPERMERCADO LA LEYENDA CARTAGO'
    ]) {
      expect(isBankNoise(real), real).toBe(false)
    }
  })
})
