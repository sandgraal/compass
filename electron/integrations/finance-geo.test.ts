import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  backfillGeoFromNotes,
  classifyGeo,
  classifyPurpose,
  parseNotesTags,
  tagGeoAndPurpose,
  upsertNotesTags
} from './finance-geo'

describe('classifyGeo', () => {
  it('detects CR by city name', () => {
    expect(classifyGeo('SUPERMERCADO LA LEYENDA CARTAGO')).toBe('CR')
    expect(classifyGeo('BAR REST CABINAS LAS VE JIMENEZ')).toBe('CR')
    expect(classifyGeo('BANCO POPULAR C SAN JOSE')).toBe('CR')
  })

  it('detects CR by Spanish merchant token even without city', () => {
    expect(classifyGeo('FERRETERIA PEJIBAYE')).toBe('CR')
    expect(classifyGeo('CARNICERIA LA FAVORITA')).toBe('CR')
  })

  it('US wins over CR when both patterns appear', () => {
    expect(classifyGeo('PAI ATM WEST PALM BEACH')).toBe('US')
  })

  it('detects Spain', () => {
    expect(classifyGeo('IBIS ALCOBENDAS 0662 ALCOBENDAS')).toBe('SPAIN')
  })

  it('detects Colombia', () => {
    expect(classifyGeo('BANCOLOMBIA ANTIOQUIA')).toBe('COLOMBIA')
  })

  it('defaults unknown to US', () => {
    expect(classifyGeo('STARBUCKS STORE 12345')).toBe('US')
  })
})

describe('classifyPurpose', () => {
  it('returns empty for non-CR txns', () => {
    expect(classifyPurpose('US', 'Food & Drink', 'Groceries', 'WHOLE FOODS')).toBe('')
  })

  it('marks CR Property as capex', () => {
    expect(
      classifyPurpose('CR', 'Property', 'Construction — materials', 'FERRETERIA PEJIBAYE CARTAGO')
    ).toBe('capex')
  })

  it('marks CR groceries as household', () => {
    expect(classifyPurpose('CR', 'Food & Drink', 'Groceries', 'SUPERMERCADO LA LEYENDA')).toBe(
      'household'
    )
  })

  it('marks CR ATM withdrawals as operating', () => {
    expect(classifyPurpose('CR', 'Cash', 'ATM withdrawal', '020004031 CARTAGO')).toBe('operating')
  })

  it('marks CR travel as travel', () => {
    expect(classifyPurpose('CR', 'Travel', 'Hotel', 'HOTEL LE BERGERAC SAN JOSE')).toBe('travel')
  })

  it('falls through to "other" for uncategorized CR txns', () => {
    expect(classifyPurpose('CR', 'Uncategorized', '', 'OBSCURE CARTAGO MERCHANT')).toBe('other')
  })

  it('description hint promotes ferreteria-style merchants to capex even without category', () => {
    expect(classifyPurpose('CR', 'Uncategorized', '', 'FERRETERIA SOMETHING NEW')).toBe('capex')
  })
})

describe('upsertNotesTags / parseNotesTags', () => {
  it('writes new tags when notes is empty', () => {
    expect(upsertNotesTags(null, 'CR', 'capex')).toBe('geo:CR | purpose:capex')
  })

  it('preserves free-form notes alongside tags', () => {
    const out = upsertNotesTags('rm:Groceries', 'CR', 'household')
    expect(out).toContain('rm:Groceries')
    expect(out).toContain('geo:CR')
    expect(out).toContain('purpose:household')
  })

  it('replaces existing tags rather than duplicating them (idempotent)', () => {
    const first = upsertNotesTags('rm:Foo | geo:US', 'CR', 'capex')
    const second = upsertNotesTags(first, 'CR', 'capex')
    expect(first).toBe(second)
    // No double geo: token
    expect((first.match(/geo:/g) ?? []).length).toBe(1)
  })

  it('parses tags back out cleanly', () => {
    const parsed = parseNotesTags('rm:Groceries | geo:CR | purpose:household')
    expect(parsed.geo).toBe('CR')
    expect(parsed.purpose).toBe('household')
    expect(parsed.rest).toBe('rm:Groceries')
  })
})

describe('tagGeoAndPurpose', () => {
  it('tags a batch end-to-end', () => {
    const out = tagGeoAndPurpose([
      {
        date: '2026-04-15',
        amount: -50,
        description: 'FERRETERIA PEJIBAYE CARTAGO',
        account: 'Amex Platinum',
        category: 'Property',
        subcategory: 'Construction — materials',
        sourceFile: 't.csv',
        hash: 'a',
        notes: 'rm:Home & Garden'
      }
    ])
    expect(out[0].geo).toBe('CR')
    expect(out[0].purpose).toBe('capex')
    // notes should be unmodified — geo/purpose are now separate fields
    expect(out[0].notes).toBe('rm:Home & Garden')
  })
})

describe('backfillGeoFromNotes', () => {
  function setup(): Database.Database {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notes TEXT,
        geo TEXT NOT NULL DEFAULT 'US',
        purpose TEXT
      );
    `)
    return db
  }

  it('updates rows whose notes carry geo:X but column is still default US', () => {
    const db = setup()
    db.prepare(
      "INSERT INTO finance_transactions (notes) VALUES ('rm:Home & Garden | geo:CR | purpose:capex')"
    ).run()
    db.prepare("INSERT INTO finance_transactions (notes) VALUES ('rm:Shopping | geo:SPAIN')").run()
    db.prepare(
      "INSERT INTO finance_transactions (notes) VALUES ('rm:Auto & Transport | geo:US')"
    ).run()

    const counts = backfillGeoFromNotes(db)

    expect(counts['geo:CR']).toBe(1)
    expect(counts['geo:SPAIN']).toBe(1)
    expect(counts['purpose:capex']).toBe(1)
    // US row already at US — no change to count for it
    expect(counts['geo:US']).toBeUndefined()

    const rows = db
      .prepare('SELECT geo, purpose FROM finance_transactions ORDER BY id')
      .all() as Array<{
      geo: string
      purpose: string | null
    }>
    expect(rows).toEqual([
      { geo: 'CR', purpose: 'capex' },
      { geo: 'SPAIN', purpose: null },
      { geo: 'US', purpose: null }
    ])
  })

  it('is idempotent — second run reports no changes', () => {
    const db = setup()
    db.prepare(
      "INSERT INTO finance_transactions (notes) VALUES ('rm:Foo | geo:CR | purpose:capex')"
    ).run()

    backfillGeoFromNotes(db)
    const second = backfillGeoFromNotes(db)

    expect(second).toEqual({})
  })

  it('does not touch a user-set geo that disagrees with notes', () => {
    // Edge case: row's notes say geo:CR but the column was manually set to
    // OTHER (e.g. user override). The backfill should still overwrite it —
    // notes are the historical truth and the user has the geo dropdown in
    // the UI to correct that downstream. The point of this test is just to
    // document the chosen direction.
    const db = setup()
    db.prepare(
      "INSERT INTO finance_transactions (notes, geo) VALUES ('rm:Foo | geo:CR', 'OTHER')"
    ).run()

    backfillGeoFromNotes(db)

    const row = db.prepare('SELECT geo FROM finance_transactions').get() as { geo: string }
    expect(row.geo).toBe('CR')
  })

  it('returns empty object when nothing to backfill', () => {
    const db = setup()
    // Plain US row with no geo tag in notes
    db.prepare("INSERT INTO finance_transactions (notes, geo) VALUES ('plain note', 'US')").run()

    expect(backfillGeoFromNotes(db)).toEqual({})
  })
})
