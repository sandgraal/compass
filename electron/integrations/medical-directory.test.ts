/**
 * Medical directory — the deduped medications/conditions view. Real in-memory
 * SQLite mirroring the `medical_records` columns.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMedicalDirectory } from './medical-directory'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE medical_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
    description TEXT, code TEXT, status TEXT, recorded_at TEXT, ingested_at INTEGER
  );`)
})
afterEach(() => db.close())

function add(
  externalId: string,
  category: string,
  description: string,
  opts: { code?: string; status?: string; recordedAt?: string } = {}
): void {
  db.prepare(
    'INSERT INTO medical_records (external_id, category, description, code, status, recorded_at) VALUES (?,?,?,?,?,?)'
  ).run(
    externalId,
    category,
    description,
    opts.code ?? null,
    opts.status ?? null,
    opts.recordedAt ?? null
  )
}

describe('buildMedicalDirectory', () => {
  it('dedups a medication seen across refills, counting + spanning dates + latest status', () => {
    add('m1', 'medication', 'Aspirin 81mg', {
      code: 'RxNorm:243670',
      status: 'active',
      recordedAt: '2026-01-10'
    })
    add('m2', 'medication', 'aspirin 81mg', { status: 'active', recordedAt: '2026-03-10' })
    add('m3', 'medication', 'Aspirin 81mg', { status: 'stopped', recordedAt: '2026-06-10' })
    add('m4', 'medication', 'Metformin', { recordedAt: '2026-02-01' })

    const dir = buildMedicalDirectory(db)
    expect(dir.hasData).toBe(true)
    const aspirin = dir.medications.find((e) => e.name.toLowerCase() === 'aspirin 81mg')
    expect(aspirin?.count).toBe(3) // merged across casing
    expect(aspirin?.status).toBe('stopped') // most-recent record's status
    expect(aspirin?.firstDate).toBe('2026-01-10')
    expect(aspirin?.lastDate).toBe('2026-06-10')
    expect(aspirin?.code).toBe('RxNorm:243670') // first non-null code kept
    // Ordered most-seen first → Aspirin (3) before Metformin (1).
    expect(dir.medications[0].name.toLowerCase()).toBe('aspirin 81mg')
  })

  it('separates conditions from medications and reports providers as unavailable', () => {
    add('c1', 'condition', 'Type 2 Diabetes', { status: 'active', recordedAt: '2025-05-01' })
    add('m1', 'medication', 'Metformin', { recordedAt: '2025-05-02' })
    const dir = buildMedicalDirectory(db)
    expect(dir.conditions.map((e) => e.name)).toEqual(['Type 2 Diabetes'])
    expect(dir.medications.map((e) => e.name)).toEqual(['Metformin'])
    expect(dir.providersAvailable).toBe(false)
  })

  it('returns an empty directory when the table is absent (older install)', () => {
    db.exec('DROP TABLE medical_records')
    const dir = buildMedicalDirectory(db)
    expect(dir).toMatchObject({ hasData: false, medications: [], conditions: [] })
  })
})
