import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEFAULT_MONEY_FOLDER = '/tmp/Documents/Money'
const { settings, startFinanceWatcherMock } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  startFinanceWatcherMock: vi.fn()
}))

vi.mock('../db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => {
          const value = settings.get('financeWatchFolder')
          return {
            get: () => (value ? { value } : undefined),
            all: () => []
          }
        },
        orderBy: () => ({
          all: () => []
        })
      })
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            settings.set(row.key, row.value)
          }
        }),
        run: () => {
          settings.set(row.key, row.value)
        }
      })
    }),
    delete: () => ({
      where: () => ({
        run: () => {
          settings.delete('financeWatchFolder')
        }
      })
    })
  })
}))

vi.mock('../integrations/finance-watcher', () => ({
  getWatchedFolder: () => null,
  ingestWatchedFolderNow: vi.fn(),
  startFinanceWatcher: startFinanceWatcherMock,
  stopFinanceWatcher: vi.fn()
}))

vi.mock('../integrations/finance', () => ({
  ingestCsvFolder: vi.fn()
}))

vi.mock('../knowledge/finance-extractor', () => ({
  writeAllFinanceKnowledge: vi.fn()
}))

vi.mock('../paths', () => ({
  DATA_DIR: '/tmp/compass-data'
}))

vi.mock('node:os', () => ({
  homedir: () => '/tmp'
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn()
  }
}))

import { registerFinanceHandlers } from './finance'

describe('registerFinanceHandlers', () => {
  beforeEach(() => {
    settings.clear()
    startFinanceWatcherMock.mockReset()
  })

  it('restarts the watcher on the default folder when clearing the custom watch folder', async () => {
    settings.set('financeWatchFolder', '/tmp/custom-money')

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerFinanceHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    } as never)

    const setWatchFolder = handlers.get('finance:set-watch-folder')

    expect(setWatchFolder).toBeTypeOf('function')

    await setWatchFolder?.({}, null)

    expect(startFinanceWatcherMock).toHaveBeenCalledWith(DEFAULT_MONEY_FOLDER)
    expect(settings.has('financeWatchFolder')).toBe(false)
  })

  it('restarts the watcher on the chosen custom folder when one is provided', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerFinanceHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    } as never)

    const setWatchFolder = handlers.get('finance:set-watch-folder')

    expect(setWatchFolder).toBeTypeOf('function')

    await setWatchFolder?.({}, '/tmp/new-money-folder')

    expect(startFinanceWatcherMock).toHaveBeenCalledWith('/tmp/new-money-folder')
    expect(settings.get('financeWatchFolder')).toBe('/tmp/new-money-folder')
  })
})
