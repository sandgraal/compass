import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Production loads both renderer pages over file://. Electron does not run
 * `webRequest.onHeadersReceived` for file:// responses, so the header CSP set
 * in main.ts never reaches them: the <meta> tag in each HTML entry is the only
 * Content-Security-Policy in force. Pin the directives that matter.
 */
const REPO_ROOT = join(__dirname, '..')
const ENTRIES = ['index.html', join('src', 'quickCapture', 'index.html')]

function metaCsp(file: string): Map<string, string> {
  const html = readFileSync(join(REPO_ROOT, file), 'utf8')
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)
  if (!match) throw new Error(`${file} has no CSP <meta> tag`)
  const directives = new Map<string, string>()
  for (const part of match[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) directives.set(name, values.join(' '))
  }
  return directives
}

describe.each(ENTRIES)('renderer CSP meta tag: %s', (file) => {
  const csp = metaCsp(file)

  it('blocks all frames and plugins (no file:// iframes)', () => {
    expect(csp.get('frame-src')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
  })

  it('allows only same-origin scripts, with no inline or eval', () => {
    expect(csp.get('script-src')).toBe("'self'")
    expect(csp.get('default-src')).toBe("'self'")
  })

  it('keeps the renderer off the network (IPC only)', () => {
    expect(csp.get('connect-src')).toBe("'self'")
  })
})
