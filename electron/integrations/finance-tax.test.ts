import { describe, expect, it } from 'vitest'
import type { RawTxn } from './finance'
import { classifyTax, shouldOverwrite, tagTax, taxYearFromDate } from './finance-tax'

describe('classifyTax', () => {
  it('tags Enndustrious deposits as schedule-c-income', () => {
    const tag = classifyTax({
      amount: 5000,
      account: 'Enndustrious Checking',
      category: 'Income',
      subcategory: 'Consulting',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:schedule-c-income')
  })

  it('tags Enndustrious withdrawals as schedule-c-expense', () => {
    const tag = classifyTax({
      amount: -120,
      account: 'enndustrious - chk',
      category: 'Software',
      subcategory: null,
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:schedule-c-expense')
  })

  it('does not tag Enndustrious internal transfers', () => {
    const tag = classifyTax({
      amount: -2000,
      account: 'Enndustrious Checking',
      category: 'Transfers',
      subcategory: null,
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:none')
  })

  it('tags CR + capex as capex-airbnb regardless of Enndustrious', () => {
    const tag = classifyTax({
      amount: -300,
      account: 'Amex Platinum',
      category: 'Property',
      subcategory: 'Construction — materials',
      geo: 'CR',
      purpose: 'capex'
    })
    expect(tag).toBe('tax:capex-airbnb')
  })

  it('tags Charity → charitable', () => {
    const tag = classifyTax({
      amount: -50,
      account: 'Chase',
      category: 'Charity',
      subcategory: 'UNICEF',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:charitable')
  })

  it('tags Gifts → charitable (charity-shaped giving)', () => {
    const tag = classifyTax({
      amount: -25,
      account: 'Chase',
      category: 'Gifts',
      subcategory: null,
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:charitable')
  })

  it('tags Investment category → investment', () => {
    const tag = classifyTax({
      amount: -500,
      account: 'Fidelity',
      category: 'Investment',
      subcategory: '401k',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:investment')
  })

  it('tags Health expenses → medical', () => {
    const tag = classifyTax({
      amount: -200,
      account: 'Chase',
      category: 'Health',
      subcategory: 'Doctor',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:medical')
  })

  it('does NOT tag Health credits as medical (insurance reimbursement)', () => {
    const tag = classifyTax({
      amount: 200,
      account: 'Chase',
      category: 'Health',
      subcategory: 'Insurance reimbursement',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:none')
  })

  it('does NOT tag Health credits as medical (positive amount, any subcategory)', () => {
    const tag = classifyTax({
      amount: 50,
      account: 'Chase',
      category: 'Health',
      subcategory: 'Doctor',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:none')
  })

  it('returns tax:none for ordinary consumption', () => {
    const tag = classifyTax({
      amount: -25,
      account: 'Chase',
      category: 'Food & Drink',
      subcategory: 'Restaurants',
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:none')
  })

  it('handles missing fields gracefully', () => {
    const tag = classifyTax({
      amount: -10,
      account: null,
      category: null,
      subcategory: null,
      geo: 'US',
      purpose: null
    })
    expect(tag).toBe('tax:none')
  })
})

describe('taxYearFromDate', () => {
  it('extracts year from ISO date', () => {
    expect(taxYearFromDate('2026-05-11')).toBe(2026)
    expect(taxYearFromDate('1999-12-31')).toBe(1999)
  })

  it('returns null for malformed dates', () => {
    expect(taxYearFromDate('05/11/2026')).toBeNull()
    expect(taxYearFromDate('2026')).toBeNull()
    expect(taxYearFromDate('')).toBeNull()
  })
})

describe('shouldOverwrite', () => {
  it('returns true for auto-tagged or unset rows', () => {
    expect(shouldOverwrite('auto')).toBe(true)
    expect(shouldOverwrite(null)).toBe(true)
    expect(shouldOverwrite(undefined)).toBe(true)
  })

  it('returns false for user-overridden rows', () => {
    expect(shouldOverwrite('user')).toBe(false)
  })
})

describe('tagTax', () => {
  it('tags a batch end-to-end', () => {
    const input: RawTxn[] = [
      {
        date: '2026-04-15',
        amount: -300,
        description: 'EPA CARTAGO',
        account: 'Amex Platinum',
        category: 'Property',
        subcategory: 'Construction — materials',
        sourceFile: 't.csv',
        hash: 'a',
        geo: 'CR',
        purpose: 'capex'
      },
      {
        date: '2026-04-10',
        amount: 5000,
        description: 'CLIENT DEPOSIT',
        account: 'Enndustrious Checking',
        category: 'Income',
        sourceFile: 't.csv',
        hash: 'b'
      }
    ]
    const out = tagTax(input)
    expect(out[0].taxTag).toBe('tax:capex-airbnb')
    expect(out[0].taxYear).toBe(2026)
    expect(out[1].taxTag).toBe('tax:schedule-c-income')
    expect(out[1].taxYear).toBe(2026)
  })

  it('preserves geo/purpose fields when adding tax tags', () => {
    const input: RawTxn[] = [
      {
        date: '2026-01-01',
        amount: -10,
        description: 'X',
        account: 'A',
        sourceFile: 't.csv',
        hash: 'x',
        geo: 'US',
        purpose: undefined,
        notes: 'rm:something'
      }
    ]
    const out = tagTax(input)
    expect(out[0].geo).toBe('US')
    expect(out[0].notes).toBe('rm:something')
    expect(out[0].taxTag).toBe('tax:none')
  })
})
