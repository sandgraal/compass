import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTA, InMemoryMeteringStore, emptyState } from './metering.js'
import { type RelayConfig, type RelayRequest, handleRelayRequest } from './server.js'

const NOW = Date.UTC(2025, 5, 15, 12)

function mockFetch(status = 200, body = '{"data":[]}') {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

function cfg(over: Partial<RelayConfig> = {}): RelayConfig {
  return {
    env: { TERRA_DEV_ID: 'dev', TERRA_API_KEY: 'secret' },
    store: new InMemoryMeteringStore(),
    quota: DEFAULT_QUOTA,
    clientTokens: new Set<string>(), // dev mode: any non-empty token accepted
    now: () => NOW,
    fetchImpl: mockFetch().fn,
    ...over
  }
}

function req(over: Partial<RelayRequest> = {}): RelayRequest {
  return {
    method: 'GET',
    path: '/terra/daily',
    query: '?user_id=u&start_date=2025-06-01',
    headers: { authorization: 'Bearer tok-1' },
    body: null,
    ...over
  }
}

describe('handleRelayRequest — gatekeeping', () => {
  it('answers the health check without auth', async () => {
    const r = await handleRelayRequest(req({ method: 'GET', path: '/healthz', headers: {} }), cfg())
    expect(r.status).toBe(200)
  })

  it('401s without a bearer token', async () => {
    expect((await handleRelayRequest(req({ headers: {} }), cfg())).status).toBe(401)
  })

  it('403s an unknown client token when an allowlist is configured', async () => {
    const r = await handleRelayRequest(req(), cfg({ clientTokens: new Set(['only-this']) }))
    expect(r.status).toBe(403)
  })

  it('404s an unknown aggregator and 403s a disallowed endpoint', async () => {
    expect((await handleRelayRequest(req({ path: '/nope/daily' }), cfg())).status).toBe(404)
    expect((await handleRelayRequest(req({ path: '/terra/admin' }), cfg())).status).toBe(403)
  })
})

describe('handleRelayRequest — proxy + metering', () => {
  it('injects secret credentials, forwards to the right URL, passes the body through, and records usage', async () => {
    const mock = mockFetch(200, '{"data":[{"day":"2025-06-14"}]}')
    const store = new InMemoryMeteringStore()
    const r = await handleRelayRequest(req(), cfg({ fetchImpl: mock.fn, store }))

    expect(r.status).toBe(200)
    expect(r.body).toBe('{"data":[{"day":"2025-06-14"}]}') // upstream body passed straight through

    // forwarded to Terra with the query preserved + secret headers injected
    expect(mock.calls[0].url).toBe(
      'https://api.tryterra.co/v2/daily?user_id=u&start_date=2025-06-01'
    )
    const headers = mock.calls[0].init.headers as Record<string, string>
    expect(headers['dev-id']).toBe('dev')
    expect(headers['x-api-key']).toBe('secret')

    // usage recorded (counters only — UsageState has no payload field by construction)
    const used = store.get('tok-1')
    expect(used?.callsToday).toBe(1)
    expect(used?.bytesToday).toBeGreaterThan(0)
  })

  it('429s (and does NOT proxy) when the daily quota is already spent', async () => {
    const mock = mockFetch()
    const store = new InMemoryMeteringStore()
    store.set('tok-1', { ...emptyState(NOW), callsToday: DEFAULT_QUOTA.callsPerDay })
    const r = await handleRelayRequest(req(), cfg({ fetchImpl: mock.fn, store }))
    expect(r.status).toBe(429)
    expect(mock.calls).toHaveLength(0) // never hit the upstream
  })

  it('counts a widget-session POST as a connected account', async () => {
    const mock = mockFetch(200, '{"url":"https://widget.tryterra.co/session/abc"}')
    const store = new InMemoryMeteringStore()
    const r = await handleRelayRequest(
      req({
        method: 'POST',
        path: '/terra/auth/generateWidgetSession',
        query: '',
        body: '{"reference_id":"u","providers":"OURA"}'
      }),
      cfg({ fetchImpl: mock.fn, store })
    )
    expect(r.status).toBe(200)
    expect(mock.calls[0].init.body).toBe('{"reference_id":"u","providers":"OURA"}') // body forwarded
    expect(store.get('tok-1')?.accounts).toBe(1)
  })
})
