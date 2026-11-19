/**
 * Window / session hardening: scheme filter, app-origin pin, permission policy,
 * and the wiring onto a (fake) WebContents / Session.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  installAppWindowGuards,
  installPermissionHandlers,
  isAppNavigation,
  isPermissionAllowed,
  openExternalSafely,
  toSafeExternalUrl
} from './window-security'

describe('toSafeExternalUrl', () => {
  it.each([
    ['https://example.com/a?b=1#c', 'https://example.com/a?b=1#c'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.COM/x', 'https://example.com/x'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['tel:+15555555555', 'tel:+15555555555'],
    ['mailto:a@example.com?subject=Hi%20there', 'mailto:a@example.com?subject=Hi%20there']
  ])('allows %s', (raw, expected) => {
    expect(toSafeExternalUrl(raw)).toBe(expected)
  })

  it.each([
    'file:///etc/passwd',
    'file://server/share/evil.exe',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid',
    'smb://attacker/share',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'vscode://file/etc/passwd',
    'compass://open/vault',
    'ftp://example.com/file',
    'about:blank',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html'
  ])('blocks %s', (raw) => {
    expect(toSafeExternalUrl(raw)).toBeNull()
  })

  it.each(['', 'not a url', '//example.com/protocol-relative', '/relative/path', 'example.com'])(
    'blocks unparsable / relative input %j',
    (raw) => {
      expect(toSafeExternalUrl(raw)).toBeNull()
    }
  )

  it('blocks non-string input', () => {
    expect(toSafeExternalUrl(undefined)).toBeNull()
    expect(toSafeExternalUrl(null)).toBeNull()
    expect(toSafeExternalUrl(42)).toBeNull()
    expect(toSafeExternalUrl({ toString: () => 'https://example.com' })).toBeNull()
  })

  it('returns the normalized href, not the raw string', () => {
    // Leading/trailing whitespace and tab/newline are stripped by the URL parser;
    // the OS must receive exactly what was validated.
    expect(toSafeExternalUrl('  https://example.com/\n')).toBe('https://example.com/')
  })
})

describe('isAppNavigation', () => {
  const devUrl = 'http://localhost:5173'
  const prodUrl =
    'file:///Applications/Compass.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('dev: allows same-origin, any path / hash', () => {
    expect(isAppNavigation('http://localhost:5173/', devUrl)).toBe(true)
    expect(isAppNavigation('http://localhost:5173/#/finance', devUrl)).toBe(true)
    expect(isAppNavigation('http://localhost:5173/src/quickCapture/index.html', devUrl)).toBe(true)
  })

  it('dev: rejects other origins', () => {
    expect(isAppNavigation('http://localhost:5174/', devUrl)).toBe(false)
    expect(isAppNavigation('https://localhost:5173/', devUrl)).toBe(false)
    expect(isAppNavigation('http://127.0.0.1:5173/', devUrl)).toBe(false)
    expect(isAppNavigation('https://evil.example/', devUrl)).toBe(false)
    expect(isAppNavigation('file:///etc/passwd', devUrl)).toBe(false)
  })

  it('prod: allows only the renderer index file, ignoring query + hash', () => {
    expect(isAppNavigation(prodUrl, prodUrl)).toBe(true)
    expect(isAppNavigation(`${prodUrl}#/contacts`, prodUrl)).toBe(true)
    expect(isAppNavigation(`${prodUrl}?x=1#/`, prodUrl)).toBe(true)
  })

  it('prod: rejects other local files and remote origins', () => {
    expect(isAppNavigation('file:///etc/passwd', prodUrl)).toBe(false)
    expect(
      isAppNavigation(
        'file:///Applications/Compass.app/Contents/Resources/app.asar/out/renderer/other.html',
        prodUrl
      )
    ).toBe(false)
    expect(isAppNavigation('file://attacker/share/index.html', prodUrl)).toBe(false)
    expect(isAppNavigation('https://example.com/', prodUrl)).toBe(false)
    expect(isAppNavigation('javascript:alert(1)', prodUrl)).toBe(false)
    expect(isAppNavigation('about:blank', prodUrl)).toBe(false)
  })

  it('prod: treats percent-encoded and literal paths as the same file', () => {
    const spaced = 'file:///Users/me/My%20Apps/Compass/out/renderer/index.html'
    expect(
      isAppNavigation('file:///Users/me/My Apps/Compass/out/renderer/index.html', spaced)
    ).toBe(true)
  })

  it('prod: path traversal does not escape the pin', () => {
    expect(
      isAppNavigation(
        'file:///Applications/Compass.app/Contents/Resources/app.asar/out/renderer/../../../../../etc/passwd',
        prodUrl
      )
    ).toBe(false)
  })

  it('rejects unparsable input', () => {
    expect(isAppNavigation('not a url', devUrl)).toBe(false)
    expect(isAppNavigation('http://localhost:5173/', 'not a url')).toBe(false)
  })
})

describe('openExternalSafely', () => {
  it('opens allowed URLs with the normalized href', () => {
    const open = vi.fn().mockResolvedValue(undefined)
    expect(openExternalSafely('HTTPS://Example.com', open)).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/')
  })

  it('never calls the opener for blocked schemes', () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(openExternalSafely('file:///etc/passwd', open)).toBe(false)
    expect(openExternalSafely('ms-msdt:/id PCWDiagnostic', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows a rejected openExternal promise', async () => {
    const open = vi.fn().mockRejectedValue(new Error('no handler'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(openExternalSafely('https://example.com', open)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith('[window-security] openExternal failed:', 'no handler')
    warn.mockRestore()
  })
})

type Listener = (event: { preventDefault: () => void }, url: string) => void

function fakeWebContents() {
  let openHandler: ((d: { url: string }) => { action: string }) | undefined
  const listeners = new Map<string, Listener>()
  const wc = {
    setWindowOpenHandler: vi.fn((h) => {
      openHandler = h
    }),
    on: vi.fn((name: string, l: Listener) => {
      listeners.set(name, l)
      return wc
    })
  }
  const fire = (name: string, url: string) => {
    const preventDefault = vi.fn()
    listeners.get(name)?.({ preventDefault }, url)
    return preventDefault
  }
  return { wc, open: (url: string) => openHandler?.({ url }), fire }
}

describe('installAppWindowGuards', () => {
  const appUrl = 'file:///app/out/renderer/index.html'

  function setup() {
    const f = fakeWebContents()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    // biome-ignore lint/suspicious/noExplicitAny: structural fake of WebContents
    installAppWindowGuards(f.wc as any, appUrl, openExternal)
    return { ...f, openExternal }
  }

  it('window.open: always denies; opens allowed schemes externally', () => {
    const { open, openExternal } = setup()
    expect(open('https://example.com/x')).toEqual({ action: 'deny' })
    expect(open('mailto:a@example.com')).toEqual({ action: 'deny' })
    expect(openExternal.mock.calls).toEqual([['https://example.com/x'], ['mailto:a@example.com']])
  })

  it('window.open: denies and drops dangerous schemes', () => {
    const { open, openExternal } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'ms-msdt:/id x']) {
      expect(open(url)).toEqual({ action: 'deny' })
    }
    expect(openExternal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('will-navigate: in-app navigation proceeds', () => {
    const { fire, openExternal } = setup()
    expect(fire('will-navigate', `${appUrl}#/finance`)).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('will-navigate: external http(s) link is cancelled and opened in the browser', () => {
    const { fire, openExternal } = setup()
    expect(fire('will-navigate', 'https://example.com/')).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('will-navigate: other local files / dangerous schemes are cancelled, not opened', () => {
    const { fire, openExternal } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(fire('will-navigate', 'file:///etc/passwd')).toHaveBeenCalledOnce()
    expect(fire('will-navigate', 'smb://attacker/share')).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('will-redirect: off-app redirects are cancelled and never opened', () => {
    const { fire, openExternal } = setup()
    expect(fire('will-redirect', 'https://example.com/')).toHaveBeenCalledOnce()
    expect(fire('will-redirect', appUrl)).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('isPermissionAllowed', () => {
  it('allows clipboard writes (copy buttons)', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true)
  })

  it.each([
    'clipboard-read',
    'media',
    'geolocation',
    'notifications',
    'display-capture',
    'fullscreen',
    'hid',
    'serial',
    'usb',
    'midiSysex',
    'fileSystem',
    'pointerLock',
    'keyboardLock',
    'storage-access',
    'window-management',
    'unknown'
  ])('denies %s', (permission) => {
    expect(isPermissionAllowed(permission)).toBe(false)
  })

  it('openExternal: allowed only for an allow-listed scheme', () => {
    expect(isPermissionAllowed('openExternal', 'mailto:a@example.com')).toBe(true)
    expect(isPermissionAllowed('openExternal', 'https://example.com')).toBe(true)
    expect(isPermissionAllowed('openExternal', 'ms-msdt:/id x')).toBe(false)
    expect(isPermissionAllowed('openExternal', 'smb://attacker/share')).toBe(false)
    expect(isPermissionAllowed('openExternal', 'file:///etc/passwd')).toBe(false)
    expect(isPermissionAllowed('openExternal')).toBe(false)
  })
})

describe('installPermissionHandlers', () => {
  function setup() {
    let request: ((...a: unknown[]) => void) | undefined
    let check: ((...a: unknown[]) => boolean) | undefined
    const session = {
      setPermissionRequestHandler: vi.fn((h) => {
        request = h
      }),
      setPermissionCheckHandler: vi.fn((h) => {
        check = h
      })
    }
    // biome-ignore lint/suspicious/noExplicitAny: structural fake of Session
    installPermissionHandlers(session as any)
    const ask = (permission: string, details: Record<string, unknown> = {}) => {
      const cb = vi.fn()
      request?.({}, permission, cb, {
        requestingUrl: 'file:///app/index.html',
        isMainFrame: true,
        ...details
      })
      return cb.mock.calls[0]?.[0]
    }
    return { ask, check: (p: string) => check?.(null, p, 'file:///', {}) }
  }

  it('request handler: deny by default, grant allow-list, filter openExternal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ask } = setup()
    expect(ask('media', { mediaTypes: ['video'] })).toBe(false)
    expect(ask('geolocation')).toBe(false)
    expect(ask('clipboard-sanitized-write')).toBe(true)
    expect(ask('openExternal', { externalURL: 'mailto:a@example.com' })).toBe(true)
    expect(ask('openExternal', { externalURL: 'ms-msdt:/id x' })).toBe(false)
    expect(ask('openExternal')).toBe(false)
    warn.mockRestore()
  })

  it('check handler: deny by default, allow clipboard write', () => {
    const { check } = setup()
    expect(check('clipboard-sanitized-write')).toBe(true)
    expect(check('clipboard-read')).toBe(false)
    expect(check('hid')).toBe(false)
    expect(check('notifications')).toBe(false)
  })
})
