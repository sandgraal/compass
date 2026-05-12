import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { RawTxn } from './finance'
import {
  backfillTaxTags,
  classifyTax,
  shouldOverwrite,
  tagTax,
  taxYearFromDate
} from './finance-tax'

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

  it('tags CR + capex as capex-airbnb', () => {
    const tag = classifyTax({
      amount: -300,
      account: 'Enndustrious Checking',
      category: 'Property',
      subcategory: 'Construction — materials',
      geo: 'CR',
      purpose: 'capex'
    })
    expect(tag).toBe('tax:capex-airbnb')
  })

  it('CR + capex wins over Enndustrious — hardware purchased on the business card for the CR build is still real-estate capex', () => {
    const tag = classifyTax({
      amount: -300,
      account: 'Enndustrious Checking',
      category: 'Property',
      subcategory: 'Construction — materials',
      geo: 'CR',
      purpose: 'capex'
    })
    expect(tag).toBe('tax:capex-airbnb')
  })

  it('prioritizes CR + capex over Schedule C expense tagging', () => {
    const tag = classifyTax({
      amount: -45,
      account: 'enndustrious - chk',
      category: 'Software',
      subcategory: 'Subscriptions',
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

describe('backfillTaxTags', () => {
  function makeFixture(): Database.Database {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE finance_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        category TEXT,
        subcategory TEXT,
        notes TEXT,
        account_id INTEGER REFERENCES finance_accounts(id),
        geo TEXT NOT NULL DEFAULT 'US',
        purpose TEXT,
        tax_tag TEXT NOT NULL DEFAULT 'tax:none',
        tax_tag_source TEXT NOT NULL DEFAULT 'auto',
        tax_year INTEGER
      );
    `)
    sqlite
      .prepare("INSERT INTO finance_accounts (id, name) VALUES (1, 'Enndustrious Checking')")
      .run()
    sqlite.prepare("INSERT INTO finance_accounts (id, name) VALUES (2, 'Chase Sapphire')").run()
    return sqlite
  }

  it('reclassifies historical Enndustrious + Charity + CR-capex rows', () => {
    const sqlite = makeFixture()
    sqlite
      .prepare(
        `INSERT INTO finance_transactions (amount, category, subcategory, account_id, geo, purpose)
         VALUES
           (5000, 'Income', 'Consulting', 1, 'US', NULL),
           (-50, 'Charity', 'UNICEF', 2, 'US', NULL),
           (-300, 'Property', 'Construction — materials', 2, 'CR', 'capex'),
           (-25, 'Food & Drink', 'Restaurants', 2, 'US', NULL)`
      )
      .run()

    const result = backfillTaxTags(sqlite)
    expect(result.scanned).toBe(4)
    expect(result.updated).toBe(3) // food row stays at tax:none, no UPDATE

    const tags = sqlite.prepare('SELECT tax_tag FROM finance_transactions ORDER BY id').all() as {
      tax_tag: string
    }[]
    expect(tags.map((t) => t.tax_tag)).toEqual([
      'tax:schedule-c-income',
      'tax:charitable',
      'tax:capex-airbnb',
      'tax:none'
    ])
  })

  it('never overwrites user-tagged rows', () => {
    const sqlite = makeFixture()
    sqlite
      .prepare(
        `INSERT INTO finance_transactions
           (amount, category, account_id, geo, tax_tag, tax_tag_source)
         VALUES (-50, 'Charity', 2, 'US', 'tax:personal', 'user')`
      )
      .run()

    const result = backfillTaxTags(sqlite)
    expect(result.scanned).toBe(0) // user row excluded from scan
    const row = sqlite.prepare('SELECT tax_tag FROM finance_transactions').get() as {
      tax_tag: string
    }
    expect(row.tax_tag).toBe('tax:personal')
  })

  it('is idempotent — running twice updates nothing the second time', () => {
    const sqlite = makeFixture()
    sqlite
      .prepare(
        `INSERT INTO finance_transactions (amount, category, account_id, geo)
         VALUES (-50, 'Charity', 2, 'US')`
      )
      .run()

    const first = backfillTaxTags(sqlite)
    expect(first.updated).toBe(1)

    const second = backfillTaxTags(sqlite)
    expect(second.updated).toBe(0)
  })
})
