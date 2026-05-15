/**
 * Round-trip tests for the passphrase-based backup crypto layer.
 *
 * We exercise the pure encrypt/decrypt path on a hand-rolled `Bundle`
 * without touching the DB / dialog / disk plumbing — those are
 * integration concerns covered in the running app. The point of these
 * tests is to lock in:
 *
 *   - Round-trip equality (same passphrase → identical bundle)
 *   - Wrong-passphrase failure (GCM auth fails before JSON parsing
 *     can be tricked)
 *   - Magic / version validation (v2; v1 is rejected — never released)
 *   - Tamper detection (mid-blob byte flip fails GCM)
 *   - Bundle-structure validation (decryptBundle rejects malformed JSON)
 *   - Path safety helpers (`toPosix`, `isSafeRelativePath`)
 */

import { describe, expect, it } from 'vitest'
import { _internal } from './backup'

const { encryptBundle, decryptBundle, toPosix, isSafeRelativePath } = _internal

function makeBundle() {
  return {
    version: 2 as const,
    exportedAt: '2026-05-15T00:00:00.000Z',
    appVersion: '0.1.1',
    tables: {
      integrations: [{ id: 1, service: 'google' }],
      financeTransactions: [{ id: 10, amount: -12.5, description: 'Coffee' }]
    },
    knowledge: {
      'profile/health.md': '# Health\n\nNothing here yet.\n',
      'work/projects.md': '# Projects\n'
    },
    vault: {
      'financial.enc': Buffer.from([1, 2, 3, 4]).toString('base64')
    },
    masterKeyHex: 'a'.repeat(64)
  }
}

describe('backup encrypt/decrypt', () => {
  const PASS = 'correct-horse-battery-staple'

  it('round-trips an identical bundle', () => {
    const original = makeBundle()
    const blob = encryptBundle(original, PASS)
    const restored = decryptBundle(blob, PASS)
    expect(restored).toEqual(original)
  })

  it('rejects the wrong passphrase', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    expect(() => decryptBundle(blob, 'wrong-pass-9999')).toThrow(/passphrase|corrupted/i)
  })

  it('rejects a non-Compass file (bad magic)', () => {
    const fake = Buffer.alloc(200, 0x42)
    expect(() => decryptBundle(fake, PASS)).toThrow(/magic header/i)
  })

  it('rejects an unsupported version byte', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    blob[8] = 0xff // byte after MAGIC is the version
    expect(() => decryptBundle(blob, PASS)).toThrow(/version/i)
  })

  it('rejects v1 bundles (pre-release, no master key in payload)', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    blob[8] = 0x01
    expect(() => decryptBundle(blob, PASS)).toThrow(/version/i)
  })

  it('detects mid-blob tampering', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    const flipIdx = blob.length - 10
    blob[flipIdx] = blob[flipIdx] ^ 0x55
    expect(() => decryptBundle(blob, PASS)).toThrow(/passphrase|corrupted/i)
  })

  it('produces stable header magic + v2 byte', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    expect(blob.subarray(0, 8).toString('utf8')).toBe('COMPASSB')
    expect(blob[8]).toBe(0x02)
  })

  it('rejects a file too small to contain the header', () => {
    expect(() => decryptBundle(Buffer.alloc(10), PASS)).toThrow(/too small/i)
  })

  it('rejects a bundle whose masterKeyHex is malformed', () => {
    const bad = { ...makeBundle(), masterKeyHex: 'not-hex-not-64-chars' }
    const blob = encryptBundle(bad as never, PASS)
    expect(() => decryptBundle(blob, PASS)).toThrow(/structure is invalid/i)
  })

  it('rejects a bundle missing the tables map', () => {
    const bad = { ...makeBundle(), tables: undefined as unknown }
    const blob = encryptBundle(bad as never, PASS)
    expect(() => decryptBundle(blob, PASS)).toThrow(/structure is invalid/i)
  })
})

describe('path safety helpers', () => {
  it('toPosix is a no-op on POSIX hosts (host-conditional)', () => {
    // The helper only swaps when the host separator is "\". On posix
    // hosts it returns the input verbatim — that's the expected /
    // documented behaviour, so assert the round trip.
    expect(toPosix('work/projects.md')).toBe('work/projects.md')
  })

  it('isSafeRelativePath blocks parent-dir traversal', () => {
    expect(isSafeRelativePath('../outside.md')).toBe(false)
    expect(isSafeRelativePath('work/../../../etc/passwd')).toBe(false)
  })

  it('isSafeRelativePath blocks absolute-looking paths', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('\\etc\\passwd')).toBe(false)
  })

  it('isSafeRelativePath accepts normal nested keys with either separator', () => {
    expect(isSafeRelativePath('work/projects.md')).toBe(true)
    expect(isSafeRelativePath('work\\projects.md')).toBe(true)
    expect(isSafeRelativePath('general/foo.md')).toBe(true)
  })

  it('isSafeRelativePath rejects empty input', () => {
    expect(isSafeRelativePath('')).toBe(false)
  })
})
