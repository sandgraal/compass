import { describe, expect, it } from 'vitest'
import {
  InMemoryMeteringStore,
  type Quota,
  type UsageState,
  checkQuota,
  emptyState,
  recordCall,
  rollover
} from './metering.js'

const T = Date.UTC(2025, 5, 15, 12, 0, 0) // 2025-06-15 12:00:00 UTC

const quota = (over: Partial<Quota> = {}): Quota => ({
  callsPerDay: 100,
  bytesPerDay: 1_000_000,
  monthlyCostCeiling: 1000,
  burstPerMinute: 60,
  maxAccounts: 10,
  ...over
})

describe('rollover', () => {
  it('resets daily counters on a new UTC day', () => {
    const s: UsageState = { ...emptyState(T), dayKey: '2025-06-14', callsToday: 5, bytesToday: 999 }
    const r = rollover(s, T)
    expect(r.dayKey).toBe('2025-06-15')
    expect(r.callsToday).toBe(0)
    expect(r.bytesToday).toBe(0)
  })

  it('resets monthly cost on a new UTC month, preserving the same-month case', () => {
    const may: UsageState = { ...emptyState(T), monthKey: '2025-05', costThisMonth: 100 }
    expect(rollover(may, T).costThisMonth).toBe(0)
    const june: UsageState = { ...emptyState(T), monthKey: '2025-06', costThisMonth: 100 }
    expect(rollover(june, T).costThisMonth).toBe(100)
  })

  it('prunes anomaly-window calls older than 60s', () => {
    const s: UsageState = { ...emptyState(T), recentCalls: [T - 70_000, T - 30_000, T - 1_000] }
    expect(rollover(s, T).recentCalls).toEqual([T - 30_000, T - 1_000])
  })
})

describe('checkQuota', () => {
  it('allows a call within all limits', () => {
    expect(checkQuota(emptyState(T), quota(), { cost: 1, isConnect: false }, T)).toEqual({
      allowed: true
    })
  })

  it('trips the anomaly breaker with a retry-after', () => {
    const s: UsageState = { ...emptyState(T), recentCalls: [T - 3_000, T - 2_000, T - 1_000] }
    const d = checkQuota(s, quota({ burstPerMinute: 3 }), { cost: 1, isConnect: false }, T)
    expect(d).toMatchObject({ allowed: false, status: 429 })
    if (!d.allowed) expect(d.retryAfterSec).toBe(57) // (60000 - 3000) / 1000
  })

  it('blocks on the daily call cap', () => {
    const s: UsageState = { ...emptyState(T), callsToday: 2 }
    const d = checkQuota(s, quota({ callsPerDay: 2 }), { cost: 1, isConnect: false }, T)
    expect(d).toMatchObject({ allowed: false, status: 429 })
    if (!d.allowed) expect(d.reason).toMatch(/own aggregator key/) // nudges to BYO
  })

  it('blocks on the daily byte cap', () => {
    const s: UsageState = { ...emptyState(T), bytesToday: 100 }
    expect(
      checkQuota(s, quota({ bytesPerDay: 100 }), { cost: 1, isConnect: false }, T).allowed
    ).toBe(false)
  })

  it('blocks when a call would exceed the monthly cost ceiling', () => {
    const s: UsageState = { ...emptyState(T), costThisMonth: 8 }
    expect(
      checkQuota(s, quota({ monthlyCostCeiling: 10 }), { cost: 3, isConnect: false }, T).allowed
    ).toBe(false)
    expect(
      checkQuota(s, quota({ monthlyCostCeiling: 10 }), { cost: 2, isConnect: false }, T).allowed
    ).toBe(true) // exactly at the ceiling is fine
  })

  it('enforces the account cap only on connect calls', () => {
    const s: UsageState = { ...emptyState(T), accounts: 2 }
    const q = quota({ maxAccounts: 2 })
    expect(checkQuota(s, q, { cost: 0, isConnect: true }, T)).toMatchObject({
      allowed: false,
      status: 403
    })
    expect(checkQuota(s, q, { cost: 1, isConnect: false }, T).allowed).toBe(true) // data call unaffected
  })
})

describe('recordCall', () => {
  it('increments call/byte/cost counters and logs the timestamp', () => {
    const r = recordCall(emptyState(T), { cost: 2, bytes: 50, isConnect: false }, T)
    expect(r).toMatchObject({ callsToday: 1, bytesToday: 50, costThisMonth: 2, accounts: 0 })
    expect(r.recentCalls).toEqual([T])
  })

  it('increments the account count only for connect calls', () => {
    expect(recordCall(emptyState(T), { cost: 0, bytes: 0, isConnect: true }, T).accounts).toBe(1)
    expect(recordCall(emptyState(T), { cost: 0, bytes: 0, isConnect: false }, T).accounts).toBe(0)
  })

  it('never records negative bytes', () => {
    expect(recordCall(emptyState(T), { cost: 0, bytes: -5, isConnect: false }, T).bytesToday).toBe(
      0
    )
  })
})

describe('InMemoryMeteringStore', () => {
  it('round-trips state per user', () => {
    const store = new InMemoryMeteringStore()
    expect(store.get('u1')).toBeUndefined()
    const s = emptyState(T)
    store.set('u1', s)
    expect(store.get('u1')).toBe(s)
    expect(store.get('u2')).toBeUndefined()
  })
})
