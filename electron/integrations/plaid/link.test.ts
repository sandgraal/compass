/**
 * Tests for the Plaid Link helpers (link-token create, public-token
 * exchange, HTML generation). The `plaid` SDK is mocked at the client
 * layer — we don't want any HTTP traffic and we want full control
 * over what `accountsGet` / `institutionsGetById` return so we can
 * exercise the "metadata fetch fails but token still saved" path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setAccessTokenMock = vi.fn()
const linkTokenCreateMock = vi.fn()
const itemPublicTokenExchangeMock = vi.fn()
const accountsGetMock = vi.fn()
const institutionsGetByIdMock = vi.fn()

vi.mock('./vault', () => ({
  setAccessToken: setAccessTokenMock
}))

vi.mock('./client', () => ({
  getPlaidClient: () => ({
    api: {
      linkTokenCreate: linkTokenCreateMock,
      itemPublicTokenExchange: itemPublicTokenExchangeMock,
      accountsGet: accountsGetMock,
      institutionsGetById: institutionsGetByIdMock
    },
    env: 'sandbox' as const,
    clientId: 'cid'
  })
}))

const {
  _resetLinkUserId,
  buildLinkHtml,
  createLinkToken,
  exchangePublicToken,
  getOrCreateLinkUserId
} = await import('./link')

beforeEach(() => {
  setAccessTokenMock.mockReset()
  linkTokenCreateMock.mockReset()
  itemPublicTokenExchangeMock.mockReset()
  accountsGetMock.mockReset()
  institutionsGetByIdMock.mockReset()
  _resetLinkUserId()
})

afterEach(() => {
  _resetLinkUserId()
})

describe('getOrCreateLinkUserId', () => {
  it('returns a stable UUID across calls within a process', () => {
    const a = getOrCreateLinkUserId()
    const b = getOrCreateLinkUserId()
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('generates a fresh UUID after _resetLinkUserId', () => {
    const a = getOrCreateLinkUserId()
    _resetLinkUserId()
    const b = getOrCreateLinkUserId()
    expect(a).not.toBe(b)
  })
})

describe('createLinkToken', () => {
  it('calls linkTokenCreate with pinned products + country + language and returns the token', async () => {
    linkTokenCreateMock.mockResolvedValueOnce({
      data: { link_token: 'link-sandbox-abc', expiration: '2026-01-01T00:00:00Z' }
    })

    const result = await createLinkToken()
    expect(result).toEqual({ linkToken: 'link-sandbox-abc', expiration: '2026-01-01T00:00:00Z' })

    expect(linkTokenCreateMock).toHaveBeenCalledTimes(1)
    const args = linkTokenCreateMock.mock.calls[0][0]
    expect(args.client_name).toBe('Compass')
    expect(args.products).toEqual(['transactions'])
    expect(args.country_codes).toEqual(['US'])
    expect(args.language).toBe('en')
    expect(args.user.client_user_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reuses the same client_user_id across calls in a single process', async () => {
    linkTokenCreateMock.mockResolvedValue({
      data: { link_token: 't', expiration: 'e' }
    })

    await createLinkToken()
    await createLinkToken()
    const first = linkTokenCreateMock.mock.calls[0][0].user.client_user_id
    const second = linkTokenCreateMock.mock.calls[1][0].user.client_user_id
    expect(first).toBe(second)
  })

  it('propagates Plaid SDK errors', async () => {
    linkTokenCreateMock.mockRejectedValueOnce(new Error('plaid 4xx'))
    await expect(createLinkToken()).rejects.toThrow(/plaid 4xx/)
  })
})

describe('exchangePublicToken', () => {
  it('rejects empty / non-string public tokens (programmer error)', async () => {
    await expect(exchangePublicToken('')).rejects.toThrow(/publicToken/i)
    // @ts-expect-error: intentional bad input
    await expect(exchangePublicToken(null)).rejects.toThrow(/publicToken/i)
  })

  it('stores the access token in the vault and returns metadata on the happy path', async () => {
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'access-sandbox-xyz', item_id: 'item-1' }
    })
    accountsGetMock.mockResolvedValueOnce({
      data: {
        item: { institution_id: 'ins_3' },
        accounts: [
          { account_id: 'a1', name: 'Checking', mask: '1234', subtype: 'checking' },
          { account_id: 'a2', name: 'Savings', mask: '5678', subtype: 'savings' }
        ]
      }
    })
    institutionsGetByIdMock.mockResolvedValueOnce({
      data: { institution: { name: 'Test Bank' } }
    })

    const result = await exchangePublicToken('public-sandbox-pub')

    expect(setAccessTokenMock).toHaveBeenCalledWith('item-1', 'access-sandbox-xyz')
    expect(result.itemId).toBe('item-1')
    expect(result.institutionId).toBe('ins_3')
    expect(result.institutionName).toBe('Test Bank')
    expect(result.accounts).toEqual([
      { id: 'a1', name: 'Checking', mask: '1234', subtype: 'checking' },
      { id: 'a2', name: 'Savings', mask: '5678', subtype: 'savings' }
    ])
  })

  it('NEVER returns the access token in the result (it stays vault-only)', async () => {
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'leak-me-if-you-can', item_id: 'item-2' }
    })
    accountsGetMock.mockResolvedValueOnce({
      data: { item: { institution_id: null }, accounts: [] }
    })

    const result = await exchangePublicToken('public-sandbox-x')
    const stringified = JSON.stringify(result)
    expect(stringified).not.toContain('leak-me-if-you-can')
  })

  it('persists the token before fetching accounts (so a metadata-fetch crash never strands an Item)', async () => {
    const callOrder: string[] = []
    setAccessTokenMock.mockImplementation(() => callOrder.push('setAccessToken'))
    accountsGetMock.mockImplementation(() => {
      callOrder.push('accountsGet')
      return Promise.resolve({ data: { item: {}, accounts: [] } })
    })
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'a', item_id: 'i' }
    })

    await exchangePublicToken('p')
    expect(callOrder).toEqual(['setAccessToken', 'accountsGet'])
  })

  it('survives accountsGet failure — token is still saved, metadata is null', async () => {
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'access-y', item_id: 'item-3' }
    })
    accountsGetMock.mockRejectedValueOnce(new Error('plaid 500'))

    const result = await exchangePublicToken('public-x')
    expect(setAccessTokenMock).toHaveBeenCalledWith('item-3', 'access-y')
    expect(result).toEqual({
      itemId: 'item-3',
      institutionId: null,
      institutionName: null,
      accounts: []
    })
  })

  it('survives institutionsGetById failure — accounts return but name is null', async () => {
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'a', item_id: 'item-4' }
    })
    accountsGetMock.mockResolvedValueOnce({
      data: {
        item: { institution_id: 'ins_x' },
        accounts: [{ account_id: 'a1', name: 'X', mask: null, subtype: null }]
      }
    })
    institutionsGetByIdMock.mockRejectedValueOnce(new Error('not found'))

    const result = await exchangePublicToken('p')
    expect(result.institutionId).toBe('ins_x')
    expect(result.institutionName).toBeNull()
    expect(result.accounts).toHaveLength(1)
  })

  it('handles accounts with no mask / subtype', async () => {
    itemPublicTokenExchangeMock.mockResolvedValueOnce({
      data: { access_token: 'a', item_id: 'item-5' }
    })
    accountsGetMock.mockResolvedValueOnce({
      data: {
        item: { institution_id: null },
        accounts: [{ account_id: 'a1', name: 'Bare', mask: undefined, subtype: undefined }]
      }
    })

    const result = await exchangePublicToken('p')
    expect(result.accounts).toEqual([{ id: 'a1', name: 'Bare', mask: null, subtype: null }])
  })
})

describe('buildLinkHtml', () => {
  it('embeds the link token inside a double-quoted JS string', () => {
    const html = buildLinkHtml('link-sandbox-abc123')
    expect(html).toContain('token: "link-sandbox-abc123"')
  })

  it('embeds CSP via <meta http-equiv> inside the document head', () => {
    // The Link window is loaded from a `data:` URL, so
    // session.webRequest.onHeadersReceived never fires for the
    // document load. The meta-tag form is the ONLY thing that
    // actually constrains script-src / connect-src etc. for the
    // page. If this regresses, the per-window CSP becomes a no-op.
    const html = buildLinkHtml('t')
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]+">/)
    // Confirm the policy actually whitelists Plaid + denies object-src.
    const match = html.match(/content="([^"]+)"/)
    expect(match).not.toBeNull()
    const policy = match![1]
    expect(policy).toContain('https://cdn.plaid.com')
    expect(policy).toContain('https://*.plaid.com')
    expect(policy).toContain("object-src 'none'")
    // Defense in depth — must not silently widen to wildcard.
    expect(policy).not.toMatch(/default-src \*/)
    expect(policy).not.toMatch(/script-src \*/)
  })

  it('places the CSP meta tag BEFORE the first <script> so it is in effect when scripts run', () => {
    const html = buildLinkHtml('t')
    const cspIdx = html.indexOf('Content-Security-Policy')
    const scriptIdx = html.indexOf('<script')
    expect(cspIdx).toBeGreaterThan(-1)
    expect(scriptIdx).toBeGreaterThan(-1)
    expect(cspIdx).toBeLessThan(scriptIdx)
  })

  it('loads the official Plaid Link script', () => {
    const html = buildLinkHtml('t')
    expect(html).toContain('https://cdn.plaid.com/link/v2/stable/link-initialize.js')
  })

  it('uses the compass-plaid:// callback scheme for success and exit', () => {
    const html = buildLinkHtml('t')
    expect(html).toContain('compass-plaid://success?public_token=')
    expect(html).toContain('compass-plaid://exit?error_code=')
  })

  it('escapes a double quote inside the token so it cannot break out of the string literal', () => {
    const html = buildLinkHtml('evil"injected')
    expect(html).toContain('token: "evil\\"injected"')
  })

  it('escapes a backslash inside the token', () => {
    const html = buildLinkHtml('back\\slash')
    expect(html).toContain('token: "back\\\\slash"')
  })

  it('escapes < to prevent </script> injection', () => {
    const html = buildLinkHtml('a</script>b')
    // Only `<` is escaped; `>` is harmless on its own and stays.
    expect(html).toContain('token: "a\\u003c/script>b"')
    expect(html).not.toContain('a</script>b"')
  })

  it('escapes U+2028 (LINE SEPARATOR) which would silently terminate the JS line', () => {
    const LS = String.fromCharCode(0x2028)
    const html = buildLinkHtml(`a${LS}b`)
    expect(html).toContain('token: "a\\u2028b"')
    expect(html).not.toContain(`token: "a${LS}b"`)
  })

  it('escapes U+2029 (PARAGRAPH SEPARATOR)', () => {
    const PS = String.fromCharCode(0x2029)
    const html = buildLinkHtml(`a${PS}b`)
    expect(html).toContain('token: "a\\u2029b"')
    expect(html).not.toContain(`token: "a${PS}b"`)
  })

  it('escapes newlines + carriage returns', () => {
    const html = buildLinkHtml('a\nb\rc')
    expect(html).toContain('token: "a\\nb\\rc"')
  })
})
