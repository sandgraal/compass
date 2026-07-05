/**
 * Metering & quota engine (Phase 10.9 — the metered aggregator relay).
 *
 * The "we pay for it, but don't get abused" core. Pure + deterministic (the `now`
 * instant is always injected) so every abuse vector is unit-testable without a
 * clock, a socket, or a store. The relay proxies paid-aggregator calls; this module
 * decides — per user — whether a call is allowed and records its cost.
 *
 * It stores COUNTERS ONLY, never user payloads: calls/day, bytes/day, accrued
 * cost/month, connected-account count, and a rolling-minute call log for the anomaly
 * breaker. Counters roll over on UTC day / month boundaries.
 */

export type Quota = {
  callsPerDay: number // hard cap on proxied calls per user per UTC day
  bytesPerDay: number // hard cap on upstream response bytes per user per UTC day
  monthlyCostCeiling: number // hard cap on accrued cost units per user per UTC month
  burstPerMinute: number // anomaly breaker: max calls within a rolling 60s window
  maxAccounts: number // max connected aggregator accounts per user
}

/** Conservative defaults. Prod overrides via env (see README). */
export const DEFAULT_QUOTA: Quota = {
  callsPerDay: 500,
  bytesPerDay: 50 * 1024 * 1024, // 50 MB/day
  monthlyCostCeiling: 1000, // cost units/month (adapter defines cost per call)
  burstPerMinute: 60,
  maxAccounts: 10
}

export type UsageState = {
  dayKey: string // 'YYYY-MM-DD' UTC — daily counters reset when this changes
  monthKey: string // 'YYYY-MM' UTC — monthly cost resets when this changes
  callsToday: number
  bytesToday: number
  costThisMonth: number
  accounts: number
  recentCalls: number[] // epoch-ms of calls within the last 60s (anomaly window)
}

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; status: 429 | 403; reason: string; retryAfterSec?: number }

const MINUTE_MS = 60_000

export function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}
export function monthKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7) // YYYY-MM (UTC)
}

export function emptyState(now: number): UsageState {
  return {
    dayKey: dayKeyOf(now),
    monthKey: monthKeyOf(now),
    callsToday: 0,
    bytesToday: 0,
    costThisMonth: 0,
    accounts: 0,
    recentCalls: []
  }
}

/**
 * Reset daily/monthly counters when their UTC window has turned over, and prune the
 * anomaly log to the last 60s. Idempotent — safe to call before every check/record.
 */
export function rollover(state: UsageState, now: number): UsageState {
  const dayKey = dayKeyOf(now)
  const monthKey = monthKeyOf(now)
  const next: UsageState = {
    ...state,
    recentCalls: state.recentCalls.filter((t) => now - t < MINUTE_MS)
  }
  if (next.dayKey !== dayKey) {
    next.dayKey = dayKey
    next.callsToday = 0
    next.bytesToday = 0
  }
  if (next.monthKey !== monthKey) {
    next.monthKey = monthKey
    next.costThisMonth = 0
  }
  return next
}

export type CallShape = { cost: number; isConnect: boolean }

/**
 * Decide whether a proxied call is allowed. Expects an ALREADY-rolled-over state
 * (call `rollover` first). Order: anomaly breaker → daily calls → daily bytes →
 * monthly cost → (connect only) account cap. A 429 means "slow down / quota hit";
 * the reason nudges the user toward the BYO-key escape hatch when a hard cap is met.
 */
export function checkQuota(
  state: UsageState,
  quota: Quota,
  call: CallShape,
  now: number
): QuotaDecision {
  const inWindow = state.recentCalls.filter((t) => now - t < MINUTE_MS).length
  if (inWindow >= quota.burstPerMinute) {
    const oldest = Math.min(...state.recentCalls)
    return {
      allowed: false,
      status: 429,
      reason: 'Rate limit: too many requests in the last minute.',
      retryAfterSec: Math.max(1, Math.ceil((MINUTE_MS - (now - oldest)) / 1000))
    }
  }
  if (state.callsToday >= quota.callsPerDay) {
    return {
      allowed: false,
      status: 429,
      reason: 'Daily request quota reached. Connect your own aggregator key to continue.'
    }
  }
  if (state.bytesToday >= quota.bytesPerDay) {
    return {
      allowed: false,
      status: 429,
      reason: 'Daily data quota reached. Connect your own aggregator key to continue.'
    }
  }
  if (state.costThisMonth + call.cost > quota.monthlyCostCeiling) {
    return {
      allowed: false,
      status: 429,
      reason: 'Monthly cost ceiling reached. Connect your own aggregator key to continue.'
    }
  }
  if (call.isConnect && state.accounts >= quota.maxAccounts) {
    return {
      allowed: false,
      status: 403,
      reason: `Account limit reached (${quota.maxAccounts}).`
    }
  }
  return { allowed: true }
}

/** Record a completed call's cost/bytes. Expects an already-rolled-over state. */
export function recordCall(
  state: UsageState,
  call: CallShape & { bytes: number },
  now: number
): UsageState {
  return {
    ...state,
    callsToday: state.callsToday + 1,
    bytesToday: state.bytesToday + Math.max(0, call.bytes),
    costThisMonth: state.costThisMonth + call.cost,
    accounts: call.isConnect ? state.accounts + 1 : state.accounts,
    recentCalls: [...state.recentCalls, now]
  }
}

// ── Pluggable store ───────────────────────────────────────────────────────────
// In-memory is fine for a single relay instance. For multi-instance / serverless,
// implement this interface over a shared KV (Upstash Redis, Cloudflare KV) — see README.

export interface MeteringStore {
  get(userId: string): UsageState | undefined
  set(userId: string, state: UsageState): void
}

export class InMemoryMeteringStore implements MeteringStore {
  private readonly m = new Map<string, UsageState>()
  get(userId: string): UsageState | undefined {
    return this.m.get(userId)
  }
  set(userId: string, state: UsageState): void {
    this.m.set(userId, state)
  }
}
