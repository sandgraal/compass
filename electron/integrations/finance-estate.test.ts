import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AssetRow,
  ESTATE_ITEMS,
  RECOMMENDED_INSURANCE,
  buildEstateReadiness,
  buildEstateReadinessFromDb,
  getEstateChecklist,
  setEstateItem
} from './finance-estate'

function asset(over: Partial<AssetRow>): AssetRow {
  return {
    type: 'insurance',
    name: 'Policy',
    value: null,
    provider: null,
    reference: null,
    renewal_date: null,
    status: 'active',
    notes: null,
    ...over
  }
}

describe('buildEstateReadiness', () => {
  it('reflects the checklist + scores estate completion', () => {
    const r = buildEstateReadiness({
      checklist: { will: { present: true, notes: 'with attorney' }, trust: { present: true } },
      assets: [],
      today: '2026-01-01'
    })
    expect(r.estate).toHaveLength(ESTATE_ITEMS.length)
    expect(r.estate.find((e) => e.key === 'will')).toMatchObject({
      present: true,
      notes: 'with attorney'
    })
    expect(r.estate.find((e) => e.key === 'power-of-attorney')?.present).toBe(false)
    expect(r.score.estateDone).toBe(2)
    expect(r.score.estateTotal).toBe(ESTATE_ITEMS.length)
  })

  it('lists active insurance with coverage + an expiring-soon flag', () => {
    const r = buildEstateReadiness({
      checklist: {},
      assets: [
        asset({ name: 'Term Life', value: 500_000, renewal_date: '2026-02-01' }), // ~31d → soon
        asset({ name: 'Auto', value: 50_000, renewal_date: '2026-12-01' }), // far off
        asset({ name: 'Old Health', status: 'cancelled' }) // excluded (not active)
      ],
      today: '2026-01-01'
    })
    expect(r.insurance.policies).toHaveLength(2)
    expect(r.insurance.policies.find((p) => p.name === 'Term Life')?.expiringSoon).toBe(true)
    expect(r.insurance.policies.find((p) => p.name === 'Auto')?.expiringSoon).toBe(false)
  })

  it('reports insurance gaps vs the recommended set', () => {
    // Only life + auto present → health, property, liability are gaps.
    const r = buildEstateReadiness({
      checklist: {},
      assets: [asset({ name: 'Whole Life' }), asset({ name: 'Vehicle policy' })],
      today: '2026-01-01'
    })
    const gapKeys = r.insurance.gaps.map((g) => g.key).sort()
    expect(gapKeys).toEqual(['health', 'liability', 'property'])
    expect(r.score.insuranceCovered).toBe(RECOMMENDED_INSURANCE.length - 3)
  })

  it('surfaces active property holdings', () => {
    const r = buildEstateReadiness({
      checklist: {},
      assets: [
        asset({ type: 'property', name: 'CR House', value: 250_000, reference: 'Folio 123' }),
        asset({ type: 'property', name: 'Sold lot', status: 'sold' }) // excluded
      ],
      today: '2026-01-01'
    })
    expect(r.properties).toHaveLength(1)
    expect(r.properties[0]).toMatchObject({
      name: 'CR House',
      value: 250_000,
      reference: 'Folio 123'
    })
  })
})

// ─── DB layer ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'other', name TEXT NOT NULL, value REAL, provider TEXT,
      reference TEXT, renewal_date TEXT, status TEXT NOT NULL DEFAULT 'active', notes TEXT,
      created_at INTEGER, updated_at INTEGER
    );
  `)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('estate checklist persistence', () => {
  it('defaults empty then round-trips item edits (read-modify-write)', () => {
    expect(getEstateChecklist(sqlite)).toEqual({})
    setEstateItem(sqlite, 'will', { present: true })
    setEstateItem(sqlite, 'will', { notes: 'in the safe' }) // merge, not overwrite
    setEstateItem(sqlite, 'trust', { present: false })
    const state = getEstateChecklist(sqlite)
    expect(state.will).toEqual({ present: true, notes: 'in the safe' })
    expect(state.trust).toEqual({ present: false })
  })
})

describe('buildEstateReadinessFromDb', () => {
  it('assembles from the checklist + the assets table', () => {
    setEstateItem(sqlite, 'will', { present: true })
    sqlite
      .prepare(
        "INSERT INTO assets (external_id, type, name, value, status) VALUES ('manual:1', 'insurance', 'Health PPO', 0, 'active')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO assets (external_id, type, name, value, status) VALUES ('manual:2', 'property', 'CR House', 250000, 'active')"
      )
      .run()

    const r = buildEstateReadinessFromDb(sqlite, '2026-01-01')
    expect(r.estate.find((e) => e.key === 'will')?.present).toBe(true)
    expect(r.insurance.policies).toHaveLength(1)
    expect(r.insurance.gaps.some((g) => g.key === 'health')).toBe(false) // health is covered
    expect(r.properties[0].name).toBe('CR House')
  })
})
