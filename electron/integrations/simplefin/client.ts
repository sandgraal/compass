/**
 * SimpleFIN Bridge HTTP client (Phase 4.7).
 *
 * Two operations, both main-process-only:
 *
 *   1. `claimSetupToken(token)` — the user pastes a base64 Setup Token. We
 *      base64-decode it to a one-time claim URL, POST to it, and the response
 *      BODY is the long-lived Access URL (which embeds HTTP Basic creds).
 *
 *   2. `fetchAccounts(accessUrl, {...})` — GET `<accessUrl>/accounts` to pull
 *      balances + transactions for a date window.
 *
 * RUNTIME GOTCHA (the single most likely bug): Node's `undici` fetch strips
 * `user:pass@` userinfo from a request URL and does NOT auto-send Basic auth
 * from it. So we parse the Access URL ourselves, build an explicit
 * `Authorization: Basic …` header, and request the credential-stripped origin.
 * `splitAccessUrl` is exported + tested so this can't silently regress.
 *
 * Renderer code MUST NOT import this module — claiming/reading requires the
 * Access URL, which is a credential.
 */

import { assertValidAccessUrl } from './vault'

export type SimplefinTransaction = {
  id: string
  /** Unix seconds; 0 = pending. */
  posted: number
  /** Decimal string, +deposit / −withdrawal. */
  amount: string
  description: string
}

export type SimplefinAccount = {
  id: string
  name: string
  currency: string
  /** Decimal string. */
  balance: string
  'available-balance'?: string
  'balance-date': number
  org: { name?: string; domain?: string; url?: string }
  transactions: SimplefinTransaction[]
}

export type SimplefinAccountsResponse = {
  errors: string[]
  accounts: SimplefinAccount[]
}

/**
 * Decode a base64 Setup Token to its one-time claim URL and POST it for the
 * long-lived Access URL. Throws on a malformed token, a non-2xx claim response
 * (the token may already be spent — they are single-use), or an Access URL
 * that fails validation. `fetchImpl` is injectable for tests.
 */
export async function claimSetupToken(
  setupToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ accessUrl: string }> {
  const trimmed = setupToken.trim()
  if (trimmed.length === 0) throw new Error('SimpleFIN setup token is empty')

  const claimUrl = Buffer.from(trimmed, 'base64').toString('utf8').trim()
  if (!/^https:\/\//i.test(claimUrl)) {
    throw new Error('SimpleFIN setup token did not decode to an https claim URL')
  }

  const resp = await fetchImpl(claimUrl, {
    method: 'POST',
    headers: { 'Content-Length': '0' }
  })
  if (!resp.ok) {
    throw new Error(
      `SimpleFIN claim failed (HTTP ${resp.status}). Setup tokens are single-use — generate a fresh one if this was already claimed.`
    )
  }
  const accessUrl = (await resp.text()).trim()
  assertValidAccessUrl(accessUrl) // throws if not https / missing embedded creds
  return { accessUrl }
}

/**
 * Split an Access URL into the credential-stripped base URL and a Basic auth
 * header value. Exported + tested to pin the undici-credential-stripping
 * workaround (see top-of-file gotcha).
 */
export function splitAccessUrl(accessUrl: string): { baseUrl: string; authHeader: string } {
  const parsed = assertValidAccessUrl(accessUrl)
  const user = decodeURIComponent(parsed.username)
  const pass = decodeURIComponent(parsed.password)
  const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  // Rebuild without userinfo. `origin` never includes credentials; strip a
  // trailing slash so the `${baseUrl}/accounts` join is clean.
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`
  return { baseUrl, authHeader }
}

/**
 * GET `<accessUrl>/accounts` for a date window. Basic auth is sent via an
 * explicit header, NOT URL userinfo (see gotcha). Returns a normalized
 * response with `errors`/`accounts` always present as arrays.
 */
export async function fetchAccounts(
  accessUrl: string,
  opts: { startDate: number; endDate: number; pending?: boolean },
  fetchImpl: typeof fetch = fetch
): Promise<SimplefinAccountsResponse> {
  const { baseUrl, authHeader } = splitAccessUrl(accessUrl)
  const params = new URLSearchParams({
    'start-date': String(Math.floor(opts.startDate)),
    'end-date': String(Math.floor(opts.endDate))
  })
  if (opts.pending) params.set('pending', '1')

  const resp = await fetchImpl(`${baseUrl}/accounts?${params.toString()}`, {
    headers: { Authorization: authHeader }
  })
  if (!resp.ok) {
    throw new Error(`SimpleFIN /accounts failed (HTTP ${resp.status})`)
  }
  const data = (await resp.json()) as Partial<SimplefinAccountsResponse>
  return {
    errors: Array.isArray(data.errors) ? data.errors : [],
    accounts: Array.isArray(data.accounts) ? data.accounts : []
  }
}
