/**
 * Tests for the autoUpdater event wiring + scheduling in
 * `electron/ipc/updater.ts` (Phase 0.7 function-coverage buffer).
 *
 * `updater.test.ts` covers the IPC handlers + the platform-gated autoDownload,
 * but it registers the `autoUpdater.on(...)` listeners without ever firing
 * them — so every event callback (and `scheduleUpdateChecks`, and `push`'s
 * window guards) showed as uncovered functions. This file invokes them:
 *
 *   - each autoUpdater event → the exact `updater:status` payload pushed to
 *     the renderer (checking / available / not-available / downloading /
 *     downloaded / error)
 *   - push() window guards → no window, destroyed window, always-on-top skip
 *   - scheduleUpdateChecks → the 3s initial check + 4h interval fire
 *     checkForUpdates, and a rejected check pushes a {phase:'error'}
 *
 * Self-contained mocks (electron + electron-updater); a fresh module per test
 * via vi.resetModules so the once-only listener-registration flag resets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type WinStub = {
  isAlwaysOnTop: () => boolean
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
}

const sendMock = vi.fn()
let windows: WinStub[] = []
function goodWindow(): WinStub {
  return {
    isAlwaysOnTop: () => false,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: sendMock }
  }
}

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => windows }
}))

const checkForUpdatesMock = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
const listeners = new Map<string, (arg: unknown) => void>()
const autoUpdaterMock = {
  logger: null as unknown,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: checkForUpdatesMock,
  quitAndInstall: vi.fn(),
  on: (event: string, listener: (arg: unknown) => void) => {
    listeners.set(event, listener)
  }
}
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))

async function freshInit() {
  vi.resetModules()
  listeners.clear()
  const mod = await import('./updater')
  mod.initAutoUpdater()
  return mod
}

function fire(event: string, arg?: unknown): void {
  const l = listeners.get(event)
  if (!l) throw new Error(`listener not registered: ${event}`)
  l(arg)
}

beforeEach(() => {
  windows = [goodWindow()]
  sendMock.mockReset()
  checkForUpdatesMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ── event → payload wiring ───────────────────────────────────────────────────

describe('autoUpdater event wiring', () => {
  it('checking-for-update → {phase:checking}', async () => {
    await freshInit()
    fire('checking-for-update')
    expect(sendMock).toHaveBeenCalledWith('updater:status', { phase: 'checking' })
  })

  it('update-available → {phase:available, version, releaseDate}', async () => {
    await freshInit()
    fire('update-available', { version: '2.0.0', releaseDate: '2026-06-06' })
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'available',
      version: '2.0.0',
      releaseDate: '2026-06-06'
    })
  })

  it('update-available with no releaseDate → empty string', async () => {
    await freshInit()
    fire('update-available', { version: '2.0.0' })
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'available',
      version: '2.0.0',
      releaseDate: ''
    })
  })

  it('update-not-available → {phase:not-available}', async () => {
    await freshInit()
    fire('update-not-available')
    expect(sendMock).toHaveBeenCalledWith('updater:status', { phase: 'not-available' })
  })

  it('download-progress → {phase:downloading, ...metrics}', async () => {
    await freshInit()
    fire('download-progress', { percent: 42.5, bytesPerSecond: 1000, total: 5000 })
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'downloading',
      percent: 42.5,
      bytesPerSecond: 1000,
      total: 5000
    })
  })

  it('update-downloaded → {phase:downloaded, version}', async () => {
    await freshInit()
    fire('update-downloaded', { version: '2.0.0' })
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'downloaded',
      version: '2.0.0'
    })
  })

  it('error (Error) → {phase:error, message}', async () => {
    await freshInit()
    fire('error', new Error('boom'))
    expect(sendMock).toHaveBeenCalledWith('updater:status', { phase: 'error', message: 'boom' })
  })

  it('error (non-Error) → stringified message', async () => {
    await freshInit()
    fire('error', 'plain string failure')
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'error',
      message: 'plain string failure'
    })
  })

  it('registers listeners only once across repeated initAutoUpdater calls', async () => {
    const mod = await freshInit()
    mod.initAutoUpdater() // second call — guarded by the module flag
    fire('checking-for-update')
    // Still one window, one send — no duplicate listener stacking.
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

// ── push() window guards ─────────────────────────────────────────────────────

describe('push window guards', () => {
  it('no-ops when there is no eligible window', async () => {
    await freshInit()
    windows = [] // no windows at all
    fire('checking-for-update')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('skips always-on-top windows (popover / OAuth) and finds none → no-op', async () => {
    await freshInit()
    windows = [{ ...goodWindow(), isAlwaysOnTop: () => true }]
    fire('checking-for-update')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('no-ops when the only window is destroyed', async () => {
    await freshInit()
    windows = [{ ...goodWindow(), isDestroyed: () => true }]
    fire('checking-for-update')
    expect(sendMock).not.toHaveBeenCalled()
  })
})

// ── scheduleUpdateChecks ─────────────────────────────────────────────────────

describe('scheduleUpdateChecks', () => {
  it('fires an initial check after 3s and a recurring check on the 4h interval', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const mod = await import('./updater')
    mod.scheduleUpdateChecks()

    expect(checkForUpdatesMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000) // initial timeout
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000) // one interval tick
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2)
  })

  it('pushes {phase:error} when a scheduled check rejects', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    checkForUpdatesMock.mockRejectedValue(new Error('network down'))
    const mod = await import('./updater')
    mod.scheduleUpdateChecks()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      phase: 'error',
      message: 'network down'
    })
  })
})
