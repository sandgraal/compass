---
'compass': minor
---

**Plaid SDK client wrapper** — Phase 4.6 PR 2b. The encrypted vault (PR 2a) holds the per-env Plaid API secret and per-Item access tokens; this PR is the consumer that turns "vault + config" into a ready-to-use `PlaidApi` instance. Next PRs (Link flow, sync loop) build on top of `getPlaidClient(env)`.

- New `electron/integrations/plaid/config.ts` — parses `~/.config/compass/plaid.env` (non-secret `PLAID_CLIENT_ID` + `PLAID_ENV`). Tiny KEY=value parser (no `dotenv` dep). Rejects the retired `development` env with a pointer to Plaid's 2024 migration instead of silently routing to the wrong base path. 15 unit tests.
- New `electron/integrations/plaid/client.ts` — `getPlaidClient(env?)` reads config + secret on every call (stateless, mirroring the vault's "no in-memory caching" invariant so a rotated secret can never be masked by a stale instance). Returns `{ api, env, clientId }`. Throws a typed `PlaidNotConfiguredError` with `reason: 'missing-config' | 'missing-secret' | 'env-mismatch'` so the upcoming Integrations card can detect "needs setup" cleanly. Plus `isPlaidConfigured()` that swallows errors and returns a renderer-safe boolean. 12 unit tests covering header wiring, base-path routing, stateless re-reads, env-mismatch rejection, and error swallowing.
- `plaid@^42.2.0` added to dependencies.

Renderer cannot import this module — all Plaid calls happen in main, where the access token decryption already lives.
