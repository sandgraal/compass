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

import {
  BrowserWindow,
  type Event,
  type IpcMain,
  type WebContentsWillNavigateEventParams
} from 'electron'
import { PlaidNotConfiguredError, isPlaidConfigured } from '../integrations/plaid/client'
import {
  type ExchangeResult,
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
  configured: boolean
  env: PlaidEnv | null
  hasSecret: boolean
  linkedItemIds: string[]
}

export function registerPlaidHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('plaid:get-status', (): PlaidStatus => {
    const { configured, env } = isPlaidConfigured()
    return {
      configured,
      env,
      hasSecret: env !== null && getPlaidSecret(env) !== null,
      linkedItemIds: listItemIds()
    }
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
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, cancelled: false, errorCode: 'LINK_START_FAILED', errorMessage: message }
    }
  })

  ipcMain.handle('plaid:disconnect', (_e, itemId: unknown): { ok: true } => {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new Error('plaid:disconnect: itemId must be a non-empty string')
    }
    removeAccessToken(itemId)
    return { ok: true }
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
export async function runLinkFlow(linkToken: string): Promise<StartLinkResult> {
  const html = buildLinkHtml(linkToken)
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

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
      sandbox: true
    }
  })

  // Tighten CSP for the Link window only: allow Plaid's CDN + API
  // hosts, deny everything else. The main window's CSP is unchanged.
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' data: https://cdn.plaid.com https://*.plaid.com; " +
            "script-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com; " +
            "style-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com; " +
            "img-src 'self' data: blob: https://cdn.plaid.com https://*.plaid.com; " +
            "font-src 'self' data: https://cdn.plaid.com https://*.plaid.com; " +
            "connect-src 'self' https://*.plaid.com; " +
            'frame-src https://*.plaid.com; ' +
            "object-src 'none'"
        ]
      }
    })
  })

  return new Promise<StartLinkResult>((resolve) => {
    let settled = false
    const finish = (r: StartLinkResult): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.destroy()
      resolve(r)
    }

    const intercept = (details: Event<WebContentsWillNavigateEventParams>, url: string): void => {
      if (!url.startsWith(LINK_CALLBACK_SCHEME)) return
      details.preventDefault()
      handleCallback(url).then(finish, (err) => {
        const message = err instanceof Error ? err.message : String(err)
        finish({ ok: false, cancelled: false, errorCode: 'EXCHANGE_FAILED', errorMessage: message })
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
    void win.loadURL(dataUrl)
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
