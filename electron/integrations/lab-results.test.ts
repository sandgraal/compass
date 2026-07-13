import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { buildLabResultsSummary } from './lab-results'

function seed(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE lab_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, test_name TEXT NOT NULL, panel TEXT,
      value REAL, value_text TEXT, unit TEXT, ref_range TEXT, flag TEXT,
      taken_at TEXT NOT NULL, encounter_id TEXT, source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT, created_at INTEGER
    );
    INSERT INTO lab_results (test_name, panel, value, unit, ref_range, flag, taken_at, encounter_id) VALUES
      ('Troponin T High Sens', 'Troponin I Cardiac', 239, 'ng/L', '<12 ng/L', 'critical-high', '2026-04-16', 'enc-1'),
      ('Troponin T High Sens', 'Troponin I Cardiac', 252, 'ng/L', '<12 ng/L', 'critical-high', '2026-04-16', 'enc-1'),
      ('Troponin T High Sens', 'Troponin I Cardiac', 216, 'ng/L', '<12 ng/L', 'critical-high', '2026-04-16', 'enc-1'),
      ('Cholesterol', 'Coronary Risk Profile', 305, 'mg/dL', '<200 mg/dL', 'high', '2026-04-17', 'enc-1'),
      ('Sodium', 'Chem 7 Profile', 137, 'mmol/L', '136-145 mmol/L', 'normal', '2026-04-17', 'enc-1');
  `)
  return sqlite
}

describe('buildLabResultsSummary', () => {
  it('groups by test name into a trend, latest-value-first for abnormal tests', () => {
    const s = buildLabResultsSummary(seed())
    expect(s.hasData).toBe(true)
    expect(s.count).toBe(5)
    expect(s.abnormalCount).toBe(4) // 3 troponin draws + cholesterol; sodium is normal
    expect(s.lastDate).toBe('2026-04-17')
    expect(s.series).toHaveLength(3) // Troponin, Cholesterol, Sodium

    const troponin = s.series.find((r) => r.testName === 'Troponin T High Sens')
    expect(troponin?.history).toHaveLength(3)
    expect(troponin?.latest.value).toBe(216) // most recent draw, not the highest
    expect(troponin?.latest.flag).toBe('critical-high')

    // Abnormal-latest tests sort ahead of the normal one.
    expect(s.series[s.series.length - 1].testName).toBe('Sodium')
  })

  it('is empty (never throws) with no table / no data', () => {
    expect(buildLabResultsSummary(new Database(':memory:'))).toMatchObject({
      hasData: false,
      count: 0,
      abnormalCount: 0,
      series: []
    })
  })

  it('caps history length per test', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE lab_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, test_name TEXT NOT NULL, panel TEXT,
        value REAL, value_text TEXT, unit TEXT, ref_range TEXT, flag TEXT,
        taken_at TEXT NOT NULL, encounter_id TEXT, source TEXT NOT NULL DEFAULT 'manual',
        notes TEXT, created_at INTEGER
      );
    `)
    const insert = sqlite.prepare(
      'INSERT INTO lab_results (test_name, value, taken_at, flag) VALUES (?, ?, ?, ?)'
    )
    for (let i = 0; i < 20; i++) {
      insert.run('Glucose', 90 + i, `2026-01-${String(i + 1).padStart(2, '0')}`, 'normal')
    }
    const s = buildLabResultsSummary(sqlite, 5)
    expect(s.series[0].history).toHaveLength(5)
    expect(s.series[0].latest.value).toBe(109) // day 20, the most recent
  })
})
