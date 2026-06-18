/**
 * CRED engine — orchestration core (Phase 10.6a). **Electron-free on purpose**
 * so the whole portal-pull flow is unit-testable with a fake `AutomationPage`,
 * with no real window or network. The real `BrowserWindow` lives in `window.ts`
 * (integration-only), behind the same `AutomationPage` seam.
 *
 * The flow (Mode A — assisted login, no stored credentials):
 *   goto(loginUrl) → wait until the user has logged in → adapter.fetch() →
 *   normalise to a file path → hand to the Drop Zone ingest (in `cred.ts`).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationPage, PortalAdapter } from './types'

/** Thrown when the user never reaches the authenticated area before the deadline. */
export class CredTimeoutError extends Error {
  constructor(portalId: string) {
    super(`cred: timed out waiting for login to ${portalId}`)
    this.name = 'CredTimeoutError'
  }
}

/**
 * True iff `targetUrl`'s origin is in the allow-list. The window's will-navigate
 * guard uses this to keep the session pinned to the portal — an open-redirect
 * can't walk the logged-in session off to another origin. `about:blank` (the
 * window's own initial document) is always allowed.
 */
export function isAllowedNavigation(targetUrl: string, allowedOrigins: string[]): boolean {
  if (targetUrl === '' || targetUrl === 'about:blank') return true
  try {
    return allowedOrigins.includes(new URL(targetUrl).origin)
  } catch {
    return false
  }
}

/**
 * Reduce a portal-suggested filename to a safe basename — no path components, no
 * traversal, no surprises — so the forced download save path can't escape the
 * temp dir. Always returns a non-empty name.
 */
export function sanitizeDownloadName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
  return base.length > 0 ? base.slice(0, 128) : 'download'
}

export interface PollOpts {
  /** How often to re-check login state. */
  pollMs?: number
  /** How long to wait before giving up (assisted login can be slow — MFA, etc.). */
  timeoutMs?: number
  /** Injectable for tests so the wait doesn't actually sleep. */
  delay?: (ms: number) => Promise<void>
  /** Injectable clock for deterministic timeout tests. */
  now?: () => number
}

/**
 * Poll `adapter.isLoggedIn` until it's true or the deadline passes. This is the
 * "assisted login" wait: the human is logging in on the real page at their own
 * pace; we just watch for the authenticated state to appear.
 */
export async function pollUntilLoggedIn(
  adapter: PortalAdapter,
  page: AutomationPage,
  opts: PollOpts = {}
): Promise<void> {
  const pollMs = opts.pollMs ?? 1500
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const delay = opts.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs

  let loggedIn = await adapter.isLoggedIn(page)
  while (!loggedIn) {
    if (now() >= deadline) throw new CredTimeoutError(adapter.id)
    await delay(pollMs)
    loggedIn = await adapter.isLoggedIn(page)
  }
}

export interface RunPortalPullOpts {
  /** Injectable login wait; default polls `isLoggedIn`. */
  waitForLogin?: (adapter: PortalAdapter, page: AutomationPage) => Promise<void>
  /** Where a scrape artifact is written. Default: a fresh temp dir. */
  tmpDir?: string
  /** Filename discriminator for scrape artifacts (tests pass a fixed value). */
  stamp?: string
}

/**
 * Drive one portal end-to-end and return the path of the artifact to ingest.
 * A `download` artifact is already a file; a `scrape` artifact is written to a
 * temp file so it re-enters the SAME validated ingest as a manual file drop.
 */
export async function runPortalPull(
  adapter: PortalAdapter,
  page: AutomationPage,
  opts: RunPortalPullOpts = {}
): Promise<{ path: string }> {
  await page.goto(adapter.loginUrl)
  const waitForLogin = opts.waitForLogin ?? ((a, p) => pollUntilLoggedIn(a, p))
  await waitForLogin(adapter, page)

  const artifact = await adapter.fetch(page)
  if (artifact.kind === 'download') return { path: artifact.path }

  // scrape → temp file, named safely, so ingest treats it like any dropped file.
  const dir = opts.tmpDir ?? mkdtempSync(join(tmpdir(), 'compass-cred-'))
  const ext = /^[A-Za-z0-9]{1,8}$/.test(artifact.ext) ? artifact.ext : 'txt'
  const path = join(dir, `${sanitizeDownloadName(adapter.id)}-${opts.stamp ?? 'scrape'}.${ext}`)
  writeFileSync(path, artifact.text, 'utf-8')
  return { path }
}
