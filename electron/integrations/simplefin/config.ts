/**
 * SimpleFIN Bridge configuration constants (Phase 4.7).
 *
 * Unlike Plaid, SimpleFIN needs NO developer credentials — there is no
 * client_id, no API secret, no `*.env` file. Each user signs up with SimpleFIN
 * Bridge themselves and hands Compass a one-time Setup Token; the only "config"
 * is the default bridge host (used for the setup-guide copy and the CSP
 * allowlist) and how far back each sync pulls.
 *
 * Everything secret — the claimed Access URL, which embeds HTTP Basic
 * credentials — lives encrypted in `.vault/simplefin.enc` (see vault.ts) and
 * NEVER touches this file, SQLite, or the renderer.
 */

/**
 * Default SimpleFIN Bridge hosts. The claim/access URLs the user provides may
 * point at one of these or at a self-hosted bridge, so we never hard-code them
 * into requests — these constants exist only for the setup-guide copy and the
 * main-window CSP allowlist.
 */
export const SIMPLEFIN_BRIDGE_HOST = 'bridge.simplefin.org'
export const SIMPLEFIN_BETA_BRIDGE_HOST = 'beta-bridge.simplefin.org'

/**
 * How many days of history each sync requests. SimpleFIN serves up to ~90 days
 * per linked account. Re-pulling the full window on every daily run is safe and
 * intentional: the `hash` UNIQUE constraint on finance_transactions dedupes any
 * row we've already seen, so a cursorless re-pull inserts nothing new.
 */
export const SIMPLEFIN_LOOKBACK_DAYS = 90
