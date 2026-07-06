import { describe, expect, it, vi } from 'vitest'
import { TokenCache } from './token-cache.js'

describe('TokenCache', () => {
  it('exchanges once and reuses the cached bearer until near expiry', async () => {
    const cache = new TokenCache()
    const fetcher = vi.fn().mockResolvedValue({ accessToken: 'tok-1', expiresInSec: 3600 })
    const t0 = 1_000_000
    expect(await cache.get('arcadia', t0, fetcher)).toBe('tok-1')
    // 30 min later — still valid, no new exchange
    expect(await cache.get('arcadia', t0 + 1_800_000, fetcher)).toBe('tok-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refreshes within the 60s skew window before expiry', async () => {
    const cache = new TokenCache()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSec: 100 })
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSec: 100 })
    const t0 = 1_000_000
    expect(await cache.get('k', t0, fetcher)).toBe('tok-1') // expiresAt = t0 + 100s
    // at t0 + 50s the remaining 50s is under the 60s skew → refresh early
    expect(await cache.get('k', t0 + 50_000, fetcher)).toBe('tok-2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate() forces the next call to re-exchange', async () => {
    const cache = new TokenCache()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSec: 3600 })
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSec: 3600 })
    const t0 = 1_000_000
    expect(await cache.get('k', t0, fetcher)).toBe('tok-1')
    cache.invalidate('k')
    expect(await cache.get('k', t0 + 1000, fetcher)).toBe('tok-2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps keys independent — one aggregator does not evict another', async () => {
    const cache = new TokenCache()
    const a = vi.fn().mockResolvedValue({ accessToken: 'A', expiresInSec: 3600 })
    const b = vi.fn().mockResolvedValue({ accessToken: 'B', expiresInSec: 3600 })
    const t0 = 1_000_000
    expect(await cache.get('a', t0, a)).toBe('A')
    expect(await cache.get('b', t0, b)).toBe('B')
    expect(await cache.get('a', t0 + 1000, a)).toBe('A') // still cached
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent exchanges — two simultaneous callers share one fetch', async () => {
    const cache = new TokenCache()
    let calls = 0
    let resolveFetch: (v: { accessToken: string; expiresInSec: number }) => void = () => {}
    const fetcher = (): Promise<{ accessToken: string; expiresInSec: number }> => {
      calls++
      return new Promise((r) => {
        resolveFetch = r
      })
    }
    const p1 = cache.get('k', 1000, fetcher)
    const p2 = cache.get('k', 1000, fetcher) // arrives while p1's exchange is in flight
    resolveFetch({ accessToken: 'tok', expiresInSec: 3600 })
    expect(await p1).toBe('tok')
    expect(await p2).toBe('tok')
    expect(calls).toBe(1) // only one exchange despite two concurrent gets
  })

  it('clears the in-flight entry when an exchange fails, so a retry re-exchanges', async () => {
    const cache = new TokenCache()
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSec: 3600 })
    await expect(cache.get('k', 1000, fetcher)).rejects.toThrow('boom')
    expect(await cache.get('k', 1000, fetcher)).toBe('tok-2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
