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
 *   - Magic / version validation
 *   - Tamper detection (mid-blob byte flip fails GCM)
 */

import { describe, expect, it } from 'vitest'
import { _internal } from './backup'

const { encryptBundle, decryptBundle } = _internal

function makeBundle() {
  return {
    version: 1 as const,
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
    }
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

  it('detects mid-blob tampering', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    // Flip a byte deep in the ciphertext (well after the header) so
    // GCM's auth tag check fails.
    const flipIdx = blob.length - 10
    blob[flipIdx] = blob[flipIdx] ^ 0x55
    expect(() => decryptBundle(blob, PASS)).toThrow(/passphrase|corrupted/i)
  })

  it('produces stable header magic', () => {
    const blob = encryptBundle(makeBundle(), PASS)
    expect(blob.subarray(0, 8).toString('utf8')).toBe('COMPASSB')
    expect(blob[8]).toBe(0x01)
  })

  it('rejects a file too small to contain the header', () => {
    expect(() => decryptBundle(Buffer.alloc(10), PASS)).toThrow(/too small/i)
  })
})
