/**
 * CRED engine — type contracts (Phase 10.6a, the Portal Automation Sandbox).
 *
 * Design gate: docs/cred-engine-design.md. v1 is **Mode A only** — assisted
 * login, *no stored credentials*. The user authenticates on the portal's real
 * page inside a sandboxed window; Compass only drives post-auth navigation and
 * the download, then hands the artifact to the same ingest as a manual drop.
 *
 * The `AutomationPage` interface is the seam that keeps the orchestration
 * (`runtime.ts`) fully unit-testable: production wraps a real Electron
 * `BrowserWindow`'s `webContents`; tests pass a fake page that simulates a
 * portal. No credential, cookie, or page content is ever modelled here — the
 * engine never reads them.
 */

/**
 * A fetched artifact, ready to hand to the Drop Zone. `download` is a file the
 * portal served (the normal path); `scrape` is rendered-page text for portals
 * with no download (the brittle, ToS-grayest path — see design §6.3).
 */
export type CredArtifact =
  | { kind: 'download'; path: string }
  | { kind: 'scrape'; text: string; ext: string }

/**
 * The minimal, testable slice of a sandboxed browser page an adapter is given.
 * Deliberately tiny: navigate, read the current URL, run a snippet, capture a
 * download. There is intentionally **no** API to read or type credentials — in
 * Mode A the human does that on the real page.
 */
export interface AutomationPage {
  /** The page's current committed URL. */
  url(): string
  /** Navigate; resolves when the load commits. */
  goto(url: string): Promise<void>
  /** Run a JS snippet in the page and return its JSON-serialisable result. */
  evaluate<T>(js: string): Promise<T>
  /**
   * Run `trigger` (which causes the portal to start a download) and resolve
   * with the path the file was saved to. The runtime forces the save location
   * and enforces the size cap; the adapter only knows "a file came back."
   */
  waitForDownload(trigger: () => Promise<void>): Promise<string>
}

/**
 * One portal, described declaratively. An adapter is pure navigation logic — it
 * never reads a credential field and never types a password (the user does, in
 * Mode A). `origins` is the navigation allow-list; the runtime blocks the window
 * from leaving it (defends against an open-redirect walking the session off the
 * pinned site).
 */
export interface PortalAdapter {
  id: string
  name: string
  /** The pinned URL the sandbox opens to — never user-supplied. */
  loginUrl: string
  /** Origins the window may navigate within. Anything else is blocked. */
  origins: string[]
  /**
   * `beta` until its selectors have been validated against the real portal with
   * a live account (surfaced in the UI so the user knows it may need a tweak).
   */
  status: 'beta' | 'stable'
  /** Has the user reached the authenticated area yet? Polled during assisted login. */
  isLoggedIn(page: AutomationPage): Promise<boolean>
  /** From the logged-in state, drive to the export and return the artifact. */
  fetch(page: AutomationPage): Promise<CredArtifact>
}

/** Result of a full portal pull, after the artifact has been ingested. */
export interface CredRunResult {
  ok: boolean
  /** True when the user dismissed the window before completing the pull. */
  cancelled?: boolean
  imported?: number
  duplicates?: number
  error?: string
}
