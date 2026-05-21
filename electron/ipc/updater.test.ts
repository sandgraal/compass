/**
 * Tests for the updater:* IPC handlers (Phase 6.1 — P3).
 *
 * Coverage focuses on the parts with non-trivial logic:
 *
 *   - `updater:open-release-page` — the tag regex validator. Bounded
 *     pre-release segment (ReDoS defense from PR #88, commit 124cc2c).
 *     URL is built from the normalized tag. Failed openExternal must
 *     propagate so the renderer's catch can toast.
 *   - `updater:check` — error handling around `autoUpdater.checkForUpdates`.
 *   - `updater:get-version` / `updater:install-and-restart` — thin shims
 *     but worth a smoke test.
 *   - `initAutoUpdater` — the platform-gated `autoDownload` (the bug from
 *     PR #88 where unsigned macOS builds caused an infinite download loop).
 *
 * `scheduleUpdateChecks` uses setTimeout + setInterval against the real
 * clock and is exercised indirectly by production launch; we don't fake-
 * timer it here. Its handler is exported but is "do it forever in the
 * background" — not a great unit-test target.
 */

import type { IpcMain } from 'electron'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the host's `process.platform` descriptor before any test mutates
// it. The `initAutoUpdater` cases below redefine the property to exercise
// the darwin / win32 / linux branches; without this restore in afterAll,
// the mutation would leak into other test files running in the same
// Vitest worker — most painfully for devs on macOS, where a stuck
// `platform === 'linux'` would silently break tests for Squirrel-gated
// behavior elsewhere.
const ORIGINAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')

afterAll(() => {
  if (ORIGINAL_PLATFORM_DESC) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESC)
  }
})

// ── Mock electron + electron-updater ─────────────────────────────────────────

const openExternalMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
const sendMock = vi.fn()
const getAllWindowsMock = vi.fn<() => unknown[]>(() => [
  // Default: one normal main window, not destroyed, not always-on-top.
  {
    isAlwaysOnTop: () => false,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: sendMock
    }
  }
])

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  shell: { openExternal: openExternalMock },
  BrowserWindow: { getAllWindows: getAllWindowsMock }
}))

const checkForUpdatesMock = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
const quitAndInstallMock = vi.fn<(isSilent?: boolean, forceRunAfter?: boolean) => void>()
const autoUpdaterListeners = new Map<string, (info: unknown) => void>()
const autoUpdaterOnMock = vi.fn<(event: string, listener: (info: unknown) => void) => void>(
  (event, listener) => {
    autoUpdaterListeners.set(event, listener)
  }
)

// The autoUpdater is a singleton object — we keep its in-test fields here so
// initAutoUpdater can mutate them and the test can assert against the result.
const autoUpdaterMock = {
  logger: { info: () => undefined },
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: checkForUpdatesMock,
  quitAndInstall: quitAndInstallMock,
  on: autoUpdaterOnMock
}

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

// ── Fake IpcMain + invoke helper ─────────────────────────────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const sendOnlyHandlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    sendOnlyHandlers[channel] = h
  }) as IpcMain['on']
}

function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./updater')
  mod.registerUpdaterHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel] ?? sendOnlyHandlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(sendOnlyHandlers)) delete sendOnlyHandlers[k]
  autoUpdaterListeners.clear()
  // Reset autoUpdater fields to "defaults that would fire the bug" so we
  // can assert initAutoUpdater corrects them.
  autoUpdaterMock.autoDownload = true
  autoUpdaterMock.autoInstallOnAppQuit = true
  checkForUpdatesMock.mockReset().mockResolvedValue(undefined)
  quitAndInstallMock.mockReset()
  openExternalMock.mockReset().mockResolvedValue(undefined)
  sendMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── updater:get-version ──────────────────────────────────────────────────────

describe('updater:get-version', () => {
  it('returns app.getVersion()', async () => {
    const h = await registerAndGet('updater:get-version')
    expect(await invoke(h)).toBe('1.2.3-test')
  })
})

// ── updater:check ────────────────────────────────────────────────────────────

describe('updater:check', () => {
  it('returns { success: true } when the underlying check resolves', async () => {
    const h = await registerAndGet('updater:check')
    expect(await invoke(h)).toEqual({ success: true })
    expect(checkForUpdatesMock).toHaveBeenCalledOnce()
  })

  it('returns { success: false, error } when the underlying check throws', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('GitHub 404'))
    const h = await registerAndGet('updater:check')
    const out = (await invoke(h)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/GitHub 404/)
  })
})

// ── updater:open-release-page ────────────────────────────────────────────────

describe('updater:open-release-page', () => {
  it('accepts a plain semver tag and opens the canonical release URL', async () => {
    const h = await registerAndGet('updater:open-release-page')
    await invoke(h, '0.4.1')
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/sandgraal/compass/releases/tag/v0.4.1'
    )
  })

  it('accepts a tag that already starts with `v` (no double-v)', async () => {
    const h = await registerAndGet('updater:open-release-page')
    await invoke(h, 'v0.4.1')
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/sandgraal/compass/releases/tag/v0.4.1'
    )
  })

  it('accepts a tag with a short pre-release suffix', async () => {
    const h = await registerAndGet('updater:open-release-page')
    await invoke(h, '0.5.0-rc.1')
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/sandgraal/compass/releases/tag/v0.5.0-rc.1'
    )
  })

  it('rejects a non-string tag', async () => {
    const h = await registerAndGet('updater:open-release-page')
    await expect(invoke(h, 42)).rejects.toThrow(/Invalid release tag/)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed tag', async () => {
    const h = await registerAndGet('updater:open-release-page')
    await expect(invoke(h, 'main')).rejects.toThrow(/Invalid release tag/)
    await expect(invoke(h, '0.4')).rejects.toThrow(/Invalid release tag/)
    await expect(invoke(h, 'release/0.4.1')).rejects.toThrow(/Invalid release tag/)
  })

  it('rejects a pre-release segment longer than 20 chars (ReDoS defense)', async () => {
    // The regex caps the pre-release segment at {1,20}. Anything longer is
    // a sign of pathological input — reject before shell.openExternal can
    // be aimed at a weird URL. (Hardening from PR #88 commit 124cc2c.)
    const longPre = 'a'.repeat(25)
    const h = await registerAndGet('updater:open-release-page')
    await expect(invoke(h, `0.5.0-${longPre}`)).rejects.toThrow(/Invalid release tag/)
  })

  it('propagates shell.openExternal rejection to the caller', async () => {
    // The renderer wraps this call in a .catch that toasts the failure.
    // Without the await on shell.openExternal, the renderer would silently
    // succeed even when the OS rejected the open (no browser, sandboxed,
    // etc.) — see PR #88 review.
    openExternalMock.mockRejectedValueOnce(new Error('no default browser'))
    const h = await registerAndGet('updater:open-release-page')
    await expect(invoke(h, '0.4.1')).rejects.toThrow(/no default browser/)
  })
})

// ── updater:install-and-restart ──────────────────────────────────────────────

describe('updater:install-and-restart', () => {
  it('calls autoUpdater.quitAndInstall(false, true)', async () => {
    // Args: (isSilent=false → show install UI; forceRunAfter=true → relaunch
    // after install). These specific values matter — autoUpdater.quitAndInstall()
    // with defaults would NOT relaunch the app, leaving the user with a dead
    // window after the update.
    const h = await registerAndGet('updater:install-and-restart')
    await invoke(h)
    expect(quitAndInstallMock).toHaveBeenCalledWith(false, true)
  })
})

// ── initAutoUpdater — platform-gated autoDownload (PR #88) ───────────────────

describe('initAutoUpdater', () => {
  it('disables autoDownload on macOS (unsigned-build refusal workaround)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const mod = await import('./updater')
    mod.initAutoUpdater()
    expect(autoUpdaterMock.autoDownload).toBe(false)
    // autoInstallOnAppQuit is always false (we manage install timing
    // through the explicit "Restart to Install" button on non-mac).
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('keeps autoDownload enabled on Windows + Linux (signed/working builds)', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      // Re-import isn't enough — module is cached. Reset the field and
      // re-call initAutoUpdater; the function reads process.platform fresh.
      autoUpdaterMock.autoDownload = false
      const mod = await import('./updater')
      mod.initAutoUpdater()
      expect(autoUpdaterMock.autoDownload).toBe(true)
    }
  })
})
