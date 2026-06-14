/**
 * Non-secret Plaid configuration loader.
 *
 * The user's Plaid `client_id` and the chosen environment live in a
 * plain text file at `~/.config/compass/plaid.env`. These are not
 * secrets — `client_id` is the public half of the credential pair —
 * but pinning the env to a file (rather than `app_settings` or an
 * env var) keeps the choice explicit and easy to audit.
 *
 *     PLAID_CLIENT_ID=abcdef...
 *     PLAID_ENV=sandbox
 *
 * The corresponding `PLAID_SECRET_*` is NEVER read from here — it
 * lives encrypted in `.vault/plaid.enc` via `vault.ts`.
 *
 * Plaid retired the `development` tier in 2024; this loader rejects
 * it with a pointer to the migration path so a stale plaid.env
 * fails loudly instead of silently routing to production.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type PlaidClientEnv = 'sandbox' | 'production'

export type PlaidConfig = {
  clientId: string
  env: PlaidClientEnv
}

/** Override-able for tests. Defaults to `~/.config/compass/plaid.env`. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'compass', 'plaid.env')

const VALID_ENVS: ReadonlySet<string> = new Set(['sandbox', 'production'])

/**
 * Parse a `KEY=value` style file. Blank lines and `#` comments are
 * skipped; the rest is split on the FIRST `=` so values with `=` in
 * them (rare for Plaid credentials, but possible) survive. Quotes
 * surrounding the value are stripped.
 *
 * Intentionally tiny — we don't want to pull in `dotenv` for two keys.
 */
export function parsePlaidEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Returns the parsed config, or null if no file exists at `path`.
 * Throws when the file is present but missing required keys or
 * contains an unsupported env — these are user-actionable misconfigurations
 * and silently coercing them would hide the problem.
 */
export function readPlaidConfig(path: string = DEFAULT_CONFIG_PATH): PlaidConfig | null {
  if (!existsSync(path)) return null
  const parsed = parsePlaidEnv(readFileSync(path, 'utf8'))

  const clientId = parsed.PLAID_CLIENT_ID
  if (!clientId || clientId.length === 0) {
    throw new Error(`Plaid config at ${path} is missing PLAID_CLIENT_ID`)
  }

  const envRaw = parsed.PLAID_ENV ?? 'sandbox'
  if (envRaw === 'development') {
    throw new Error(
      `Plaid config at ${path} sets PLAID_ENV=development, which Plaid retired in 2024. Use 'sandbox' for testing or 'production' for live data.`
    )
  }
  if (!VALID_ENVS.has(envRaw)) {
    throw new Error(
      `Plaid config at ${path} has invalid PLAID_ENV='${envRaw}'. Expected 'sandbox' or 'production'.`
    )
  }

  return { clientId, env: envRaw as PlaidClientEnv }
}

/**
 * Write the non-secret Plaid config (`PLAID_CLIENT_ID` + `PLAID_ENV`) to
 * `path`, creating the parent directory if needed. The client_id is the public
 * half of the credential pair, so plaintext on disk is acceptable (the secret
 * still lives encrypted in the vault). Lets the renderer configure Plaid from
 * an in-app form instead of the user hand-editing the file. `path` is
 * override-able for tests.
 */
export function writePlaidConfig(
  clientId: string,
  env: PlaidClientEnv,
  path: string = DEFAULT_CONFIG_PATH
): void {
  const trimmed = clientId.trim()
  if (trimmed.length === 0) {
    throw new Error('writePlaidConfig: PLAID_CLIENT_ID must not be empty')
  }
  if (!VALID_ENVS.has(env)) {
    throw new Error(`writePlaidConfig: invalid env '${env}'. Expected 'sandbox' or 'production'.`)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `PLAID_CLIENT_ID=${trimmed}\nPLAID_ENV=${env}\n`, 'utf8')
}
