/**
 * `compass://` URL scheme — May 2026 strategic-review Tier 3 #11.
 *
 * Registers Compass as the default handler for `compass://...` URLs and
 * routes a small command vocabulary into the running app:
 *
 *   compass://capture?text=…&category=…    → quick-add to today's daily list
 *   compass://open/<page>                  → navigate to a top-level page
 *   compass://search?q=…                   → open the command palette pre-filled
 *
 * Why this matters: Apple Shortcuts, Raycast, the macOS Services menu,
 * URL schemes in third-party apps — all of them speak this. Adding the
 * handler turns Compass into something a power user can wire into their
 * existing automations without us having to ship a CLI or a Shortcuts
 * extension separately.
 *
 * Cross-platform notes:
 *   - macOS:  `open-url` event fires when a URL is opened against this
 *             scheme. Process is already running → event arrives in the
 *             same process. Cold launch → fired after `app.whenReady()`.
 *   - Win/Linux: URL arrives in argv on launch. Single-instance lock
 *             routes a second-instance click into the existing process
 *             via `second-instance`.
 */

import { type BrowserWindow, app } from 'electron'
import { getDb } from './db/client'
import { checklistItems } from './db/schema'

const SCHEME = 'compass'
const CAPTURE_RATE_LIMIT_WINDOW_MS = 60_000
const CAPTURE_RATE_LIMIT_MAX = 20
const recentCaptureTimestamps: number[] = []

/** Top-level pages we'll honour for `compass://open/<page>`. Anything else is ignored. */
const ALLOWED_PAGES = new Set([
  'dashboard',
  'daily',
  'weekly',
  'monthly',
  'knowledge',
  'vault',
  'finance',
  'integrations',
  'settings'
])

export interface CompassCommand {
  kind: 'capture' | 'open' | 'search' | 'unknown'
  text?: string
  category?: string
  page?: string
  query?: string
}

/**
 * Parse a `compass://…` URL into a typed command. Returns `unknown` for
 * anything we don't recognise so the caller can ignore it without
 * throwing.
 */
export function parseCompassUrl(input: string): CompassCommand {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { kind: 'unknown' }
  }
  if (url.protocol.replace(/:$/, '') !== SCHEME) return { kind: 'unknown' }
  // `compass://capture` parses as host="capture", but `compass:///capture`
  // (rare, but legal) parses as host="" pathname="/capture". Normalise by
  // joining + stripping leading slash.
  const route = `${url.host}${url.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '')
  if (route === 'capture') {
    const text = url.searchParams.get('text') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    return { kind: 'capture', text, category }
  }
  if (route.startsWith('open/')) {
    const page = route.slice('open/'.length).toLowerCase()
    if (ALLOWED_PAGES.has(page)) return { kind: 'open', page }
    return { kind: 'unknown' }
  }
  if (route === 'search') {
    const query = url.searchParams.get('q') ?? undefined
    return { kind: 'search', query }
  }
  return { kind: 'unknown' }
}

/**
 * Execute a parsed command. `capture` writes to the DB directly (same
 * path the tray quick-capture popup uses); `open` / `search` are routed
 * to the renderer via IPC so the existing in-app navigation handles
 * them.
 */
export function executeCompassCommand(
  command: CompassCommand,
  mainWindow: BrowserWindow | null
): { ok: boolean; reason?: string } {
  switch (command.kind) {
    case 'capture': {
      const trimmed = (command.text ?? '').trim()
      if (!trimmed) return { ok: false, reason: 'capture requires non-empty text' }
      const now = Date.now()
      let expiredCount = 0
      while (
        expiredCount < recentCaptureTimestamps.length &&
        now - recentCaptureTimestamps[expiredCount] > CAPTURE_RATE_LIMIT_WINDOW_MS
      ) {
        expiredCount += 1
      }
      if (expiredCount > 0) {
        recentCaptureTimestamps.splice(0, expiredCount)
      }
      if (recentCaptureTimestamps.length >= CAPTURE_RATE_LIMIT_MAX) {
        return { ok: false, reason: 'capture rate limit exceeded' }
      }
      try {
        const db = getDb()
        const today = new Date().toISOString().slice(0, 10)
        db.insert(checklistItems)
          .values({
            listType: 'daily',
            listDate: today,
            title: trimmed.slice(0, 500),
            category: command.category?.slice(0, 50) || 'personal',
            sortOrder: 999,
            source: 'manual',
            createdAt: new Date()
          })
          .run()
        recentCaptureTimestamps.push(now)
        mainWindow?.webContents.send('compass-url:captured', { title: trimmed })
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'open': {
      if (!command.page) return { ok: false, reason: 'open requires a page' }
      mainWindow?.webContents.send('compass-url:open', { page: command.page })
      mainWindow?.show()
      mainWindow?.focus()
      return { ok: true }
    }
    case 'search': {
      mainWindow?.webContents.send('compass-url:search', { query: command.query ?? '' })
      mainWindow?.show()
      mainWindow?.focus()
      return { ok: true }
    }
    default:
      return { ok: false, reason: 'unknown command' }
  }
}

/**
 * Walk argv for any `compass://…` argument. Used on cold-launch (macOS
 * fires `open-url` separately, but Windows/Linux pass URLs through
 * argv). Returns the first match — we don't expect more than one.
 */
export function findCompassUrlInArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${SCHEME}://`)) return arg
  }
  return null
}

/**
 * Wire the URL scheme. Call once at app startup, before / alongside
 * `app.whenReady()`.
 *
 * Returns a `pump` function the caller invokes after the main window
 * exists, so any URL queued before the window was ready can fire now.
 */
export function registerCompassUrlScheme(getMainWindow: () => BrowserWindow | null): {
  pump: () => void
} {
  if (process.defaultApp && process.argv.length >= 2) {
    // Dev: register with the script path so `electron .` still owns the
    // scheme. In packaged builds the default registration works.
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(SCHEME)
  }

  const queue: string[] = []
  let loadListenerAttachedTo: BrowserWindow | null = null

  function pump(): void {
    if (queue.length === 0) return
    const pendingCount = queue.length
    for (let i = 0; i < pendingCount; i += 1) {
      dispatch(queue[i])
    }
    queue.splice(0, pendingCount)
  }

  function attachDidFinishLoadPump(win: BrowserWindow): void {
    if (!win.webContents.isLoadingMainFrame()) {
      pump()
      return
    }
    if (loadListenerAttachedTo === win) return
    loadListenerAttachedTo = win
    win.webContents.once('did-finish-load', () => {
      loadListenerAttachedTo = null
      pump()
    })
  }

  function dispatch(url: string): void {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      queue.push(url)
      return
    }
    if (win.webContents.isLoadingMainFrame()) {
      queue.push(url)
      attachDidFinishLoadPump(win)
      return
    }
    const cmd = parseCompassUrl(url)
    const result = executeCompassCommand(cmd, win)
    if (!result.ok) {
      console.warn('[url-scheme] command failed:', {
        kind: cmd.kind,
        reason: result.reason ?? 'unknown'
      })
    }
  }

  // macOS: native event when the URL is opened against the app.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    dispatch(url)
  })

  // Windows / Linux: secondary launch arrives via single-instance.
  // We need the lock — `requestSingleInstanceLock` is the right call
  // but cron-mode tests don't get a window, so we no-op gracefully if
  // the lock is denied.
  const gotLock = app.requestSingleInstanceLock()
  if (gotLock) {
    app.on('second-instance', (_event, argv) => {
      const win = getMainWindow()
      if (win) {
        win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      const url = findCompassUrlInArgv(argv)
      if (url) dispatch(url)
    })
  } else {
    console.warn('[url-scheme] single-instance lock denied; skipping URL routing in this process')
  }

  // Cold-launch URL in argv (Windows/Linux). macOS uses `open-url`
  // which fires later so we don't double-process here.
  if (process.platform !== 'darwin' && gotLock) {
    const url = findCompassUrlInArgv(process.argv)
    if (url) dispatch(url)
  }

  return {
    pump
  }
}

// Exported for unit tests.
export const _internal = { ALLOWED_PAGES, SCHEME }
