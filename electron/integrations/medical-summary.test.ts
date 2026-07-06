import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { buildMedicalSummary } from './medical-summary'

function seed(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL, description TEXT, code TEXT, status TEXT,
      recorded_at TEXT, ingested_at INTEGER
    );
    INSERT INTO medical_records (external_id, category, description, status, recorded_at) VALUES
      ('m:1', 'condition', 'Older condition', 'resolved', '2020-01-01'),
      ('m:2', 'condition', 'Newer condition', 'active', '2026-01-01'),
      ('m:3', 'medication', 'Metformin', 'active', '2025-06-01'),
      ('m:4', 'immunization', 'Influenza', 'completed', '2024-10-01');
  `)
  return sqlite
}

describe('buildMedicalSummary', () => {
  it('aggregates by category, counts active conditions, lists most-recent first', () => {
    const s = buildMedicalSummary(seed(), Date.parse('2026-07-05T12:00:00'))
    expect(s.hasData).toBe(true)
    expect(s.count).toBe(4)
    expect(s.byCategory).toEqual({ condition: 2, medication: 1, immunization: 1 })
    expect(s.activeConditions).toBe(1) // only 'Newer condition' is active
    expect(s.conditions.map((c) => c.description)).toEqual(['Newer condition', 'Older condition']) // date desc
    expect(s.medications.map((m) => m.description)).toEqual(['Metformin'])
    expect(s.immunizations.map((i) => i.description)).toEqual(['Influenza'])
    expect(s.firstDate).toBe('2020-01-01')
    expect(s.lastDate).toBe('2026-01-01')
  })

  it('is empty (never throws) with no table / no data', () => {
    expect(buildMedicalSummary(new Database(':memory:'))).toMatchObject({
      hasData: false,
      count: 0,
      activeConditions: 0,
      byCategory: {},
      conditions: []
    })
  })
})
