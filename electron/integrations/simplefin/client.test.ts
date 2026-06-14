/**
 * Tests for the SimpleFIN HTTP client.
 *
 * `fetch` is injected, so no network. The headline cases:
 *   - the base64 Setup Token → claim-URL → Access URL flow
 *   - `splitAccessUrl` builds an explicit Basic auth header from userinfo and
 *     strips the credentials from the request URL (the undici workaround — the
 *     single most likely runtime bug if it regresses)
 *
 * `electron` + `../../paths` are mocked only to satisfy the import chain
 * (client → vault → crypto-vault → electron); no vault file I/O happens here.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))
vi.mock('../../paths', () => ({ VAULT_DIR: '/tmp/compass-simplefin-client-test' }))

const { claimSetupToken, splitAccessUrl, fetchAccounts } = await import('./client')

const tokenFor = (claimUrl: string): string => Buffer.from(claimUrl, 'utf8').toString('base64')
const ACCESS_URL = 'https://alice:s3cret@bridge.simplefin.org/simplefin'

// Typed mock so `.mock.calls[0]` is `[string | URL, RequestInit?]` rather than
// `[]` (which `vi.fn(async () => …)` would infer).
const mockFetch = (impl: () => Response) =>
  vi.fn((_url: string | URL, _init?: RequestInit) => Promise.resolve(impl()))

describe('claimSetupToken', () => {
  it('decodes the token, POSTs the claim URL, returns the access url', async () => {
    const claimUrl = 'https://bridge.simplefin.org/simplefin/claim/abc'
    const fetchImpl = mockFetch(() => new Response(ACCESS_URL, { status: 200 }))
    const r = await claimSetupToken(tokenFor(claimUrl), fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchImpl.mock.calls[0]
    expect(calledUrl).toBe(claimUrl)
    expect(init?.method).toBe('POST')
    expect(r.accessUrl).toBe(ACCESS_URL)
  })

  it('throws when the token decodes to a non-https URL', async () => {
    const fetchImpl = mockFetch(() => new Response('', { status: 200 }))
    await expect(
      claimSetupToken(
        tokenFor('http://insecure.example/claim'),
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/https claim URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws on a non-2xx claim response (single-use token already spent)', async () => {
    const fetchImpl = mockFetch(() => new Response('', { status: 403 }))
    await expect(
      claimSetupToken(
        tokenFor('https://bridge.simplefin.org/claim/x'),
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/HTTP 403/)
  })

  it('throws when the claimed access url has no embedded credentials', async () => {
    const fetchImpl = mockFetch(
      () => new Response('https://bridge.simplefin.org/simplefin', { status: 200 })
    )
    await expect(
      claimSetupToken(
        tokenFor('https://bridge.simplefin.org/claim/x'),
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/credentials/)
  })
})

describe('splitAccessUrl — the undici Basic-auth workaround', () => {
  it('builds a Basic auth header from userinfo and strips creds from the base url', () => {
    const { baseUrl, authHeader } = splitAccessUrl(ACCESS_URL)
    expect(baseUrl).toBe('https://bridge.simplefin.org/simplefin')
    expect(authHeader).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
  })

  it('does not leak credentials into the base url', () => {
    const { baseUrl } = splitAccessUrl(ACCESS_URL)
    expect(baseUrl).not.toContain('s3cret')
    expect(baseUrl).not.toContain('alice')
  })
})

describe('fetchAccounts', () => {
  const okResponse = () =>
    new Response(JSON.stringify({ errors: [], accounts: [] }), { status: 200 })

  it('GETs /accounts with the date window + Authorization header (not URL creds)', async () => {
    const fetchImpl = mockFetch(okResponse)
    await fetchAccounts(
      ACCESS_URL,
      { startDate: 100, endDate: 200 },
      fetchImpl as unknown as typeof fetch
    )
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(
      'https://bridge.simplefin.org/simplefin/accounts?start-date=100&end-date=200'
    )
    expect(String(url)).not.toContain('s3cret')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
  })

  it('adds pending=1 when requested', async () => {
    const fetchImpl = mockFetch(okResponse)
    await fetchAccounts(
      ACCESS_URL,
      { startDate: 1, endDate: 2, pending: true },
      fetchImpl as unknown as typeof fetch
    )
    expect(String(fetchImpl.mock.calls[0][0])).toContain('pending=1')
  })

  it('normalizes a missing errors/accounts payload to empty arrays', async () => {
    const fetchImpl = mockFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    const r = await fetchAccounts(
      ACCESS_URL,
      { startDate: 1, endDate: 2 },
      fetchImpl as unknown as typeof fetch
    )
    expect(r.errors).toEqual([])
    expect(r.accounts).toEqual([])
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = mockFetch(() => new Response('', { status: 403 }))
    await expect(
      fetchAccounts(ACCESS_URL, { startDate: 1, endDate: 2 }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/HTTP 403/)
  })
})
