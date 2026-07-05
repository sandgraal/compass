/**
 * Aggregator adapter interface (Phase 10.9).
 *
 * Each paid aggregator (Terra first; SnapTrade/Canopy/Argyle/Nylas later) is a small
 * adapter describing: where its API lives, which endpoints the relay will forward
 * (DENY-by-default allowlist), the secret auth headers to inject server-side, the
 * cost a call accrues, and whether a call connects a new account. Adding an
 * aggregator = one adapter + one registry entry — no changes to the metering or
 * proxy core.
 */

export type RelayEnv = Record<string, string | undefined>

export type AggregatorAdapter = {
  id: string
  /** Upstream API base, e.g. 'https://api.tryterra.co/v2'. */
  upstreamBase: string
  /** True only for permitted (method, path) pairs. Everything else is refused. */
  allows(method: string, path: string): boolean
  /** Secret auth headers injected from env — the paid dev credentials, never shipped to clients. */
  authHeaders(env: RelayEnv): Record<string, string>
  /** Cost units charged for a call (accrues toward the monthly ceiling). */
  costOf(method: string, path: string): number
  /** True if the call connects a NEW account (widget session) → account-cap + isConnect metering. */
  isConnect(method: string, path: string): boolean
}
