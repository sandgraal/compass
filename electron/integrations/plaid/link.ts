/**
 * Plaid Link helpers (Phase 4.6 — PR 3).
 *
 * Three responsibilities, all server-side (main process only):
 *
 *  1. `createLinkToken()` — calls Plaid `/link/token/create` and
 *     returns the short-lived token the Link JS needs to bootstrap.
 *  2. `exchangePublicToken(publicToken)` — the public token comes back
 *     from a successful Link flow; we trade it for the long-lived
 *     `access_token` + `item_id` via `/item/public_token/exchange`
 *     and persist them in the encrypted vault.
 *  3. `buildLinkHtml(linkToken)` — generates the tiny self-contained
 *     HTML page that runs Plaid's `link-initialize.js` inside our
 *     child BrowserWindow. The page calls back into the main process
 *     by navigating to `compass-plaid://callback?...` URLs, which the
 *     window owner intercepts.
 *
 * Why a child window instead of an iframe: Plaid Link explicitly does
 * not support being framed; their JS detects iframing and refuses to
 * render. A child `BrowserWindow` with `nodeIntegration: false` and a
 * CSP that whitelists `cdn.plaid.com` is the standard Electron host
 * pattern they recommend, and it keeps the renderer process out of
 * the credential path entirely.
 */

import { randomUUID } from 'node:crypto'
import { CountryCode, Products } from 'plaid'
import { getPlaidClient } from './client'
import { setAccessToken } from './vault'

/**
 * Pinned product list. Compass needs transactions; we don't ask for
 * auth/identity/etc. so the consent screen stays as narrow as
 * possible. Add to this list deliberately and document why — every
 * product widens the consent prompt and the data the user is
 * authorizing Plaid to share.
 */
const PRODUCTS: Products[] = [Products.Transactions]

/**
 * Pinned to the US/territories for now. Plaid's coverage matrix
 * differs by country; widening this should be paired with testing
 * against an institution in the new country to avoid surprise
 * `INVALID_FIELD` errors at runtime.
 */
const COUNTRY_CODES: CountryCode[] = [CountryCode.Us]

const LANGUAGE = 'en'

/**
 * Stable opaque user identifier sent to Plaid as `client_user_id`.
 * Plaid uses this to dedupe Items per end-user; for a single-tenant
 * local app a random UUID per first run is fine and keeps PII off
 * of Plaid's side. Cached in-memory only; if Compass fully restarts
 * between Link sessions Plaid is unaffected (a new id just means a
 * new logical "user" on their side, which is harmless).
 */
let cachedUserId: string | null = null
export function getOrCreateLinkUserId(): string {
  if (cachedUserId === null) cachedUserId = randomUUID()
  return cachedUserId
}

/** Visible for tests so a fresh UUID can be forced. */
export function _resetLinkUserId(): void {
  cachedUserId = null
}

/**
 * Calls Plaid `/link/token/create` and returns the `link_token`.
 * The `link_token` is short-lived (≈ 30 min) and SAFE to pass through
 * IPC to the renderer / Link window — it is not a credential.
 */
export async function createLinkToken(): Promise<{ linkToken: string; expiration: string }> {
  const { api } = getPlaidClient()
  const res = await api.linkTokenCreate({
    user: { client_user_id: getOrCreateLinkUserId() },
    client_name: 'Compass',
    products: PRODUCTS,
    country_codes: COUNTRY_CODES,
    language: LANGUAGE
  })
  return {
    linkToken: res.data.link_token,
    expiration: res.data.expiration
  }
}

export type ExchangeResult = {
  itemId: string
  institutionId: string | null
  institutionName: string | null
  accounts: { id: string; name: string; mask: string | null; subtype: string | null }[]
}

/**
 * Trade the `public_token` (one-time, from a successful Link flow) for
 * the long-lived `access_token` + `item_id`. The access token NEVER
 * leaves this function as a return value — it is written straight to
 * the encrypted vault. The caller gets back enough metadata to create
 * `plaid_items` + `financeAccounts` rows in the next PR.
 */
export async function exchangePublicToken(publicToken: string): Promise<ExchangeResult> {
  if (typeof publicToken !== 'string' || publicToken.length === 0) {
    throw new Error('exchangePublicToken: publicToken must be a non-empty string')
  }

  const { api } = getPlaidClient()
  const exchange = await api.itemPublicTokenExchange({ public_token: publicToken })
  const accessToken = exchange.data.access_token
  const itemId = exchange.data.item_id

  // Persist FIRST so a crash mid-flow can't leave Plaid with an Item
  // we can never reach again. itemRemove still works after the fact
  // if the user disconnects, but only if we held onto the token.
  setAccessToken(itemId, accessToken)

  // Fetch accounts + institution metadata so the next PR can create
  // financeAccounts rows without a second user-visible round-trip.
  // Any failure here is non-fatal — the token is already saved,
  // and a subsequent sync can backfill the metadata.
  let institutionId: string | null = null
  let institutionName: string | null = null
  let accounts: ExchangeResult['accounts'] = []
  try {
    const accountsRes = await api.accountsGet({ access_token: accessToken })
    accounts = accountsRes.data.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask ?? null,
      subtype: a.subtype ?? null
    }))
    institutionId = accountsRes.data.item.institution_id ?? null
    if (institutionId) {
      try {
        const inst = await api.institutionsGetById({
          institution_id: institutionId,
          country_codes: COUNTRY_CODES
        })
        institutionName = inst.data.institution.name
      } catch {
        // institutionsGetById can fail for some sandbox fixtures;
        // treat the name as unknown and let the caller fall back to id.
      }
    }
  } catch {
    // Accounts metadata fetch failed; the token is still safely
    // stored. Caller can re-fetch later.
  }

  return { itemId, institutionId, institutionName, accounts }
}

/**
 * Builds the self-contained HTML the child BrowserWindow loads. The
 * page does three things:
 *  - loads `cdn.plaid.com/link/v2/stable/link-initialize.js`
 *  - calls `Plaid.create({...})` with the link token + handlers
 *  - bubbles results back to the main process by navigating to
 *    `compass-plaid://success?public_token=...` or
 *    `compass-plaid://exit?error_code=...`
 *
 * The window owner intercepts `compass-plaid://` via `will-navigate`
 * and `will-redirect`, reads the params, then destroys the window.
 * That keeps the Link window free of preload scripts and context
 * bridges — Plaid Link runs in a sealed environment.
 *
 * CSP is embedded as `<meta http-equiv="Content-Security-Policy">`
 * inside the document. This is the only reliable place to set it for
 * the page: the document is loaded from a `data:` URL, which never
 * generates an HTTP response, so a session-level `onHeadersReceived`
 * handler does NOT fire for the document load and a header-based CSP
 * is never enforced on the navigation. The meta tag is read by the
 * HTML parser and enforced from the moment the body starts executing
 * scripts — strictly tighter than the main window's CSP.
 *
 * `linkToken` is interpolated into a "..." string literal; we escape
 * defensively even though Plaid tokens are URL-safe by construction.
 * Cheap defense against a future token-format change.
 */
export const LINK_CSP =
  "default-src 'self' data: https://cdn.plaid.com https://*.plaid.com; " +
  "script-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com; " +
  "style-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com; " +
  "img-src 'self' data: blob: https://cdn.plaid.com https://*.plaid.com; " +
  "font-src 'self' data: https://cdn.plaid.com https://*.plaid.com; " +
  "connect-src 'self' https://*.plaid.com; " +
  'frame-src https://*.plaid.com; ' +
  "object-src 'none'"

export function buildLinkHtml(linkToken: string): string {
  const safeToken = escapeForJsString(linkToken)
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${LINK_CSP}">
    <title>Connect a bank</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      #status { padding: 16px; color: #444; }
    </style>
  </head>
  <body>
    <div id="status">Loading Plaid Link…</div>
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <script>
      (function () {
        var handler = Plaid.create({
          token: "${safeToken}",
          onSuccess: function (public_token, metadata) {
            var url = 'compass-plaid://success?public_token=' + encodeURIComponent(public_token) +
              '&institution_id=' + encodeURIComponent((metadata && metadata.institution && metadata.institution.institution_id) || '') +
              '&institution_name=' + encodeURIComponent((metadata && metadata.institution && metadata.institution.name) || '');
            window.location.href = url;
          },
          onExit: function (err, metadata) {
            var url = 'compass-plaid://exit?error_code=' + encodeURIComponent((err && err.error_code) || '') +
              '&error_message=' + encodeURIComponent((err && err.error_message) || '');
            window.location.href = url;
          },
          onEvent: function () { /* no-op; could telemeter steps later */ }
        });
        handler.open();
      })();
    </script>
  </body>
</html>`
}

/**
 * Escape characters that would break out of a `"..."` JS string
 * literal, plus a few that are safe inside JSON but unsafe inside
 * inline `<script>` blocks (`<` could start `</script>`,
 * U+2028/U+2029 terminate JS lines silently).
 */
function escapeForJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
