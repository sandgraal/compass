/**
 * IPC surface for Plaid Link (Phase 4.6 — PR 3).
 *
 * Exposes three calls to the renderer:
 *
 *  - `plaid:get-status`   → { configured, env, linkedItemIds }
 *  - `plaid:set-secret`   → store the per-env Plaid API secret in vault
 *  - `plaid:start-link`   → opens the Link child window; resolves with
 *                           the result of the exchange ({ itemId, ... })
 *                           when the user finishes, or `{ cancelled: true }`
 *                           when they back out. Never resolves with the
 *                           access token — that lives in the vault only.
 *  - `plaid:disconnect`   → tombstones the access token in the vault.
 *                           (Calling `/item/remove` in Plaid is deferred
 *                           to PR 4 — the sync loop module — so this
 *                           module stays focused on the Link path.)
 *
 * The child window is created on demand and destroyed as soon as
 * `compass-plaid://success` or `compass-plaid://exit` is intercepted.
 * If the user closes the window without finishing Link, we resolve
 * with `{ cancelled: true }` so the renderer can dismiss whatever
 * spinner it was showing.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import {
  BrowserWindow,
  type Event,
  type IpcMain,
  type WebContentsWillNavigateEventParams
} from 'electron'
import { getDb } from '../db/client'
import { plaidItems } from '../db/schema'
import { PlaidNotConfiguredError } from '../integrations/plaid/client'
import { readPlaidConfig, writePlaidConfig } from '../integrations/plaid/config'
import { describePlaidFailure } from '../integrations/plaid/errors'
import {
  type ExchangeResult,
  LINK_CSP,
  buildLinkHtml,
  createLinkToken,
  exchangePublicToken
} from '../integrations/plaid/link'
import {
  type PlaidEnv,
  getPlaidSecret,
  listItemIds,
  removeAccessToken,
  setPlaidSecret
} from '../integrations/plaid/vault'

const LINK_CALLBACK_SCHEME = 'compass-plaid:'

type StartLinkResult =
  | { ok: true; result: ExchangeResult }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; errorCode: string | null; errorMessage: string | null }

export type PlaidStatus = {
  /** Fully ready to Link: client_id + env + secret all present. */
  configured: boolean
  /** client_id + env present (the non-secret config file exists & is valid). */
  hasConfig: boolean
  env: PlaidEnv | null
  /** The configured client_id (public half — safe to show), or null. */
  clientId: string | null
  hasSecret: boolean
  linkedItemIds: string[]
}

/**
 * Per-Item summary returned to the renderer. Surfaces just the fields the
 * Integrations card needs to render — no cursors, no tokens, no secrets.
 */
export type PlaidItemSummary = {
  id: number
  itemId: string
  institutionId: string
  institutionName: string
  lastSyncedAt: number | null
  errorCode: string | null
}

export function registerPlaidHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('plaid:get-status', (): PlaidStatus => {
    let clientId: string | null = null
    let env: PlaidEnv | null = null
    try {
      const cfg = readPlaidConfig()
      if (cfg) {
        clientId = cfg.clientId
        env = cfg.env
      }
    } catch {
      // Malformed config file (missing client_id / bad env) → treat as
      // needs-setup so the renderer shows the in-app setup form rather than
      // surfacing a hard error.
    }
    const hasConfig = clientId !== null && env !== null
    const hasSecret = env !== null && getPlaidSecret(env) !== null
    return {
      configured: hasConfig && hasSecret,
      hasConfig,
      env,
      clientId,
      hasSecret,
      linkedItemIds: listItemIds()
    }
  })

  // Store the non-secret Plaid config (client_id + environment). Paired with
  // plaid:set-secret, this lets the renderer configure Plaid entirely in-app —
  // no hand-editing ~/.config/compass/plaid.env.
  ipcMain.handle('plaid:set-config', (_e, clientId: unknown, env: unknown): { ok: true } => {
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw new Error('plaid:set-config: clientId must be a non-empty string')
    }
    if (env !== 'sandbox' && env !== 'production') {
      throw new Error("plaid:set-config: env must be 'sandbox' or 'production'")
    }
    writePlaidConfig(clientId, env)
    return { ok: true }
  })

  ipcMain.handle('plaid:set-secret', (_e, env: unknown, secret: unknown): { ok: true } => {
    if (env !== 'sandbox' && env !== 'production') {
      throw new Error("plaid:set-secret: env must be 'sandbox' or 'production'")
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('plaid:set-secret: secret must be a non-empty string')
    }
    setPlaidSecret(env, secret)
    return { ok: true }
  })

  ipcMain.handle('plaid:start-link', async (): Promise<StartLinkResult> => {
    try {
      const { linkToken } = await createLinkToken()
      return await runLinkFlow(linkToken)
    } catch (err) {
      if (err instanceof PlaidNotConfiguredError) {
        return { ok: false, cancelled: false, errorCode: err.reason, errorMessage: err.message }
      }
      // A 400/4xx from /link/token/create is an axios error whose `.message` is
      // just "Request failed with status code 400" — surface Plaid's real
      // error_code/error_message (e.g. INVALID_API_KEYS) so the user can act.
      const { errorCode, errorMessage } = describePlaidFailure(err, 'LINK_START_FAILED')
      return { ok: false, cancelled: false, errorCode, errorMessage }
    }
  })

  ipcMain.handle('plaid:disconnect', (_e, itemId: unknown): { ok: true } => {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new Error('plaid:disconnect: itemId must be a non-empty string')
    }
    removeAccessToken(itemId)
    // Also delete the plaid_items row so the Integrations card stops
    // showing the institution. Access tokens (vault) and rows (SQLite)
    // are paired — removing one and leaving the other is a bug magnet.
    //
    // No try/catch around the DELETE: a missing row is not an error
    // (better-sqlite3 returns changes=0, doesn't throw), and a real DB
    // failure SHOULD propagate so the renderer can surface it instead of
    // showing a ghost institution from a half-applied disconnect.
    getDb().delete(plaidItems).where(eq(plaidItems.itemId, itemId)).run()
    return { ok: true }
  })

  // List connected Items for the Integrations card. Returns DB metadata
  // only — no tokens, no secrets, no cursors. The renderer joins this
  // against `financeAccounts.plaidItemId` to render the "linked" badge.
  ipcMain.handle('plaid:list-items', (): PlaidItemSummary[] => {
    const rows = getDb()
      .select({
        id: plaidItems.id,
        itemId: plaidItems.itemId,
        institutionId: plaidItems.institutionId,
        institutionName: plaidItems.institutionName,
        lastSyncedAt: plaidItems.lastSyncedAt,
        errorCode: plaidItems.errorCode
      })
      .from(plaidItems)
      .all()
    return rows.map((r) => ({
      ...r,
      // Serialize Date → epoch ms for the renderer; the preload bridge
      // can't ship live Date objects across the IPC boundary.
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.getTime() : null
    }))
  })
}

/**
 * Spawn the Link child window, wait for the user to either finish
 * the flow or close it, and resolve with the outcome. Exported for
 * tests via a thin shim — production code calls it via the IPC.
 *
 * Notable contract:
 *  - The promise resolves; it does not reject for user-cancellation.
 *    Anything the user could legitimately do counts as a state, not
 *    an error. Only programmer errors (bad arg types) reject.
 *  - The window is destroyed exactly once, in whichever path runs
 *    first. The `settled` guard keeps `closed` from re-resolving
 *    after success.
 */
/**
 * Non-persistent partition name for the Link window. Two reasons it
 * must NOT live on the default session:
 *
 *  1. Electron's `session.webRequest.onHeadersReceived` allows only
 *     ONE listener per session — installing ours on the default
 *     session would overwrite `electron/main.ts`'s main-window CSP
 *     hook and leak Plaid's allowlist into every other window for
 *     the rest of the process lifetime.
 *  2. Cookies / cache / storage from Plaid's CDN have no business
 *     surviving past the auth flow. A bare partition string (no
 *     `persist:` prefix) is in-memory only, so it is wiped when the
 *     last window using it closes.
 */
const LINK_PARTITION = 'plaid-link'

/**
 * Serve a one-shot HTML page from an ephemeral 127.0.0.1 HTTP server and
 * resolve its `http://127.0.0.1:<port>/` URL.
 *
 * Plaid Link refuses to initialize inside a document with an OPAQUE
 * origin: its CDN-hosted iframe runs an origin-checked postMessage
 * handshake with the host page, and a `data:` (or `file:`) URL reports
 * its origin as the literal string "null", so the handshake target never
 * matches and the Link iframe sits on its loading spinner forever
 * (exactly the "Loading Plaid Link…" → endless spinner symptom).
 *
 * Serving the page over loopback HTTP gives the document a real, stable
 * origin that Plaid explicitly accepts. The server binds to 127.0.0.1
 * only and serves nothing but `html`; the caller owns the returned
 * `server` and must `server.close()` once the flow settles. Mirrors the
 * OAuth loopback in `electron/ipc/auth.ts`. Exported for tests.
 */
export async function serveLinkPageOnLoopback(
  html: string
): Promise<{ url: string; server: Server }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    // Port 0 → the OS hands us a free ephemeral port, avoiding the
    // EADDRINUSE class of failures a fixed port invites.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}/`)
    })
  })

  return { url, server }
}

export async function runLinkFlow(linkToken: string): Promise<StartLinkResult> {
  // Serve Link over a loopback HTTP origin rather than a `data:` URL, so the
  // document's origin is real and Plaid's postMessage handshake matches (see
  // serveLinkPageOnLoopback). The server is torn down in `finish`.
  const { url: linkUrl, server } = await serveLinkPageOnLoopback(buildLinkHtml(linkToken))

  const win = new BrowserWindow({
    width: 480,
    height: 720,
    title: 'Connect a bank',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: LINK_PARTITION
    }
  })

  // CSP is enforced two ways, belt and suspenders. The page itself
  // carries `<meta http-equiv="Content-Security-Policy">` (see
  // buildLinkHtml), AND this header hook stamps the same policy onto the
  // loopback document response and every subresource (the cdn.plaid.com
  // script, fonts, images). The header hook is safe to install
  // unconditionally because it is scoped to the isolated Link partition
  // session — it cannot clobber the default-session hook that
  // `electron/main.ts` installed for the main window's CSP.
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [LINK_CSP]
      }
    })
  })

  return new Promise<StartLinkResult>((resolve) => {
    let settled = false
    const finish = (r: StartLinkResult): void => {
      if (settled) return
      settled = true
      server.close()
      if (!win.isDestroyed()) win.destroy()
      resolve(r)
    }

    const intercept = (details: Event<WebContentsWillNavigateEventParams>, url: string): void => {
      if (!url.startsWith(LINK_CALLBACK_SCHEME)) return
      details.preventDefault()
      handleCallback(url).then(finish, (err) => {
        // The exchange (/item/public_token/exchange) can also 4xx; surface the
        // Plaid error body rather than the bare axios message.
        const { errorCode, errorMessage } = describePlaidFailure(err, 'EXCHANGE_FAILED')
        finish({ ok: false, cancelled: false, errorCode, errorMessage })
      })
    }

    win.webContents.on('will-navigate', intercept)
    win.webContents.on('will-redirect', intercept)
    win.on('closed', () => {
      // User dismissed the window before the flow completed. The
      // settled guard ensures the success path isn't overwritten.
      finish({ ok: false, cancelled: true })
    })

    win.once('ready-to-show', () => win.show())
    void win.loadURL(linkUrl)
  })
}

/**
 * Parse a `compass-plaid://...` callback url and, on success, run
 * the public-token exchange. Exported for tests.
 */
export async function handleCallback(rawUrl: string): Promise<StartLinkResult> {
  const url = new URL(rawUrl)
  if (url.host === 'success') {
    const publicToken = url.searchParams.get('public_token')
    if (!publicToken) {
      return {
        ok: false,
        cancelled: false,
        errorCode: 'MISSING_PUBLIC_TOKEN',
        errorMessage: 'Plaid Link returned success without a public_token'
      }
    }
    const result = await exchangePublicToken(publicToken)
    return { ok: true, result }
  }
  if (url.host === 'exit') {
    return {
      ok: false,
      cancelled: false,
      errorCode: url.searchParams.get('error_code') || null,
      errorMessage: url.searchParams.get('error_message') || null
    }
  }
  return {
    ok: false,
    cancelled: false,
    errorCode: 'UNKNOWN_CALLBACK',
    errorMessage: `Unrecognized Plaid callback: ${url.host}`
  }
}
