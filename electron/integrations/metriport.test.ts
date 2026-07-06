import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { normalizeMetriportBundle, upsertMedicalRecords } from './metriport'

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
