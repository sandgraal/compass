/**
 * Desktop ↔ mobile snapshot compatibility (Phase 4c).
 *
 * The mobile companion re-implements the snapshot decrypt + the sync group-id
 * derivation in pure JS (@noble) so it runs in Expo Go. This suite is the
 * contract that keeps the two implementations byte-compatible: it encrypts
 * with the REAL desktop code (`encryptBundle` from backup.ts) and decrypts
 * with the REAL mobile code (`mobile/src/lib/snapshot.ts`), and pins that
 * both sides derive the identical sync group id. If either side drifts —
 * layout, KDF params, context strings — this file goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// backup.ts / device-sync.ts import electron + db plumbing at module level;
// none of it is exercised here (encryptBundle + syncGroupId are pure).
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s) }
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    throw new Error('DB not used in this suite')
  },
  getRawSqlite: () => {
    throw new Error('DB not used in this suite')
  }
}))
vi.mock('../lib/crypto-vault', () => ({
  getOrCreateKey: () => Buffer.alloc(32, 1),
  readEncryptedJson: () => null,
  writeEncryptedJson: () => {}
}))
vi.mock('../paths', () => ({
  DATA_DIR: '/tmp',
  VAULT_DIR: '/tmp',
  KNOWLEDGE_DIR: '/tmp',
  DOCUMENTS_DIR: '/tmp'
}))

import { snapshotSummary, timelineItems } from '../../mobile/src/lib/selectors'
import { decryptSnapshot, deriveGroupId, fromBase64, toHex } from '../../mobile/src/lib/snapshot'
import { syncGroupId } from '../integrations/device-sync'
import { _internal } from './backup'

afterEach(() => vi.clearAllMocks())

/** A minimal but realistic v3 bundle (raw sqlite row shapes). */
function sampleBundle() {
  return {
    version: 3 as const,
    exportedAt: '2026-07-11T10:00:00.000Z',
    appVersion: '9.9.9',
    allTables: {
      records: [
        {
          id: 1,
          source: 'github',
          type: 'commit',
          occurred_at: 1783500000000,
          title: 'fix: the thing',
          body: 'repo · main',
          payload: null,
          dedup_hash: 'h1',
          provenance: null,
          ingested_at: null
        },
        {
          id: 2,
          source: 'amazon',
          type: 'order',
          occurred_at: 1783300000000,
          title: 'USB cable',
          body: '9.99 USD',
          payload: null,
          dedup_hash: 'h2',
          provenance: null,
          ingested_at: null
        },
        {
          id: 3,
          source: 'github',
          type: 'commit',
          occurred_at: null, // undated — must sink to the end
          title: 'chore: undated',
          body: null,
          payload: null,
          dedup_hash: 'h3',
          provenance: null,
          ingested_at: null
        }
      ],
      habits: [{ id: 1, name: 'Meditate', active: 1 }],
      checklist_items: [],
      contacts: [{ id: 1, external_id: 'c1', display_name: 'Ada' }],
      documents: []
    },
    knowledge: {},
    vault: {},
    documentsFiles: {},
    masterKeyHex: 'aa'.repeat(32)
  }
}

describe('snapshot encrypt (desktop) → decrypt (mobile)', () => {
  it('round-trips a v3 bundle through the pure-JS mobile decrypt', () => {
    const bundle = sampleBundle()
    const blob = _internal.encryptBundle(bundle, 'correct horse battery staple')
    const decoded = decryptSnapshot(new Uint8Array(blob), 'correct horse battery staple')

    expect(decoded.version).toBe(3)
    expect(decoded.exportedAt).toBe(bundle.exportedAt)
    expect(decoded.allTables?.records).toHaveLength(3)
    expect(decoded.allTables?.records?.[0]).toMatchObject({ title: 'fix: the thing' })
  })

  it('rejects the wrong passphrase (GCM auth failure)', () => {
    const blob = _internal.encryptBundle(sampleBundle(), 'correct horse battery staple')
    expect(() => decryptSnapshot(new Uint8Array(blob), 'wrong-passphrase')).toThrow(
      /wrong passphrase|corrupted/i
    )
  })

  it('rejects a non-snapshot blob', () => {
    expect(() => decryptSnapshot(new Uint8Array([1, 2, 3]), 'x')).toThrow(/not a compass/i)
  })
})

describe('sync group id parity', () => {
  it('mobile deriveGroupId === desktop syncGroupId (slow scrypt, fixed context)', () => {
    const pass = 'correct horse battery staple'
    expect(deriveGroupId(pass)).toBe(syncGroupId(pass))
    expect(deriveGroupId(pass)).toMatch(/^[a-f0-9]{32}$/)
    expect(deriveGroupId('other-passphrase!')).not.toBe(deriveGroupId(pass))
  })
})

describe('mobile selectors over a decrypted bundle', () => {
  it('timelineItems sorts newest-first with undated rows last', () => {
    const items = timelineItems(sampleBundle())
    expect(items.map((i) => i.id)).toEqual([1, 2, 3])
    expect(items[0].occurredAt).toBe(1783500000000)
    expect(items[2].occurredAt).toBeNull()
  })

  it('snapshotSummary counts records by source + domain tables', () => {
    const s = snapshotSummary(sampleBundle())
    expect(s.recordCount).toBe(3)
    expect(s.sourceCounts[0]).toEqual({ source: 'github', count: 2 })
    expect(s.habitCount).toBe(1)
    expect(s.contactCount).toBe(1)
  })
})

describe('mobile codecs', () => {
  it('fromBase64/toHex round node-produced values', () => {
    const buf = Buffer.from([0, 1, 254, 255, 16])
    expect(fromBase64(buf.toString('base64'))).toEqual(new Uint8Array(buf))
    expect(toHex(new Uint8Array(buf))).toBe(buf.toString('hex'))
  })
})
