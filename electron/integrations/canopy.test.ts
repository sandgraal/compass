import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  type CanopyAsset,
  lineOfBusinessName,
  maskPolicyNumber,
  normalizeCanopyPull,
  upsertInsuranceAssets
} from './canopy'
import { buildEstateReadinessFromDb } from './finance-estate'

const PULL = {
  policies: [
    {
      id: 'p1',
      policy_number: 'AUTO-9876',
      policy_type: 'AUTO',
      carrier_name: 'GEICO',
      expiration_date: '2026-01-31',
      coverages: [
        { type: 'BODILY_INJURY', limit: 100000 },
        { type: 'PROPERTY', limit: 50000 }
      ],
      annual_premium: 1200
    },
    {
      id: 'p2',
      policy_number: 'HO-12345678',
      policy_type: 'HOMEOWNERS',
      carrier_name: 'State Farm',
      expiration_date: '2026-03-15T00:00:00Z',
      coverages: [{ type: 'DWELLING', limit: 400000 }],
      premium: { amount: 2400 }
    }
  ]
}

describe('normalizeCanopyPull', () => {
  it('maps policies to keyword-matchable insurance assets (max coverage, masked #, carrier)', () => {
    const out = normalizeCanopyPull(PULL)
    expect(out).toHaveLength(2)
    const auto = out.find((a) => a.externalId === 'canopy:p1')
    expect(auto?.asset).toMatchObject({
      type: 'insurance',
      name: 'Auto insurance',
      value: 100000, // MAX(100k, 50k)
      provider: 'GEICO',
      reference: '••••9876',
      renewalDate: '2026-01-31'
    })
    const home = out.find((a) => a.externalId === 'canopy:p2')
    expect(home?.asset).toMatchObject({
      name: 'Homeowners insurance',
      value: 400000,
      provider: 'State Farm',
      renewalDate: '2026-03-15' // sliced from the ISO datetime
    })
    expect(home?.asset.notes).toBe('Premium 2,400')
  })

  it('skips malformed input safely', () => {
    expect(normalizeCanopyPull({})).toEqual([])
    expect(normalizeCanopyPull({ policies: 'nope' })).toEqual([])
    expect(normalizeCanopyPull({ policies: [{ policy_type: 'AUTO' }] })).toEqual([]) // no id
  })
})

describe('lineOfBusinessName + maskPolicyNumber', () => {
  it('maps lines of business to names the estate gap-matcher recognizes', () => {
    expect(lineOfBusinessName('AUTO')).toBe('Auto insurance')
    expect(lineOfBusinessName('HOMEOWNERS')).toBe('Homeowners insurance')
    expect(lineOfBusinessName('UMBRELLA')).toBe('Umbrella / liability insurance')
    expect(lineOfBusinessName('LIFE')).toBe('Life insurance')
    expect(lineOfBusinessName('PET')).toBe('Pet insurance') // title-cased fallback
  })

  it('masks all but the last 4 of a policy number', () => {
    expect(maskPolicyNumber('AUTO-9876')).toBe('••••9876')
    expect(maskPolicyNumber('AB12')).toBe('AB12')
    expect(maskPolicyNumber('')).toBeNull()
  })
})

describe('Canopy → estate integration', () => {
  let sqlite: Database.Database
  let db: ReturnType<typeof drizzle<typeof schema>>
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'other', name TEXT NOT NULL, value REAL, provider TEXT,
        reference TEXT, renewal_date TEXT, status TEXT NOT NULL DEFAULT 'active', notes TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    `)
    db = drizzle<typeof schema>(sqlite, { schema })
  })

  it('upserts policies into assets so the estate engine fills the auto + home gaps', () => {
    const n = upsertInsuranceAssets(db, normalizeCanopyPull(PULL))
    expect(n).toBe(2)

    const readiness = buildEstateReadinessFromDb(sqlite, '2025-06-15')
    expect(readiness.insurance.policies).toHaveLength(2)
    const gapKeys = readiness.insurance.gaps.map((g) => g.key)
    expect(gapKeys).not.toContain('auto') // filled by the GEICO auto policy
    expect(gapKeys).not.toContain('home') // filled by the State Farm homeowners policy
    expect(gapKeys).toContain('life') // still a gap — no life policy pulled
  })

  it('is idempotent — a re-sync refreshes in place, never duplicates', () => {
    upsertInsuranceAssets(db, normalizeCanopyPull(PULL))
    const items: CanopyAsset[] = normalizeCanopyPull(PULL)
    items[0].asset.value = 150000 // coverage changed
    upsertInsuranceAssets(db, items)

    const rows = sqlite
      .prepare('SELECT external_id, value FROM assets ORDER BY external_id')
      .all() as Array<{
      external_id: string
      value: number
    }>
    expect(rows).toHaveLength(2) // not 4
    expect(rows.find((r) => r.external_id === 'canopy:p1')?.value).toBe(150000) // updated in place
  })
})
