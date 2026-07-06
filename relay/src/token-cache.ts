/**
 * OAuth2 client-credentials token cache (Phase 10.9) — the relay's first auth extension
 * beyond static header injection. Some aggregators (Arcadia) require a SHORT-LIVED bearer
 * obtained from client_id/secret; the relay exchanges once and caches until just before
 * expiry, then refreshes. It stores only the relay's OWN service tokens — never user data.
 *
 * The expiry/refresh logic is pure (inject `now` + the fetcher) so it is fully unit-
 * testable without a network. The actual token HTTP call lives in the proxy (server.ts).
 */

export type FetchedToken = { accessToken: string; expiresInSec: number }
export type TokenFetcher = () => Promise<FetchedToken>

// Refresh this many ms early so an in-flight request never rides an about-to-expire token.
const SKEW_MS = 60_000

export class TokenCache {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  // In-flight exchanges, keyed by adapter id — so concurrent callers share ONE fetch
  // instead of each hammering the token endpoint.
  private readonly pending = new Map<string, Promise<string>>()

  /**
   * Return a valid bearer for `key`, exchanging (via `fetchToken`) only when there is no
   * cached token or it is within the skew window of expiry. Concurrent callers share a
   * single in-flight exchange (deduped) rather than each starting their own.
   */
  async get(key: string, now: number, fetchToken: TokenFetcher): Promise<string> {
    const cached = this.tokens.get(key)
    if (cached && cached.expiresAt > now + SKEW_MS) return cached.token

    // Dedupe: if an exchange is already running for this key, await it.
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const exchange = (async () => {
      try {
        const { accessToken, expiresInSec } = await fetchToken()
        this.tokens.set(key, {
          token: accessToken,
          expiresAt: now + Math.max(0, expiresInSec) * 1000
        })
        return accessToken
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, exchange)
    return exchange
  }

  /** Drop a cached token (e.g. after the upstream returns 401) so the next call refreshes. */
  invalidate(key: string): void {
    this.tokens.delete(key)
    this.pending.delete(key)
  }
}
