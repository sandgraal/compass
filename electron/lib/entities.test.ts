import { describe, expect, it } from 'vitest'
import {
  type EntityRecordRow,
  type OwnedRefs,
  deriveEntities,
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

  it('flags a subscription candidate as tracked when its detected key is already owned', () => {
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
    const owned: OwnedRefs = {
      contacts: [],
      subscriptionExternalIds: [subscriptionKey('netflix', 'paypal')]
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
