---
'compass': minor
---

**Plaid Link flow** — Phase 4.6 PR 3. PR 2b built the SDK client wrapper; this PR wires the in-app Link experience so a user can actually authorize a bank without leaving Compass.

- New `electron/integrations/plaid/link.ts`:
  - `createLinkToken()` → calls Plaid `/link/token/create` with a pinned product list (`transactions` only — narrowest possible consent screen), `country_codes: ['US']`, and a stable per-process `client_user_id` UUID. Returns the short-lived link token + expiration.
  - `exchangePublicToken(publicToken)` → trades the one-time public token for the long-lived `access_token` + `item_id`. Token is written to the encrypted vault **before** any metadata fetch, so a mid-flow crash can never strand an Item we can't reach. `accountsGet` + `institutionsGetById` failures are non-fatal — caller gets `{ accounts: [], institutionName: null }` and the token is still safely stored. Access token NEVER appears in the return value.
  - `buildLinkHtml(linkToken)` → self-contained HTML that loads `cdn.plaid.com/link/v2/stable/link-initialize.js` and posts back via the `compass-plaid://success` / `exit` scheme. Token is escaped against `<`, `"`, `\`, newlines, U+2028, U+2029 before interpolation.
- New `electron/ipc/plaid.ts` registering four handlers:
  - `plaid:get-status` → `{ configured, env, hasSecret, linkedItemIds }`
  - `plaid:set-secret` → store per-env API secret (sandbox / production only; the retired `development` env is rejected at this seam too)
  - `plaid:start-link` → spawns the child `BrowserWindow`, intercepts `compass-plaid://` callbacks, resolves with either `{ ok: true, result }`, `{ ok: false, cancelled: true }` (user closed the window), or `{ ok: false, cancelled: false, errorCode, errorMessage }`. Programmer errors (bad arg types) reject; user-cancellation is a state, not an error.
  - `plaid:disconnect` → tombstones the access token in the vault (calling Plaid `/item/remove` lands in PR 4 with the sync loop).
- Child BrowserWindow runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a tightened **per-window CSP** that allows `cdn.plaid.com` + `*.plaid.com` and denies everything else. The main window's CSP is untouched.
- Preload + `src/types/electron.d.ts` expose the new `window.api.plaid.*` surface.
- 36 unit tests (21 link helpers + 15 IPC). Full suite green at 590/590.

The actual `cdn.plaid.com` round-trip is not exercised in unit tests — that's an integration target for PR 5/6.
