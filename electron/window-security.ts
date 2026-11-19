/**
 * Window / session hardening for Compass's own renderer windows (main window,
 * quick capture) and the default session they share.
 *
 * Threat: synced text (mail, contacts, knowledge notes, LLM output) can carry
 * links. The renderer only loads `'self'`, but a link click still reaches
 * `setWindowOpenHandler` / `will-navigate` / the `openExternal` permission, and
 * from there `shell.openExternal`, which hands the URL to the OS. `file:`,
 * `javascript:` and registered protocol handlers (`smb:`, `ms-msdt:`, …) must
 * never get that far.
 *
 * Pure decisions live in the exported predicates so they can be unit tested; the
 * `install*` helpers wire them onto a `WebContents` / `Session`. Electron types
 * are imported as types only — nothing here touches the Electron runtime.
 */

import type { Session, WebContents } from 'electron'

/**
 * Schemes that may be handed to the OS default handler. Everything else is dropped.
 * `tel:` backs the phone links on contact cards (opens the dialer / FaceTime).
 */
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:', 'tel:'])

/**
 * Parse `raw` and return its normalized href iff the scheme is on the external
 * allow-list (`https:`, `http:`, `mailto:`, `tel:`). Returns null for anything else,
 * including unparsable input. Callers pass the returned href (not `raw`) to
 * `shell.openExternal`, so the OS sees exactly what was validated.
 */
export function toSafeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null
  return parsed.href
}

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/**
 * True iff `target` stays inside the app page served from `appUrl`.
 *
 * - Dev (`http://localhost:5173/…`): same origin.
 * - Prod (`file:///…/renderer/index.html`): `file:` origins are opaque (`null`),
 *   so compare the exact file path instead; query and hash may differ (HashRouter).
 *   Any other `file:` path — another local file — is rejected.
 */
export function isAppNavigation(target: string, appUrl: string): boolean {
  let t: URL
  let app: URL
  try {
    t = new URL(target)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') {
    return (
      t.protocol === 'file:' &&
      t.host === app.host &&
      decodedPath(t.pathname) === decodedPath(app.pathname)
    )
  }
  if (app.origin === 'null') return false
  return t.origin === app.origin
}

type OpenExternal = (url: string) => Promise<void>

/** Open `raw` in the OS default handler iff it passes the scheme filter. Never throws. */
export function openExternalSafely(raw: string, openExternal: OpenExternal): boolean {
  const safe = toSafeExternalUrl(raw)
  if (!safe) {
    console.warn('[window-security] blocked external open for disallowed URL scheme')
    return false
  }
  openExternal(safe).catch((err: unknown) => {
    console.warn('[window-security] openExternal failed:', err instanceof Error ? err.message : err)
  })
  return true
}

type GuardedWebContents = Pick<WebContents, 'setWindowOpenHandler' | 'on'>

/**
 * Pin a Compass renderer window to its own page:
 * - every `window.open` / `target="_blank"` is denied in-app; allowed schemes go
 *   to the system browser / mail client;
 * - a top-level navigation off `appUrl` is cancelled; if it was a plain link to
 *   an allowed scheme it opens externally instead of replacing the app;
 * - a redirect off `appUrl` is cancelled outright.
 */
export function installAppWindowGuards(
  webContents: GuardedWebContents,
  appUrl: string,
  openExternal: OpenExternal
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url, openExternal)
    return { action: 'deny' }
  })
  // Electron 45 deprecates the positional `url` argument in favour of `event.url`;
  // read the event first and fall back so the guard never sees an empty target.
  webContents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url || legacyUrl
    if (isAppNavigation(url, appUrl)) return
    event.preventDefault()
    openExternalSafely(url, openExternal)
  })
  webContents.on('will-redirect', (event, legacyUrl) => {
    const url = event.url || legacyUrl
    if (!isAppNavigation(url, appUrl)) event.preventDefault()
  })
}

/**
 * Permissions the Compass renderer actually uses. Everything else is denied.
 * - `clipboard-sanitized-write`: copy buttons (`navigator.clipboard.writeText`).
 * `openExternal` is handled separately (scheme-filtered) in `isPermissionAllowed`.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/**
 * Deny-by-default permission decision. `openExternal` (a plain `<a href="mailto:…">`
 * click goes through this, not `setWindowOpenHandler`) is granted only for an
 * allow-listed scheme; Electron then opens the URL itself.
 */
export function isPermissionAllowed(permission: string, externalURL?: string): boolean {
  if (permission === 'openExternal') return toSafeExternalUrl(externalURL) !== null
  return ALLOWED_PERMISSIONS.has(permission)
}

type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>

/** Install deny-by-default permission request + check handlers on `session`. */
export function installPermissionHandlers(session: PermissionSession): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const externalURL = 'externalURL' in details ? details.externalURL : undefined
    const allowed = isPermissionAllowed(permission, externalURL)
    if (!allowed) console.warn(`[window-security] denied permission request: ${permission}`)
    callback(allowed)
  })
  session.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission))
}
