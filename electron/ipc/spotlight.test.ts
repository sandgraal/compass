/**
 * Tests for the spotlight:* IPC handlers (Phase 6.1 — P2).
 *
 * The actual mirror/reconcile logic lives in
 * `electron/integrations/spotlight-mirror.ts` and has its own focused
 * coverage. These tests pin down the IPC handler contracts:
 *
 *   - Path allowlist enforcement (must be under ~/Documents or ~/Desktop)
 *     wins over a successful DB write — we don't persist a value that
 *     would later refuse to mirror.
 *   - Toggle-on triggers a backfill BEFORE starting the watcher (so the
 *     user sees a fully populated mirror immediately).
 *   - Toggle-off keeps existing mirrored files (the user may still want
 *     to read them in Finder / Spotlight).
 *   - Type validation rejects non-boolean enabled, non-string path.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── DB layer mock ────────────────────────────────────────────────────────────
// Simple key-value store backed by a Map. Mirrors the appSettings table
// shape (the only table this module reads/writes). The handler reads
// individual rows by `eq(appSettings.key, '<key>')`; drizzle's builder
// chain is opaque, so we use a `lastEqKey` side-channel populated by a
// thin wrapper around `eq` to give the mocked `get()` something to key
// off of.

const settings = new Map<string, string>()
const dbInsertSpy = vi.fn()
const lastEqKey: { value: string | null } = { value: null }

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      if (typeof val === 'string') lastEqKey.value = val
      return (actual.eq as (a: unknown, b: unknown) => unknown)(col, val)
    }
  }
})

vi.mock('../db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => {
            const key = lastEqKey.value
            if (!key) return undefined
            const value = settings.get(key)
            lastEqKey.value = null
            return value === undefined ? undefined : { key, value }
          }
        })
      })
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            settings.set(row.key, row.value)
            dbInsertSpy(row)
          }
        })
      })
    })
  })
}))

// ── spotlight-mirror module mock ─────────────────────────────────────────────

const defaultMirrorPathMock = vi.fn(() => '/home/u/Documents/Compass Notes')
const isAllowedMirrorPathMock = vi.fn<(p: string) => boolean>(() => true)
const normalizedMirrorPathMock = vi.fn<(p: string) => string | null>((p) => p)
const reconcileMirrorMock = vi.fn(() => ({ added: 3, removed: 0, skipped: 0 }))
const applyMirrorChangeMock = vi.fn()

vi.mock('../integrations/spotlight-mirror', () => ({
  applyMirrorChange: applyMirrorChangeMock,
  defaultMirrorPath: defaultMirrorPathMock,
  isAllowedMirrorPath: isAllowedMirrorPathMock,
  normalizedMirrorPath: normalizedMirrorPathMock,
  reconcileMirror: reconcileMirrorMock
}))

// ── chokidar + fs + paths ────────────────────────────────────────────────────

const chokidarCloseMock = vi.fn().mockResolvedValue(undefined)
const chokidarOnMock = vi.fn().mockReturnThis()
const chokidarWatchMock = vi.fn(() => ({
  on: chokidarOnMock,
  close: chokidarCloseMock
}))
vi.mock('chokidar', () => ({
  default: { watch: chokidarWatchMock }
}))

const existsSyncMock = vi.fn<(p: string) => boolean>(() => true)
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

vi.mock('../paths', () => ({ KNOWLEDGE_DIR: '/tmp/compass-spotlight-test/kb' }))

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
  const mod = await import('./spotlight')
  mod._testHooks.resetForTests()
  mod.registerSpotlightHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  settings.clear()
  lastEqKey.value = null
  dbInsertSpy.mockClear()
  defaultMirrorPathMock.mockClear()
  isAllowedMirrorPathMock.mockReset().mockReturnValue(true)
  normalizedMirrorPathMock.mockReset().mockImplementation((p: string) => p)
  reconcileMirrorMock.mockReset().mockReturnValue({ added: 3, removed: 0, skipped: 0 })
  applyMirrorChangeMock.mockClear()
  chokidarWatchMock.mockClear()
  chokidarCloseMock.mockClear().mockResolvedValue(undefined)
  chokidarOnMock.mockClear().mockReturnThis()
  existsSyncMock.mockReset().mockReturnValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── spotlight:get-status ─────────────────────────────────────────────────────

describe('spotlight:get-status', () => {
  it('reports defaults when no settings are stored', async () => {
    const h = await registerAndGet('spotlight:get-status')
    const out = (await invoke(h)) as {
      enabled: boolean
      path: string
      defaultPath: string
      pathAllowed: boolean
      mirrorExists: boolean
    }
    expect(out.enabled).toBe(false)
    expect(out.path).toBe('/home/u/Documents/Compass Notes')
    expect(out.defaultPath).toBe('/home/u/Documents/Compass Notes')
    expect(out.pathAllowed).toBe(true)
    expect(out.mirrorExists).toBe(true)
  })

  it('reflects stored enabled + path values', async () => {
    settings.set('spotlightMirrorEnabled', 'true')
    settings.set('spotlightMirrorPath', '/home/u/Desktop/MyNotes')
    const h = await registerAndGet('spotlight:get-status')
    const out = (await invoke(h)) as { enabled: boolean; path: string }
    expect(out.enabled).toBe(true)
    expect(out.path).toBe('/home/u/Desktop/MyNotes')
  })

  it('uses the RESOLVED path for the mirrorExists check (handles ~/...)', async () => {
    // Stored value might be `~/Desktop/MyNotes`; normalizedMirrorPath
    // resolves the `~`. existsSync must run on the resolved path or
    // the UI would show "missing" for a perfectly valid mirror.
    settings.set('spotlightMirrorPath', '~/Desktop/MyNotes')
    normalizedMirrorPathMock.mockReturnValueOnce('/home/u/Desktop/MyNotes')
    existsSyncMock.mockReturnValueOnce(true)
    const h = await registerAndGet('spotlight:get-status')
    const out = (await invoke(h)) as { mirrorExists: boolean }
    expect(out.mirrorExists).toBe(true)
    expect(existsSyncMock).toHaveBeenCalledWith('/home/u/Desktop/MyNotes')
  })

  it('returns mirrorExists=false when normalizedMirrorPath returns null', async () => {
    normalizedMirrorPathMock.mockReturnValueOnce(null)
    const h = await registerAndGet('spotlight:get-status')
    const out = (await invoke(h)) as { mirrorExists: boolean }
    expect(out.mirrorExists).toBe(false)
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})

// ── spotlight:set-enabled ────────────────────────────────────────────────────

describe('spotlight:set-enabled', () => {
  it('rejects a non-boolean argument', async () => {
    const h = await registerAndGet('spotlight:set-enabled')
    const out = (await invoke(h, 'yes')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/must be a boolean/i)
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('persists enabled=true, runs backfill, then starts the watcher (in that order)', async () => {
    // Order matters: the user should never see a watcher firing
    // against an empty mirror dir. Backfill must complete BEFORE the
    // watcher starts emitting events. `mock.invocationCallOrder`
    // gives us a monotonically-increasing number across all vitest
    // mocks; comparing the two locks the order.
    const h = await registerAndGet('spotlight:set-enabled')
    const out = (await invoke(h, true)) as {
      success: boolean
      result?: { added: number }
    }
    expect(out.success).toBe(true)
    expect(out.result?.added).toBe(3)
    expect(settings.get('spotlightMirrorEnabled')).toBe('true')
    expect(reconcileMirrorMock).toHaveBeenCalledOnce()
    expect(chokidarWatchMock).toHaveBeenCalledOnce()

    const backfillOrder = reconcileMirrorMock.mock.invocationCallOrder[0]
    const watcherOrder = chokidarWatchMock.mock.invocationCallOrder[0]
    expect(backfillOrder).toBeLessThan(watcherOrder)
  })

  it('refuses to enable when the stored path is outside ~/Documents or ~/Desktop (no half-enabled state)', async () => {
    // Regression for a real bug found via Copilot review: the handler
    // used to INSERT `spotlightMirrorEnabled=true` BEFORE validating
    // the stored path, then return an error. Next launch read the
    // stored value, tried to start the watcher against the disallowed
    // path, and ended up in a stuck `lastError` state. The fix
    // validates first; this test locks in that no DB mutation
    // happens on the rejected path.
    settings.set('spotlightMirrorPath', '/tmp/escape/notes')
    isAllowedMirrorPathMock.mockReturnValue(false)
    const h = await registerAndGet('spotlight:set-enabled')
    const out = (await invoke(h, true)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/~\/Documents or ~\/Desktop/)
    // No backfill, no watcher start
    expect(reconcileMirrorMock).not.toHaveBeenCalled()
    expect(chokidarWatchMock).not.toHaveBeenCalled()
    // CRITICAL: the DB was NOT mutated. The toggle is a true no-op.
    expect(dbInsertSpy).not.toHaveBeenCalled()
    expect(settings.has('spotlightMirrorEnabled')).toBe(false)
  })

  it('disabling does NOT delete mirrored files (only stops syncing)', async () => {
    // Establish enabled-then-disabled sequence to verify the "preserve
    // existing files" invariant. The handler doesn't call any rm or
    // unlink — we assert that absence.
    const h = await registerAndGet('spotlight:set-enabled')
    await invoke(h, true) // first enable
    chokidarWatchMock.mockClear()
    chokidarCloseMock.mockClear()
    const out = (await invoke(h, false)) as { success: boolean }
    expect(out.success).toBe(true)
    expect(settings.get('spotlightMirrorEnabled')).toBe('false')
    // Restart was called (to tear down the watcher). It SHOULD have closed
    // the prior watcher.
    expect(chokidarCloseMock).toHaveBeenCalled()
    // But a new watcher was NOT started for the disabled state.
    expect(chokidarWatchMock).not.toHaveBeenCalled()
  })
})

// ── spotlight:set-path ───────────────────────────────────────────────────────

describe('spotlight:set-path', () => {
  it('rejects a non-string or empty path', async () => {
    const h = await registerAndGet('spotlight:set-path')
    const empty = (await invoke(h, '')) as { success: boolean }
    const nonString = (await invoke(h, 42)) as { success: boolean }
    expect(empty.success).toBe(false)
    expect(nonString.success).toBe(false)
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a disallowed path (outside ~/Documents or ~/Desktop)', async () => {
    isAllowedMirrorPathMock.mockReturnValue(false)
    const h = await registerAndGet('spotlight:set-path')
    const out = (await invoke(h, '/tmp/escape/notes')) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/~\/Documents or ~\/Desktop/)
    expect(dbInsertSpy).not.toHaveBeenCalled()
  })

  it('persists the new path and skips backfill when disabled', async () => {
    const h = await registerAndGet('spotlight:set-path')
    const out = (await invoke(h, '/home/u/Desktop/MyNotes')) as {
      success: boolean
      result?: unknown
    }
    expect(out.success).toBe(true)
    expect(out.result).toBeUndefined() // no backfill ran
    expect(settings.get('spotlightMirrorPath')).toBe('/home/u/Desktop/MyNotes')
    expect(reconcileMirrorMock).not.toHaveBeenCalled()
  })

  it('runs backfill + restarts watcher when enabled', async () => {
    settings.set('spotlightMirrorEnabled', 'true')
    const h = await registerAndGet('spotlight:set-path')
    const out = (await invoke(h, '/home/u/Desktop/MyNotes')) as {
      success: boolean
      result?: { added: number }
    }
    expect(out.success).toBe(true)
    expect(out.result?.added).toBe(3)
    expect(reconcileMirrorMock).toHaveBeenCalledOnce()
    expect(chokidarWatchMock).toHaveBeenCalledOnce()
  })
})

// ── spotlight:backfill-now ───────────────────────────────────────────────────

describe('spotlight:backfill-now', () => {
  it('runs reconcileMirror and returns its result', async () => {
    const h = await registerAndGet('spotlight:backfill-now')
    const out = (await invoke(h)) as { success: boolean; result?: { added: number } }
    expect(out.success).toBe(true)
    expect(out.result?.added).toBe(3)
    expect(reconcileMirrorMock).toHaveBeenCalledOnce()
  })

  it('refuses when the stored path is not allowed', async () => {
    isAllowedMirrorPathMock.mockReturnValue(false)
    const h = await registerAndGet('spotlight:backfill-now')
    const out = (await invoke(h)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/~\/Documents or ~\/Desktop/)
    expect(reconcileMirrorMock).not.toHaveBeenCalled()
  })

  it('surfaces reconcileMirror errors as { success: false }', async () => {
    reconcileMirrorMock.mockImplementationOnce(() => {
      throw new Error('mirror dir is read-only')
    })
    const h = await registerAndGet('spotlight:backfill-now')
    const out = (await invoke(h)) as { success: boolean; error?: string }
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/read-only/)
  })
})
