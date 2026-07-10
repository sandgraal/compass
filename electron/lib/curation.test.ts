/**
 * Curation exclusions helpers — real in-memory SQLite, including the
 * absent-table safety contract (a mid-upgrade DB must behave as "no
 * exclusions", never throw).
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  addExclusions,
  clearExclusions,
  countExclusions,
  loadExclusionSet,
  removeExclusion
} from './curation'

let sqlite: Database.Database
const db = () => drizzle(sqlite, { schema })

const DDL = `CREATE TABLE curation_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER
);
CREATE UNIQUE INDEX curation_exclusions_kind_target ON curation_exclusions (kind, target);`

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
})
afterEach(() => sqlite.close())

describe('curation exclusions', () => {
  it('round-trips targets through add + load, unioned across kinds', () => {
    addExclusions(db(), 'contact-tombstone', ['people/c1', '  people/c2  '])
    addExclusions(db(), 'contact-merged', ['csv:loser|x'])
    const set = loadExclusionSet(db(), ['contact-tombstone', 'contact-merged'])
    expect(set.has('people/c1')).toBe(true)
    expect(set.has('people/c2')).toBe(true) // trimmed
    expect(set.has('csv:loser|x')).toBe(true)
    // Kind-scoped load excludes the other kind.
    expect(loadExclusionSet(db(), ['contact-tombstone']).has('csv:loser|x')).toBe(false)
  })

  it('re-adding the same (kind, target) is a no-op (unique index + onConflictDoNothing)', () => {
    addExclusions(db(), 'entity:person', ['jane doe'])
    addExclusions(db(), 'entity:person', ['jane doe'])
    expect(countExclusions(db())['entity:person']).toBe(1)
  })

  it('skips empty/whitespace targets', () => {
    addExclusions(db(), 'entity:person', ['', '   '])
    expect(countExclusions(db())['entity:person']).toBeUndefined()
  })

  it('removeExclusion deletes exactly one (kind, target)', () => {
    addExclusions(db(), 'contact-tombstone', ['a', 'b'])
    removeExclusion(db(), 'contact-tombstone', 'a')
    const set = loadExclusionSet(db(), ['contact-tombstone'])
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
  })

  it('clearExclusions empties one kind and reports the count', () => {
    addExclusions(db(), 'contact-tombstone', ['a', 'b'])
    addExclusions(db(), 'entity:person', ['jane'])
    expect(clearExclusions(db(), 'contact-tombstone')).toBe(2)
    expect(loadExclusionSet(db(), ['contact-tombstone']).size).toBe(0)
    expect(loadExclusionSet(db(), ['entity:person']).size).toBe(1) // untouched
  })

  it('is graceful when the table is absent (mid-upgrade DB)', () => {
    sqlite.exec('DROP TABLE curation_exclusions')
    expect(() => addExclusions(db(), 'contact-tombstone', ['x'])).not.toThrow()
    expect(loadExclusionSet(db(), ['contact-tombstone']).size).toBe(0)
    expect(clearExclusions(db(), 'contact-tombstone')).toBe(0)
    expect(countExclusions(db())).toEqual({})
    expect(() => removeExclusion(db(), 'contact-tombstone', 'x')).not.toThrow()
  })
})
