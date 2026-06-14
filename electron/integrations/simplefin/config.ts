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
 * How many days of history to request on the FIRST sync of a connection — we
 * want as much backfill as the bridge will serve (up to ~90 days). Some strict
 * institutions (e.g. USAA via MX) emit a non-fatal "exceeds recommended range
 * of 45 days" warning at 90; that's a one-time cost on first connect for the
 * benefit of more history, and the data still comes back.
 */
export const SIMPLEFIN_LOOKBACK_DAYS = 90

/**
 * How many days each SUBSEQUENT sync requests. Syncs run daily, so 30 days is a
 * generous overlap that still catches late-posting / backdated transactions —
 * and it stays under every institution's recommended range, so the recurring
 * sync doesn't trip the 45-day warning. The `hash` UNIQUE constraint dedupes
 * the overlap, so re-pulling is a no-op.
 */
export const SIMPLEFIN_INCREMENTAL_LOOKBACK_DAYS = 30
