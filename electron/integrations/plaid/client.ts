/**
 * Thin wrapper around the official `plaid` SDK that wires together
 * the non-secret config file (`~/.config/compass/plaid.env`) and the
 * encrypted vault (`.vault/plaid.enc`) into a ready-to-use `PlaidApi`
 * instance.
 *
 * The wrapper is intentionally stateless: every call to
 * `getPlaidClient(env)` re-reads config + secret and constructs a
 * fresh `PlaidApi`. That mirrors the vault's "no in-memory caching"
 * invariant — if the user rotates a secret, the very next call picks
 * it up, and a corrupted vault fails loudly here rather than getting
 * masked by a stale cached instance.
 *
 * Construction is cheap (one axios instance under the hood), so the
 * stateless choice is the right default. If profiling later shows the
 * re-construction matters for the sync loop, cache by the
 * `(env, clientId, secret)` tuple — not by `env` alone — so a rotated
 * secret invalidates the cache automatically.
 *
 * Renderer code MUST NOT import this module. Only the main process
 * (IPC handlers, cron, sync loop) should ever construct a Plaid
 * client, because doing so requires reading the encrypted access
 * token / secret from disk.
 */

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import { type PlaidClientEnv, readPlaidConfig } from './config'
import { getPlaidSecret } from './vault'

export type { PlaidClientEnv } from './config'

/**
 * The Plaid `PlaidApi` instance plus the env it was built for.
 * Callers occasionally need to know which env they're hitting
 * (e.g. to log "synced 3 transactions from sandbox") without
 * keeping a separate variable.
 */
export type PlaidClient = {
  api: PlaidApi
  env: PlaidClientEnv
  clientId: string
}

/** Thrown when the user hasn't finished configuring Plaid. */
export class PlaidNotConfiguredError extends Error {
  readonly reason: 'missing-config' | 'missing-secret' | 'env-mismatch'
  constructor(reason: PlaidNotConfiguredError['reason'], message: string) {
    super(message)
    this.name = 'PlaidNotConfiguredError'
    this.reason = reason
  }
}

/**
 * Build a Plaid API client. If `env` is omitted, uses whatever
 * `plaid.env` says (the common case — most callers just want
 * "the configured Plaid"). If `env` is provided, it must match the
 * configured env; we refuse cross-env operation because mixing
 * sandbox tokens with production base paths is a guaranteed
 * misconfiguration and a security-relevant one.
 *
 * Throws `PlaidNotConfiguredError` (rather than a generic Error)
 * so callers can detect the "needs setup" case and surface a
 * setup CTA instead of a stack trace.
 */
export function getPlaidClient(env?: PlaidClientEnv): PlaidClient {
  const cfg = readPlaidConfig()
  if (!cfg) {
    throw new PlaidNotConfiguredError(
      'missing-config',
      'Plaid is not configured. Create ~/.config/compass/plaid.env with PLAID_CLIENT_ID and PLAID_ENV.'
    )
  }

  if (env !== undefined && env !== cfg.env) {
    throw new PlaidNotConfiguredError(
      'env-mismatch',
      `Plaid is configured for '${cfg.env}' but caller requested '${env}'. Update PLAID_ENV in ~/.config/compass/plaid.env or omit the env argument.`
    )
  }

  const secret = getPlaidSecret(cfg.env)
  if (!secret) {
    throw new PlaidNotConfiguredError(
      'missing-secret',
      `Plaid secret for env '${cfg.env}' is not stored. Save it via the Integrations card before syncing.`
    )
  }

  const basePath = PlaidEnvironments[cfg.env]
  const configuration = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': cfg.clientId,
        'PLAID-SECRET': secret,
        'Plaid-Version': '2020-09-14'
      }
    }
  })

  return {
    api: new PlaidApi(configuration),
    env: cfg.env,
    clientId: cfg.clientId
  }
}

/**
 * Returns whether `getPlaidClient()` would succeed. Cheap — reads
 * the same files but doesn't construct an SDK instance. Renderer-
 * safe in the sense that it returns a plain boolean (still requires
 * IPC because the underlying reads happen in main).
 */
export function isPlaidConfigured(): { configured: boolean; env: PlaidClientEnv | null } {
  try {
    const cfg = readPlaidConfig()
    if (!cfg) return { configured: false, env: null }
    const secret = getPlaidSecret(cfg.env)
    return { configured: secret !== null, env: cfg.env }
  } catch {
    return { configured: false, env: null }
  }
}
