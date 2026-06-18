import { describe, expect, it, vi } from 'vitest'
import { CRED_ADAPTERS, SSA_ADAPTER, getAdapter } from './adapters'
import type { AutomationPage } from './types'

describe('CRED adapter registry', () => {
  it('finds SSA by id and returns undefined for an unknown portal', () => {
    expect(getAdapter('ssa')).toBe(SSA_ADAPTER)
    expect(getAdapter('nope')).toBeUndefined()
    expect(CRED_ADAPTERS).toContain(SSA_ADAPTER)
  })
})

describe('SSA adapter', () => {
  it('allow-lists its identity providers (assisted login redirects through them)', () => {
    // If these origins were missing, the navigation guard would block the
    // Login.gov / ID.me redirect and login itself would break.
    expect(SSA_ADAPTER.origins).toContain('https://secure.login.gov')
    expect(SSA_ADAPTER.origins).toContain('https://api.id.me')
    expect(SSA_ADAPTER.loginUrl).toMatch(/^https:\/\/secure\.ssa\.gov/)
    expect(SSA_ADAPTER.status).toBe('beta')
  })

  it('detects the logged-in state via the page', async () => {
    const page = { evaluate: vi.fn(async () => true) } as unknown as AutomationPage
    expect(await SSA_ADAPTER.isLoggedIn(page)).toBe(true)
  })

  it('triggers a download and returns its path', async () => {
    const page = {
      evaluate: vi.fn(async () => true), // download link found + clicked
      waitForDownload: vi.fn(async (trigger: () => Promise<void>) => {
        await trigger()
        return '/tmp/ssa.pdf'
      })
    } as unknown as AutomationPage
    await expect(SSA_ADAPTER.fetch(page)).resolves.toEqual({
      kind: 'download',
      path: '/tmp/ssa.pdf'
    })
  })

  it('fails cleanly when the Statement download link is missing', async () => {
    const page = {
      evaluate: vi.fn(async () => false), // link not found
      waitForDownload: vi.fn(async (trigger: () => Promise<void>) => {
        await trigger()
        return '/tmp/never'
      })
    } as unknown as AutomationPage
    await expect(SSA_ADAPTER.fetch(page)).rejects.toThrow(/could not find/i)
  })
})
