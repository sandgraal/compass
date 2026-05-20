/**
 * Tests for the Plaid IPC layer. The BrowserWindow path (`runLinkFlow`)
 * is exercised via integration in real Electron, not here — these
 * unit tests focus on the parts that have non-trivial logic:
 *
 *  - `handleCallback`: URL parsing for the compass-plaid:// scheme
 *  - the IPC handler input validation (set-secret / disconnect)
 *
 * The link helpers + vault are mocked so we can assert routing without
 * any Plaid HTTP traffic.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exchangePublicTokenMock = vi.fn()
const setAccessTokenMock = vi.fn()
const removeAccessTokenMock = vi.fn()
const setPlaidSecretMock = vi.fn()
const getPlaidSecretMock = vi.fn<(env: string) => string | null>(() => null)
const listItemIdsMock = vi.fn<() => string[]>(() => [])
const isPlaidConfiguredMock = vi.fn<
  () => { configured: boolean; env: 'sandbox' | 'production' | null }
>(() => ({
  configured: false,
  env: null
}))
const createLinkTokenMock = vi.fn()
const buildLinkHtmlMock = vi.fn((t: string) => `<html data-token="${t}"></html>`)

vi.mock('../integrations/plaid/link', () => ({
  buildLinkHtml: buildLinkHtmlMock,
  createLinkToken: createLinkTokenMock,
  exchangePublicToken: exchangePublicTokenMock
}))

vi.mock('../integrations/plaid/vault', () => ({
  setAccessToken: setAccessTokenMock,
  removeAccessToken: removeAccessTokenMock,
  setPlaidSecret: setPlaidSecretMock,
  getPlaidSecret: getPlaidSecretMock,
  listItemIds: listItemIdsMock
}))

// Lightweight DB mock — the new `plaid:list-items` handler reads
// `plaid_items` rows, and `plaid:disconnect` deletes from `plaid_items`
// after removing the vault entry. We capture the operations rather
// than spin up a real in-memory SQLite — these are routing/contract
// tests, not query tests.
const dbDeleteSpy = vi.fn()
type FakeRow = {
  id: number
  itemId: string
  institutionId: string
  institutionName: string
  lastSyncedAt: Date | null
  errorCode: string | null
}
let plaidItemsRows: FakeRow[] = []
vi.mock('../db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        all: () => plaidItemsRows
      })
    }),
    delete: () => ({
      where: () => ({
        run: () => dbDeleteSpy()
      })
    })
  })
}))

vi.mock('../integrations/plaid/client', async () => {
  // PlaidNotConfiguredError is a real class we need to instantiate in
  // some tests; everything else routes through the mocks.
  const real = await vi.importActual<typeof import('../integrations/plaid/client')>(
    '../integrations/plaid/client'
  )
  return {
    PlaidNotConfiguredError: real.PlaidNotConfiguredError,
    isPlaidConfigured: isPlaidConfiguredMock,
    getPlaidClient: () => {
      throw new Error('getPlaidClient should not be called from IPC tests')
    }
  }
})

const { handleCallback, registerPlaidHandlers } = await import('./plaid')

beforeEach(() => {
  exchangePublicTokenMock.mockReset()
  setAccessTokenMock.mockReset()
  removeAccessTokenMock.mockReset()
  setPlaidSecretMock.mockReset()
  getPlaidSecretMock.mockReset().mockReturnValue(null)
  listItemIdsMock.mockReset().mockReturnValue([])
  isPlaidConfiguredMock.mockReset().mockReturnValue({ configured: false, env: null })
  createLinkTokenMock.mockReset()
  dbDeleteSpy.mockReset()
  plaidItemsRows = []
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─── handleCallback ──────────────────────────────────────────────────────────

describe('handleCallback', () => {
  it('exchanges the public token on a success URL', async () => {
    exchangePublicTokenMock.mockResolvedValueOnce({
      itemId: 'item-1',
      institutionId: 'ins_1',
      institutionName: 'Test Bank',
      accounts: []
    })

    const result = await handleCallback(
      'compass-plaid://success?public_token=pub-123&institution_id=ins_1&institution_name=Test%20Bank'
    )

    expect(exchangePublicTokenMock).toHaveBeenCalledWith('pub-123')
    expect(result).toEqual({
      ok: true,
      result: {
        itemId: 'item-1',
        institutionId: 'ins_1',
        institutionName: 'Test Bank',
        accounts: []
      }
    })
  })

  it('returns a structured error when success URL omits the public_token', async () => {
    const result = await handleCallback('compass-plaid://success')
    expect(result).toEqual({
      ok: false,
      cancelled: false,
      errorCode: 'MISSING_PUBLIC_TOKEN',
      errorMessage: 'Plaid Link returned success without a public_token'
    })
    expect(exchangePublicTokenMock).not.toHaveBeenCalled()
  })

  it('parses exit URL into { cancelled: false, errorCode, errorMessage }', async () => {
    const result = await handleCallback(
      'compass-plaid://exit?error_code=USER_EXITED&error_message=User%20backed%20out'
    )
    expect(result).toEqual({
      ok: false,
      cancelled: false,
      errorCode: 'USER_EXITED',
      errorMessage: 'User backed out'
    })
  })

  it('handles exit URL with no params (Plaid Link sometimes omits them on early cancel)', async () => {
    const result = await handleCallback('compass-plaid://exit')
    expect(result).toEqual({
      ok: false,
      cancelled: false,
      errorCode: null,
      errorMessage: null
    })
  })

  it('returns UNKNOWN_CALLBACK for an unrecognized host', async () => {
    const result = await handleCallback('compass-plaid://wat?x=1')
    expect(result.ok).toBe(false)
    if (!result.ok && !result.cancelled) {
      expect(result.errorCode).toBe('UNKNOWN_CALLBACK')
      expect(result.errorMessage).toMatch(/wat/)
    }
  })
})

// ─── IPC handlers ────────────────────────────────────────────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

/**
 * Wraps a sync-throwing handler so `await invoke(...)` always rejects
 * the same way ipcMain.handle does over the wire, regardless of
 * whether the original handler returned a value, rejected a Promise,
 * or threw synchronously.
 */
function invoke(fn: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => fn(null, ...args))
}

function makeFakeIpc(): { ipc: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ipc = {
    handle(channel: string, fn: Handler) {
      handlers.set(channel, fn)
    }
  } as unknown as IpcMain
  return { ipc, handlers }
}

describe('registerPlaidHandlers — plaid:get-status', () => {
  it('reports configured=false and no env when nothing is set up', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const status = await invoke(handlers.get('plaid:get-status')!)
    expect(status).toEqual({ configured: false, env: null, hasSecret: false, linkedItemIds: [] })
  })

  it('reports configured=true with the env + linked items when set up', async () => {
    isPlaidConfiguredMock.mockReturnValue({ configured: true, env: 'sandbox' })
    getPlaidSecretMock.mockReturnValue('secret')
    listItemIdsMock.mockReturnValue(['item-a', 'item-b'])

    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const status = await invoke(handlers.get('plaid:get-status')!)
    expect(status).toEqual({
      configured: true,
      env: 'sandbox',
      hasSecret: true,
      linkedItemIds: ['item-a', 'item-b']
    })
  })

  it('hasSecret=false when env is set but secret is missing', async () => {
    isPlaidConfiguredMock.mockReturnValue({ configured: false, env: 'sandbox' })
    getPlaidSecretMock.mockReturnValue(null)

    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const status = (await invoke(handlers.get('plaid:get-status')!)) as {
      hasSecret: boolean
      env: string | null
    }
    expect(status.hasSecret).toBe(false)
    expect(status.env).toBe('sandbox')
  })
})

describe('registerPlaidHandlers — plaid:set-secret', () => {
  it('rejects non-sandbox/production envs (defense against renderer typos)', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    await expect(invoke(handlers.get('plaid:set-secret')!, 'development', 's')).rejects.toThrow(
      /sandbox.*production/i
    )
    expect(setPlaidSecretMock).not.toHaveBeenCalled()
  })

  it('rejects empty / non-string secrets', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    await expect(invoke(handlers.get('plaid:set-secret')!, 'sandbox', '')).rejects.toThrow(/secret/)
    await expect(invoke(handlers.get('plaid:set-secret')!, 'sandbox', 123)).rejects.toThrow(
      /secret/
    )
    expect(setPlaidSecretMock).not.toHaveBeenCalled()
  })

  it('stores a valid sandbox secret', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = await invoke(handlers.get('plaid:set-secret')!, 'sandbox', 'sand-secret')
    expect(setPlaidSecretMock).toHaveBeenCalledWith('sandbox', 'sand-secret')
    expect(out).toEqual({ ok: true })
  })
})

describe('registerPlaidHandlers — plaid:disconnect', () => {
  it('rejects empty itemId', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    await expect(invoke(handlers.get('plaid:disconnect')!, '')).rejects.toThrow(/itemId/)
    await expect(invoke(handlers.get('plaid:disconnect')!, 42)).rejects.toThrow(/itemId/)
    expect(removeAccessTokenMock).not.toHaveBeenCalled()
  })

  it('removes the token for a valid itemId', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = await invoke(handlers.get('plaid:disconnect')!, 'item-a')
    expect(removeAccessTokenMock).toHaveBeenCalledWith('item-a')
    expect(out).toEqual({ ok: true })
  })
})

describe('registerPlaidHandlers — plaid:start-link (error paths)', () => {
  it('surfaces PlaidNotConfiguredError as a structured failure (no throw to renderer)', async () => {
    const { PlaidNotConfiguredError } = await import('../integrations/plaid/client')
    createLinkTokenMock.mockRejectedValueOnce(
      new PlaidNotConfiguredError('missing-secret', 'no secret stored')
    )
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)

    const out = await invoke(handlers.get('plaid:start-link')!)
    expect(out).toEqual({
      ok: false,
      cancelled: false,
      errorCode: 'missing-secret',
      errorMessage: 'no secret stored'
    })
  })

  it('wraps unknown errors with LINK_START_FAILED', async () => {
    createLinkTokenMock.mockRejectedValueOnce(new Error('socket hang up'))
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)

    const out = await invoke(handlers.get('plaid:start-link')!)
    expect(out).toEqual({
      ok: false,
      cancelled: false,
      errorCode: 'LINK_START_FAILED',
      errorMessage: 'socket hang up'
    })
  })
})

// ─── plaid:list-items (Phase 4.6 PR 5) ───────────────────────────────────────

describe('registerPlaidHandlers — plaid:list-items', () => {
  it('returns an empty array when no Items are connected', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = await invoke(handlers.get('plaid:list-items')!)
    expect(out).toEqual([])
  })

  it('serializes lastSyncedAt Date → epoch ms across the IPC boundary', async () => {
    // The renderer can't receive live Date instances via structured clone
    // through contextBridge; the handler must hand back a plain number.
    const ts = new Date('2026-05-20T15:00:00Z')
    plaidItemsRows = [
      {
        id: 1,
        itemId: 'item-chase',
        institutionId: 'ins_3',
        institutionName: 'Chase',
        lastSyncedAt: ts,
        errorCode: null
      }
    ]
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = (await invoke(handlers.get('plaid:list-items')!)) as Array<{
      lastSyncedAt: number | null
    }>
    expect(out).toHaveLength(1)
    expect(out[0].lastSyncedAt).toBe(ts.getTime())
    expect(typeof out[0].lastSyncedAt).toBe('number')
  })

  it('passes null lastSyncedAt straight through', async () => {
    plaidItemsRows = [
      {
        id: 2,
        itemId: 'item-new',
        institutionId: 'ins_3',
        institutionName: 'Chase',
        lastSyncedAt: null,
        errorCode: null
      }
    ]
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = (await invoke(handlers.get('plaid:list-items')!)) as Array<{
      lastSyncedAt: number | null
    }>
    expect(out[0].lastSyncedAt).toBeNull()
  })

  it('surfaces errorCode so the UI can render a re-auth CTA', async () => {
    plaidItemsRows = [
      {
        id: 3,
        itemId: 'item-broken',
        institutionId: 'ins_3',
        institutionName: 'Chase',
        lastSyncedAt: null,
        errorCode: 'ITEM_LOGIN_REQUIRED'
      }
    ]
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    const out = (await invoke(handlers.get('plaid:list-items')!)) as Array<{
      errorCode: string | null
    }>
    expect(out[0].errorCode).toBe('ITEM_LOGIN_REQUIRED')
  })
})

// ─── plaid:disconnect — also deletes the SQLite row (Phase 4.6 PR 5) ─────────

describe('registerPlaidHandlers — plaid:disconnect row deletion', () => {
  it('deletes the plaid_items row in addition to removing the vault token', async () => {
    const { ipc, handlers } = makeFakeIpc()
    registerPlaidHandlers(ipc)
    await invoke(handlers.get('plaid:disconnect')!, 'item-a')
    expect(removeAccessTokenMock).toHaveBeenCalledWith('item-a')
    expect(dbDeleteSpy).toHaveBeenCalledOnce()
  })
})
