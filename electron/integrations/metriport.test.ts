import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

// Stateful stand-in for the encrypted (safeStorage-backed) token store so we can
// assert PHI demographics land there and never in plaintext app_settings.
const tokenStore = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../ipc/auth', () => ({
  loadToken: (id: string) => tokenStore.current[id] ?? null,
  saveToken: (id: string, value: unknown) => {
    tokenStore.current[id] = value
  }
}))

import {
  loadMetriportDemographics,
  normalizeMetriportBundle,
  upsertMedicalRecords
} from './metriport'

const BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Condition',
        id: 'c1',
        code: {
          text: 'Type 2 diabetes',
          coding: [{ code: 'E11.9', display: 'Type 2 diabetes mellitus' }]
        },
        clinicalStatus: { coding: [{ code: 'active' }] },
        onsetDateTime: '2021-03-15T00:00:00Z'
      }
    },
    {
      resource: {
        resourceType: 'MedicationStatement',
        id: 'm1',
        medicationCodeableConcept: { coding: [{ code: '197361', display: 'Metformin 500 MG' }] },
        status: 'active',
        effectiveDateTime: '2022-01-10'
      }
    },
    {
      resource: {
        resourceType: 'Immunization',
        id: 'i1',
        vaccineCode: { text: 'Influenza' },
        status: 'completed',
        occurrenceDateTime: '2025-10-01'
      }
    },
    {
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'a1',
        code: { text: 'Penicillin' },
        clinicalStatus: { coding: [{ code: 'active' }] },
        recordedDate: '2019-06-01'
      }
    },
    {
      resource: {
        resourceType: 'Observation',
        id: 'o1',
        code: { text: 'Hemoglobin A1c' },
        status: 'final',
        effectiveDateTime: '2026-05-20',
        valueQuantity: { value: 6.1, unit: '%' } // must NOT be stored (raw lab value)
      }
    },
    { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] } }, // non-clinical → skipped
    { resource: { resourceType: 'Condition', id: 'c2' } } // no code → skipped
  ]
}

describe('normalizeMetriportBundle', () => {
  it('maps FHIR resources to clinical records, skipping non-clinical + code-less ones', () => {
    const out = normalizeMetriportBundle(BUNDLE)
    expect(out).toHaveLength(5) // Patient + code-less Condition dropped
    expect(out.find((r) => r.externalId === 'metriport:Condition:c1')).toEqual({
      externalId: 'metriport:Condition:c1',
      category: 'condition',
      description: 'Type 2 diabetes',
      code: 'E11.9',
      status: 'active',
      recordedAt: '2021-03-15' // sliced from the ISO datetime
    })
    expect(out.find((r) => r.externalId === 'metriport:MedicationStatement:m1')).toMatchObject({
      category: 'medication',
      description: 'Metformin 500 MG',
      code: '197361',
      status: 'active',
      recordedAt: '2022-01-10'
    })
    expect(out.find((r) => r.category === 'immunization')).toMatchObject({
      description: 'Influenza',
      recordedAt: '2025-10-01'
    })
    expect(out.find((r) => r.category === 'allergy')).toMatchObject({
      description: 'Penicillin',
      status: 'active'
    })
    expect(out.find((r) => r.category === 'lab')).toMatchObject({
      description: 'Hemoglobin A1c',
      recordedAt: '2026-05-20'
    })
    // Privacy: the raw lab value is never stored — only the clinical name.
    expect(JSON.stringify(out)).not.toContain('6.1')
  })

  it('tolerates malformed input', () => {
    expect(normalizeMetriportBundle({})).toEqual([])
    expect(normalizeMetriportBundle({ entry: 'nope' })).toEqual([])
    expect(
      normalizeMetriportBundle({ entry: [{ resource: { resourceType: 'Condition' } }] })
    ).toEqual([]) // no id
  })
})

describe('upsertMedicalRecords (real DB)', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>
  let sqlite: InstanceType<typeof Database>

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, description TEXT, code TEXT, status TEXT,
        recorded_at TEXT, ingested_at INTEGER
      );
    `)
    db = drizzle<typeof schema>(sqlite, { schema })
  })

  it('upserts records, then refreshes in place on re-sync (idempotent)', () => {
    const rows = normalizeMetriportBundle(BUNDLE)
    expect(upsertMedicalRecords(db, rows)).toBe(5)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM medical_records').get()).toEqual({ n: 5 })

    const changed = rows.map((r) =>
      r.externalId === 'metriport:Condition:c1' ? { ...r, status: 'resolved' } : r
    )
    expect(upsertMedicalRecords(db, changed)).toBe(5)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM medical_records').get()).toEqual({ n: 5 })
    expect(
      sqlite
        .prepare("SELECT status FROM medical_records WHERE external_id = 'metriport:Condition:c1'")
        .get()
    ).toEqual({ status: 'resolved' })
  })
})

describe('loadMetriportDemographics (PHI stays encrypted)', () => {
  let sqlite: InstanceType<typeof Database>

  beforeEach(() => {
    tokenStore.current = {}
    sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);')
  })

  it('migrates a legacy plaintext seed into the encrypted store and purges the plaintext row', () => {
    const demo = { firstName: 'Ada', lastName: 'Lovelace', dob: '1815-12-10' }
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('metriportPatient', JSON.stringify(demo))

    // First read migrates the seed, then returns it.
    expect(loadMetriportDemographics(sqlite)).toEqual(demo)
    // Plaintext PHI is gone from app_settings.
    expect(
      sqlite.prepare("SELECT value FROM app_settings WHERE key = 'metriportPatient'").get()
    ).toBeUndefined()
    // …and now lives only in the encrypted token blob.
    expect((tokenStore.current.metriport as { demographics?: unknown }).demographics).toEqual(demo)

    // Second read comes straight from the encrypted store (no plaintext needed).
    expect(loadMetriportDemographics(sqlite)).toEqual(demo)
  })

  it('returns null when nothing is configured', () => {
    expect(loadMetriportDemographics(sqlite)).toBeNull()
  })
})
