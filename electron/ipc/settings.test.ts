/**
 * Tests for the `settings:*` IPC handlers (Phase 6.1 — P2).
 *
 * Scope is the settings surface specifically: get/set/get-all and the
 * quick-capture shortcut handler. The checklist:* handlers also live in
 * `electron/ipc/settings.ts` but they're domain-different (tasks, not
 * app config) and will land in a focused checklist test file.
 *
 * Two side effects worth pinning down:
 *
 *   - `settings:set` with key='syncInterval' calls `restartCronJobs()`.
 *     This is the bug fix from implementation plan §1.2 — without the
 *     restart, changing the interval in the UI didn't take effect until
 *     next launch.
 *   - `settings:set-quick-capture-shortcut` only persists AFTER the
 *     accelerator successfully registers via `restartQuickCaptureShortcut`.
 *     A bad accelerator (or platform mismatch, or registration conflict)
 *     must NOT touch the DB.
 *
 * Wipe / detect-ollama / open-data-dir / export-data are intentionally
 * out of scope — they tangle with rmSync, dialog, shell, or network and
 * deserve their own focused mocks.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── DB layer mock ────────────────────────────────────────────────────────────
// Settings is a key-value store. We capture inserts/updates so tests can
// assert what would have been written, and `selectRows` is per-test
// settable so we can simulate "value already present" vs "fall back to
// DEFAULTS" paths.

let selectRows: Array<{ key: string; value: string }> = []
const dbInsertSpy = vi.fn()

vi.mock('../db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => selectRows[0]
        }),
        all: () => selectRows
      })
    }),
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: (cfg: { set: unknown }) => ({
          run: () => dbInsertSpy({ row, set: cfg.set })
        })
      })
    })
  })
}))

// ── Electron mock ────────────────────────────────────────────────────────────
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9-test' },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() }
}))

// ── Side-effect spies ────────────────────────────────────────────────────────
const restartCronJobsMock = vi.fn()
vi.mock('../cron', () => ({
  restartCronJobs: restartCronJobsMock
}))

const restartQuickCaptureShortcutMock =
  vi.fn<(chord: string) => { success: true } | { success: false; reason: string }>()
vi.mock('../menu-bar', () => ({
  restartQuickCaptureShortcut: restartQuickCaptureShortcutMock
}))

// Ollama detection isn't exercised in this file but the module imports it
// at load time; stub it so the import resolves.
vi.mock('../knowledge/ollama', () => ({
  detectOllama: vi.fn()
}))

// rmSync/readdirSync are only used by wipe handlers which we don't test
// here; provide no-op stubs so the module imports cleanly.
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  writeFileSync: vi.fn()
}))

vi.mock('../paths', () => ({
  DATA_DIR: '/tmp/compass-settings-test/data',
  KNOWLEDGE_DIR: '/tmp/compass-settings-test/kb',
  VAULT_DIR: '/tmp/compass-settings-test/vault'
}))

// ── Fake IpcMain + invoke helper ─────────────────────────────────────────────
type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./settings')
  mod.registerSettingsHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  selectRows = []
  dbInsertSpy.mockClear()
  restartCronJobsMock.mockClear()
  restartQuickCaptureShortcutMock.mockClear().mockReturnValue({ success: true })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── settings:get ─────────────────────────────────────────────────────────────

describe('settings:get', () => {
  it('returns the stored value when one exists', async () => {
    selectRows = [{ key: 'theme', value: 'dark' }]
    const h = await registerAndGet('settings:get')
    expect(await invoke(h, 'theme')).toBe('dark')
  })

  it('falls back to the hard-coded DEFAULTS when no row exists', async () => {
    // theme default is 'system'
    const h = await registerAndGet('settings:get')
    expect(await invoke(h, 'theme')).toBe('system')
  })

  it('returns null for a key with no row and no default', async () => {
    const h = await registerAndGet('settings:get')
    expect(await invoke(h, 'unknownKey')).toBeNull()
  })
})

// ── settings:get-all ─────────────────────────────────────────────────────────

describe('settings:get-all', () => {
  it('overlays stored rows on top of DEFAULTS + injects appVersion', async () => {
    selectRows = [
      { key: 'theme', value: 'dark' },
      { key: 'customKey', value: 'custom-value' }
    ]
    const h = await registerAndGet('settings:get-all')
    const out = (await invoke(h)) as Record<string, string>

    expect(out.theme).toBe('dark') // override
    expect(out.customKey).toBe('custom-value') // extra
    expect(out.syncInterval).toBe('15') // DEFAULT preserved
    expect(out.notificationsEnabled).toBe('true') // DEFAULT preserved
    expect(out.appVersion).toBe('9.9.9-test') // injected by handler
  })
})

// ── settings:set ─────────────────────────────────────────────────────────────

describe('settings:set', () => {
  it('persists the value (upsert) and returns { success: true }', async () => {
    const h = await registerAndGet('settings:set')
    const out = (await invoke(h, 'theme', 'dark')) as { success: boolean }
    expect(out).toEqual({ success: true })
    expect(dbInsertSpy).toHaveBeenCalledOnce()
    const call = dbInsertSpy.mock.calls[0][0] as {
      row: { key: string; value: string }
    }
    expect(call.row.key).toBe('theme')
    expect(call.row.value).toBe('dark')
  })

  it('stringifies the value so non-string inputs (numbers, booleans) round-trip', async () => {
    const h = await registerAndGet('settings:set')
    await invoke(h, 'syncInterval', 30)
    const call = dbInsertSpy.mock.calls[0][0] as { row: { value: string } }
    expect(call.row.value).toBe('30') // String(30), not the number 30
  })

  it('does NOT restart cron for a regular settings change', async () => {
    const h = await registerAndGet('settings:set')
    await invoke(h, 'theme', 'dark')
    expect(restartCronJobsMock).not.toHaveBeenCalled()
  })

  it('restarts cron when key === "syncInterval" (Phase 1.2 fix)', async () => {
    // The bug this guards: changing the sync interval in the UI was
    // silently waiting until next launch. The fix wires restartCronJobs()
    // into the set handler when this specific key changes. Lock the
    // behavior so a refactor cannot quietly drop it again.
    const h = await registerAndGet('settings:set')
    await invoke(h, 'syncInterval', '30')
    expect(restartCronJobsMock).toHaveBeenCalledOnce()
  })
})

// ── settings:set-quick-capture-shortcut ──────────────────────────────────────

describe('settings:set-quick-capture-shortcut', () => {
  it('rejects an empty / non-string accelerator', async () => {
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, '')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/not a valid accelerator/i)
    expect(restartQuickCaptureShortcutMock).not.toHaveBeenCalled()
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a string with no modifier prefix (e.g. just "Space")', async () => {
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'Space')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
  })

  it('rejects a string ending in a modifier (e.g. "Shift+Cmd")', async () => {
    // Accelerator validators are easy to write wrong — make sure the
    // last segment is treated as a key, not a modifier.
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'Shift+Cmd')) as { success: boolean }
    expect(out.success).toBe(false)
  })

  it('rejects a string with an unknown modifier (e.g. "Hyper+Space")', async () => {
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'Hyper+Space')) as { success: boolean }
    expect(out.success).toBe(false)
  })

  it('accepts CommandOrControl+Shift+T and persists after successful registration', async () => {
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'CommandOrControl+Shift+T')) as { success: boolean }
    expect(out.success).toBe(true)
    expect(restartQuickCaptureShortcutMock).toHaveBeenCalledWith('CommandOrControl+Shift+T')
    expect(dbInsertSpy).toHaveBeenCalledOnce()
    const call = dbInsertSpy.mock.calls[0][0] as { row: { key: string; value: string } }
    expect(call.row.key).toBe('quickCaptureShortcut')
    expect(call.row.value).toBe('CommandOrControl+Shift+T')
  })

  it('does NOT persist to DB if the OS rejected the registration', async () => {
    // Critical: shortcut registration can fail (conflict with another
    // app, accessibility permission missing, etc.). When that happens
    // we must NOT save the invalid shortcut — otherwise next launch
    // would try to re-register the same broken value.
    restartQuickCaptureShortcutMock.mockReturnValueOnce({
      success: false,
      reason: 'register_failed'
    })
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'CommandOrControl+Shift+T')) as {
      success: boolean
      error?: string
    }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/in use by another app/i)
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('surfaces unsupported_platform with a specific error message', async () => {
    restartQuickCaptureShortcutMock.mockReturnValueOnce({
      success: false,
      reason: 'unsupported_platform'
    })
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'CommandOrControl+Shift+T')) as {
      success: boolean
      error?: string
    }
    expect(out.error).toMatch(/macOS only/i)
  })

  it('surfaces tray_unavailable with a specific error message', async () => {
    restartQuickCaptureShortcutMock.mockReturnValueOnce({
      success: false,
      reason: 'tray_unavailable'
    })
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, 'CommandOrControl+Shift+T')) as {
      success: boolean
      error?: string
    }
    expect(out.error).toMatch(/not initialized yet/i)
  })

  it('trims surrounding whitespace before validating', async () => {
    const h = await registerAndGet('settings:set-quick-capture-shortcut')
    const out = (await invoke(h, '  CommandOrControl+Shift+T  ')) as { success: boolean }
    expect(out.success).toBe(true)
    expect(restartQuickCaptureShortcutMock).toHaveBeenCalledWith('CommandOrControl+Shift+T')
  })
})
