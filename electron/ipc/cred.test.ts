import type { IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { type CredDeps, registerCredHandlers } from './cred'

// The default deps reach the integration-only window module (opens a real
// BrowserWindow) and the records ingest — mock both so this gate test stays
// hermetic. Every test injects its own deps anyway.
vi.mock('../integrations/cred/window', () => ({ runPull: vi.fn() }))
vi.mock('./records', () => ({ ingestFiles: vi.fn() }))

type Handler = (event: unknown, ...args: unknown[]) => unknown
type Outcome = { ok: boolean; cancelled?: boolean; path?: string; error?: string }

function harness(deps: CredDeps) {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (ch: string, fn: Handler) => {
      handlers.set(ch, fn)
    }
  } as unknown as IpcMain
  registerCredHandlers(ipcMain, deps)
  const invoke = (ch: string, ...args: unknown[]): unknown => {
    const fn = handlers.get(ch)
    if (!fn) throw new Error(`no handler for ${ch}`)
    return fn({}, ...args)
  }
  return {
    list: () => invoke('cred:list'),
    run: (id: unknown) => invoke('cred:run', id),
    cancel: () => invoke('cred:cancel')
  }
}

const okDeps = (over: Partial<CredDeps> = {}): CredDeps => ({
  runPull: vi.fn(async (_id, register) => {
    register({ close: vi.fn() })
    return { ok: true, path: '/tmp/a.pdf' }
  }),
  ingest: vi.fn(async () => ({ imported: 2, duplicates: 1 })),
  ...over
})

describe('cred IPC', () => {
  it('cred:list returns safe adapter metadata (no secrets)', () => {
    const list = harness(okDeps()).list() as { id: string; name: string; status: string }[]
    expect(list.some((a) => a.id === 'ssa' && a.status === 'beta')).toBe(true)
    expect(JSON.stringify(list)).not.toMatch(/password|secret|token/i)
  })

  it('rejects an unknown portal without invoking the runner', async () => {
    const deps = okDeps()
    const res = await harness(deps).run('nope')
    expect(res).toEqual({ ok: false, error: 'Unknown portal' })
    expect(deps.runPull).not.toHaveBeenCalled()
  })

  it('rejects a non-string portal id', async () => {
    const res = await harness(okDeps()).run(42)
    expect(res).toEqual({ ok: false, error: 'Unknown portal' })
  })

  it('runs a known portal then ingests the artifact', async () => {
    const deps = okDeps()
    const res = await harness(deps).run('ssa')
    expect(deps.runPull).toHaveBeenCalledWith('ssa', expect.any(Function))
    expect(deps.ingest).toHaveBeenCalledWith(['/tmp/a.pdf'])
    expect(res).toEqual({ ok: true, imported: 2, duplicates: 1 })
  })

  it('surfaces a cancelled pull as cancelled (and does not ingest)', async () => {
    const deps = okDeps({
      runPull: vi.fn(async (_id, register) => {
        register({ close: vi.fn() })
        return { ok: false, cancelled: true }
      })
    })
    const res = await harness(deps).run('ssa')
    expect(res).toEqual({ ok: false, cancelled: true, error: undefined })
    expect(deps.ingest).not.toHaveBeenCalled()
  })

  it('blocks a second concurrent pull while one is in flight', async () => {
    let release: (v: Outcome) => void = () => {}
    const deps = okDeps({
      runPull: vi.fn((_id, register) => {
        register({ close: vi.fn() })
        return new Promise<Outcome>((r) => {
          release = r
        })
      })
    })
    const h = harness(deps)
    const first = h.run('ssa')
    const busy = await h.run('ssa')
    expect(busy).toEqual({ ok: false, error: 'A data pull is already in progress' })
    release({ ok: true, path: '/tmp/a.pdf' })
    await first
  })

  it('cred:cancel tears down the in-flight window', async () => {
    const close = vi.fn()
    let release: (v: Outcome) => void = () => {}
    const deps = okDeps({
      runPull: vi.fn((_id, register) => {
        register({ close })
        return new Promise<Outcome>((r) => {
          release = r
        })
      })
    })
    const h = harness(deps)
    const run = h.run('ssa')
    expect(await h.cancel()).toEqual({ ok: true })
    expect(close).toHaveBeenCalled()
    release({ ok: false, cancelled: true })
    await run
  })
})
