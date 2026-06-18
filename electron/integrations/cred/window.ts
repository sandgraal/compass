/**
 * CRED engine — the real sandboxed `BrowserWindow` (Phase 10.6a).
 * **Integration-only** (opens a live window), like Plaid's `runLinkFlow`. Kept
 * deliberately thin: all the testable orchestration is in `runtime.ts` behind
 * the `AutomationPage` seam. Unit tests inject a fake runner and never reach
 * this file.
 *
 * Isolation (design §6.2): cold in-memory session partition (wiped on close),
 * `sandbox: true`, no Compass preload, no popups, and a navigation allow-list
 * pinned to the adapter's origins (incl. its identity providers). We do NOT
 * rewrite the portal's own CSP — overriding a live third-party site's headers
 * would break it; isolation comes from the partition + sandbox + nav-pin.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { getAdapter } from './adapters'
import { isAllowedNavigation, runPortalPull, sanitizeDownloadName } from './runtime'
import type { AutomationPage, PortalAdapter } from './types'

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 // 50 MB — matches records' import guard

/** Open the sandboxed window for `adapter` and expose it as an `AutomationPage`. */
export function createAutomationWindow(
  adapter: PortalAdapter,
  opts: { tmpDir: string }
): { page: AutomationPage; close: () => void; isClosed: () => boolean } {
  const win = new BrowserWindow({
    width: 980,
    height: 820,
    title: `Compass — ${adapter.name}`,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // No `persist:` prefix → in-memory session, wiped when the window closes.
      partition: `cred:${adapter.id}`
    }
  })
  const wc = win.webContents

  // A portal can't pop a tab/window outside the sandbox.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Pin the session: cancel any navigation off the allow-listed origins.
  const guard = (event: Electron.Event, url: string): void => {
    if (!isAllowedNavigation(url, adapter.origins)) event.preventDefault()
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)

  const page: AutomationPage = {
    url: () => wc.getURL(),
    goto: (url) => wc.loadURL(url).then(() => undefined),
    evaluate: <T>(js: string) => wc.executeJavaScript(js, true) as Promise<T>,
    waitForDownload: (trigger) =>
      new Promise<string>((resolve, reject) => {
        const onWillDownload = (_e: Electron.Event, item: Electron.DownloadItem): void => {
          const savePath = join(opts.tmpDir, sanitizeDownloadName(item.getFilename()))
          item.setSavePath(savePath)
          item.on('updated', () => {
            if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel()
          })
          item.once('done', (_ev, state) => {
            wc.session.removeListener('will-download', onWillDownload)
            if (state === 'completed') resolve(savePath)
            else reject(new Error(`cred: download ${state}`))
          })
        }
        wc.session.on('will-download', onWillDownload)
        trigger().catch((err) => {
          wc.session.removeListener('will-download', onWillDownload)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
  }

  return {
    page,
    close: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    isClosed: () => win.isDestroyed()
  }
}

/**
 * Production runner used by `cred.ts`: open the window, drive the pull, return
 * the artifact path. `register` hands `cred.ts` a `close()` so an explicit
 * `cred:cancel` (or shutdown) can tear the window down. A user-closed window is
 * reported as a clean `cancelled`, never as an error.
 */
export async function runPull(
  portalId: string,
  register: (active: { close: () => void }) => void
): Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }> {
  const adapter = getAdapter(portalId)
  if (!adapter) return { ok: false, error: `Unknown portal: ${portalId}` }
  const tmpDir = mkdtempSync(join(tmpdir(), 'compass-cred-'))
  const handle = createAutomationWindow(adapter, { tmpDir })
  register({ close: handle.close })
  try {
    const { path } = await runPortalPull(adapter, handle.page)
    return { ok: true, path }
  } catch (err) {
    if (handle.isClosed()) return { ok: false, cancelled: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    handle.close()
  }
}
