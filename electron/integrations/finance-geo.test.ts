import { describe, expect, it } from 'vitest'
import {
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
