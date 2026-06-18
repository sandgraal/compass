import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CredTimeoutError,
  isAllowedNavigation,
  pollUntilLoggedIn,
  runPortalPull,
  sanitizeDownloadName
} from './runtime'
import type { AutomationPage, PortalAdapter } from './types'

function fakePage(over: Partial<AutomationPage> = {}): AutomationPage {
  const base: AutomationPage = {
    url: () => 'about:blank',
    goto: async () => {},
    evaluate: async () => undefined as never,
    waitForDownload: async (trigger) => {
      await trigger()
      return '/tmp/file.pdf'
    }
  }
  return { ...base, ...over }
}

function fakeAdapter(over: Partial<PortalAdapter> = {}): PortalAdapter {
  return {
    id: 'demo',
    name: 'Demo',
    loginUrl: 'https://demo.test/login',
    origins: ['https://demo.test'],
    status: 'beta',
    isLoggedIn: async () => true,
    fetch: async () => ({ kind: 'download', path: '/tmp/x.pdf' }),
    ...over
  }
}

describe('isAllowedNavigation', () => {
  const origins = ['https://demo.test', 'https://idp.test']
  it('allows same-origin (incl. deep paths) and identity-provider hops', () => {
    expect(isAllowedNavigation('https://demo.test/account/statement', origins)).toBe(true)
    expect(isAllowedNavigation('https://idp.test/login', origins)).toBe(true)
  })
  it('allows the window’s own empty document', () => {
    expect(isAllowedNavigation('about:blank', origins)).toBe(true)
    expect(isAllowedNavigation('', origins)).toBe(true)
  })
  it('blocks off-origin navigation and garbage URLs', () => {
    expect(isAllowedNavigation('https://evil.test/phish', origins)).toBe(false)
    expect(isAllowedNavigation('http://demo.test/', origins)).toBe(false) // scheme differs → origin differs
    expect(isAllowedNavigation('not a url', origins)).toBe(false)
  })
})

describe('sanitizeDownloadName', () => {
  it('strips path components and traversal, keeping a safe basename', () => {
    expect(sanitizeDownloadName('a/b/../c.pdf')).toBe('c.pdf')
    expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadName('we ird*name?.pdf')).toBe('we_ird_name_.pdf')
    expect(sanitizeDownloadName('')).toBe('download')
    expect(sanitizeDownloadName('...')).toBe('download')
  })
})

describe('pollUntilLoggedIn', () => {
  it('returns immediately when already logged in', async () => {
    const adapter = fakeAdapter({ isLoggedIn: async () => true })
    const delay = vi.fn(async () => {})
    await pollUntilLoggedIn(adapter, fakePage(), { delay, now: () => 0 })
    expect(delay).not.toHaveBeenCalled()
  })

  it('polls until the user has logged in', async () => {
    let calls = 0
    const adapter = fakeAdapter({
      isLoggedIn: async () => {
        calls += 1
        return calls >= 3
      }
    })
    const delay = vi.fn(async () => {})
    await pollUntilLoggedIn(adapter, fakePage(), {
      delay,
      pollMs: 5,
      timeoutMs: 10_000,
      now: () => 0
    })
    expect(calls).toBe(3)
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('throws CredTimeoutError once the deadline passes', async () => {
    const adapter = fakeAdapter({ isLoggedIn: async () => false })
    let t = 0
    const now = (): number => {
      t += 1000
      return t
    }
    await expect(
      pollUntilLoggedIn(adapter, fakePage(), { delay: async () => {}, timeoutMs: 1, now })
    ).rejects.toBeInstanceOf(CredTimeoutError)
  })
})

describe('runPortalPull', () => {
  it('navigates to the login URL then returns the downloaded artifact path', async () => {
    const goto = vi.fn(async () => {})
    const page = fakePage({ goto })
    const adapter = fakeAdapter({ fetch: async () => ({ kind: 'download', path: '/tmp/dl.pdf' }) })
    const res = await runPortalPull(adapter, page, { waitForLogin: async () => {} })
    expect(goto).toHaveBeenCalledWith('https://demo.test/login')
    expect(res.path).toBe('/tmp/dl.pdf')
  })

  it('writes a scrape artifact to a temp file so it re-enters normal ingest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-test-'))
    const adapter = fakeAdapter({
      fetch: async () => ({ kind: 'scrape', text: 'hi there', ext: 'txt' })
    })
    const res = await runPortalPull(adapter, fakePage(), {
      waitForLogin: async () => {},
      tmpDir: dir,
      stamp: 'unit'
    })
    expect(res.path).toBe(join(dir, 'demo-unit.txt'))
    expect(readFileSync(res.path, 'utf-8')).toBe('hi there')
  })

  it('defaults a non-alphanumeric scrape extension to txt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-test-'))
    const adapter = fakeAdapter({
      fetch: async () => ({ kind: 'scrape', text: 'x', ext: '../evil' })
    })
    const res = await runPortalPull(adapter, fakePage(), {
      waitForLogin: async () => {},
      tmpDir: dir,
      stamp: 's'
    })
    expect(res.path).toBe(join(dir, 'demo-s.txt'))
  })
})
