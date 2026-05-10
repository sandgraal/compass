/**
 * Unit tests for the PDF extractors. These exercise the post-extraction
 * text pipeline directly via `parsePdfText`, so they don't need real PDFs
 * (or `pdf-parse`/pdfjs in the test environment).
 *
 * Fixtures live in `__fixtures__/finance/` as .txt files representing what
 * `pdf-parse.getText()` would return for a synthetic statement.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  amexPdf,
  extractStatementMetadata,
  genericPdf,
  normalizeLines,
  parsePdfText,
  tryParseStatementDate,
  usaaPdf
} from './finance-pdf'

const FIXTURES = join(__dirname, '__fixtures__', 'finance')
const usaaText = readFileSync(join(FIXTURES, 'usaa-credit-statement.txt'), 'utf8')
const amexText = readFileSync(join(FIXTURES, 'amex-statement.txt'), 'utf8')

describe('tryParseStatementDate', () => {
  it('parses ISO YYYY-MM-DD', () => {
    expect(tryParseStatementDate('2026-04-03')).toBe('2026-04-03')
  })

  it('parses M/D/YYYY', () => {
    expect(tryParseStatementDate('4/3/2026')).toBe('2026-04-03')
  })

  it('parses M/D/YY (2-digit year, 2000s)', () => {
    expect(tryParseStatementDate('4/3/26')).toBe('2026-04-03')
  })

  it('parses "Apr 03 2026"', () => {
    expect(tryParseStatementDate('Apr 03 2026')).toBe('2026-04-03')
  })

  it('parses "Apr 03" with defaultYear', () => {
    expect(tryParseStatementDate('Apr 03', 2026)).toBe('2026-04-03')
  })

  it('rolls yearless dates back when the month is after the closing month', () => {
    expect(tryParseStatementDate('12/31', 2026, 1)).toBe('2025-12-31')
    expect(tryParseStatementDate('Dec 31', 2026, 1)).toBe('2025-12-31')
    expect(tryParseStatementDate('1/2', 2026, 1)).toBe('2026-01-02')
  })

  it('returns null for impossible yearless dates', () => {
    expect(tryParseStatementDate('2/30', 2026, 2)).toBeNull()
    expect(tryParseStatementDate('Feb 29', 2025, 2)).toBeNull()
    expect(tryParseStatementDate('Feb 29', 2024, 2)).toBe('2024-02-29')
  })

  it('returns null for "Apr 03" with no defaultYear', () => {
    expect(tryParseStatementDate('Apr 03')).toBeNull()
  })

  it('returns null for unrecognized strings', () => {
    expect(tryParseStatementDate('not a date')).toBeNull()
    expect(tryParseStatementDate('garbage-input')).toBeNull()
  })
})

describe('normalizeLines', () => {
  it('strips empty lines and trims whitespace', () => {
    const text = '  hello\n\n  world  \n\n'
    expect(normalizeLines(text)).toEqual(['hello', 'world'])
  })

  it('handles CRLF line endings', () => {
    expect(normalizeLines('a\r\nb\r\n')).toEqual(['a', 'b'])
  })
})

describe('USAA PDF extractor', () => {
  it('matches USAA fixture', () => {
    const lines = normalizeLines(usaaText)
    expect(usaaPdf.matches(lines)).toBe(true)
  })

  it('does not match non-USAA text', () => {
    const lines = normalizeLines('Some Other Bank\nstatement\nfoo')
    expect(usaaPdf.matches(lines)).toBe(false)
  })

  it('parses the USAA fixture into transactions', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.bank).toBe('USAA (PDF)')
    expect(result.txns.length).toBeGreaterThan(0)
    // Should pick up the "Transactions" section (9 charges) plus the
    // "Payments and Credits" payment line.
    expect(result.txns.length).toBe(10)
  })

  it('extracts last-four into the account', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.account).toBeDefined()
    expect(result.account?.lastFour).toBe('4321')
    expect(result.account?.institution).toBe('USAA')
    expect(result.account?.isDebt).toBe(true)
    expect(result.account?.type).toBe('credit')
  })

  it('produces ISO dates with the correct year from "Closing Date"', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    for (const txn of result.txns) {
      expect(txn.date).toMatch(/^2026-\d{2}-\d{2}$/)
    }
  })

  it('parses charges as negative amounts (expense convention)', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    const utility = result.txns.find((t) => t.description.includes('CITY OF AUSTIN'))
    expect(utility).toBeDefined()
    expect(utility?.amount).toBe(-142.87)
  })

  it('parses payment-credits with the correct sign', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    const payment = result.txns.find((t) => t.description === 'PAYMENT - THANK YOU')
    expect(payment).toBeDefined()
    // The fixture has "500.00-" (trailing minus = credit/payment).
    // parseMoney handles trailing minus → -500. The USAA extractor then flips
    // (amount = -amount) → +500, which is correct: a payment returns money to
    // the user (positive in the expense-negative convention).
    expect(payment?.amount).toBe(500)
  })

  it('skips section headers and totals (no junk rows)', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    for (const txn of result.txns) {
      expect(txn.description.toLowerCase()).not.toContain('balance')
      expect(txn.description.toLowerCase()).not.toContain('total')
    }
  })

  it('produces stable transaction hashes', () => {
    const a = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    const b = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(a.txns.map((t) => t.hash)).toEqual(b.txns.map((t) => t.hash))
  })

  it('ignores malformed closing months when deriving rollover context', () => {
    const malformedClosingMonth = [
      'USAA SAVINGS BANK',
      'Credit Card Statement',
      'Closing Date: 13/14/2026',
      '',
      'Transactions',
      '12/31  01/01  NEW YEARS EVE DINNER AUSTIN TX  98.76',
      '01/02  01/03  COFFEE SHOP AUSTIN TX  7.50'
    ].join('\n')

    const result = parsePdfText(malformedClosingMonth, '/tmp/usaa-malformed.pdf', 'USAA')

    expect(result.txns.map((t) => t.date)).toEqual(['2026-12-31', '2026-01-02'])
  })

  it('rolls December rows into the prior year for January-closing statements', () => {
    const crossYearUsaaText = [
      'USAA SAVINGS BANK',
      'Credit Card Statement',
      'Account ending in 4321',
      'Statement Period: 12/15/2025 - 01/14/2026',
      'Closing Date: 01/14/2026',
      '',
      'Transactions',
      '12/31  01/01  NEW YEARS EVE DINNER AUSTIN TX  98.76',
      '01/02  01/03  COFFEE SHOP AUSTIN TX  7.50'
    ].join('\n')

    const result = parsePdfText(crossYearUsaaText, '/tmp/usaa-cross-year.pdf', 'USAA')

    expect(result.bank).toBe('USAA (PDF)')
    expect(result.txns).toHaveLength(2)
    expect(result.txns.map((t) => t.date)).toEqual(['2025-12-31', '2026-01-02'])
  })
})

describe('AMEX PDF extractor', () => {
  it('matches AMEX fixture', () => {
    const lines = normalizeLines(amexText)
    expect(amexPdf.matches(lines)).toBe(true)
  })

  it('does not match non-AMEX text', () => {
    const lines = normalizeLines('Random Statement\nnothing here')
    expect(amexPdf.matches(lines)).toBe(false)
  })

  it('parses the AMEX fixture into transactions', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.bank).toBe('AMEX (PDF)')
    // 11 New Charges + 1 Payment = 12 transactions
    expect(result.txns.length).toBe(12)
  })

  it('extracts last-five into the account display name', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.account?.lastFour).toBe('31003')
    expect(result.account?.name).toBe('Amex Platinum (****31003)')
  })

  it('parses charges as negative and the payment as positive', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    const charge = result.txns.find((t) => t.description.includes('AMERICAN AIRLINES'))
    expect(charge?.amount).toBe(-487.2)
    const payment = result.txns.find((t) => t.description.includes('PAYMENT - THANK YOU'))
    // AMEX export: payment is -$2143.21 on the statement; we flip → +2143.21
    expect(payment?.amount).toBe(2143.21)
  })

  it('handles the "*" foreign-transaction marker after the date', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    const eurostar = result.txns.find((t) => t.description.includes('EUROSTAR'))
    expect(eurostar).toBeDefined()
    expect(eurostar?.amount).toBe(-312.45)
  })

  it('strips multiple spaces in descriptions', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    for (const txn of result.txns) {
      expect(txn.description).not.toMatch(/ {2,}/)
    }
  })
})

describe('Generic PDF extractor', () => {
  it('returns no transactions when fewer than 2 plausible rows are found', () => {
    const noisy = 'Random Document\n\n04/03/2026 lone line $99.00\n\nNothing else here.\n'
    const result = parsePdfText(noisy, '/tmp/random.pdf', 'unknown')
    expect(result.txns).toEqual([])
  })

  it('parses an unbranded statement-like text into transactions', () => {
    const generic = [
      'Some Tiny Bank',
      'Statement Period: 04/01/2026 - 04/30/2026',
      '',
      '04/02/2026 GROCERY STORE 12.34',
      '04/05/2026 GAS STATION 45.67',
      '04/10/2026 ONLINE SHOPPING 89.10',
      '04/15/2026 RESTAURANT 22.50',
      'Total: 169.61'
    ].join('\n')
    const result = parsePdfText(generic, '/tmp/tiny-bank.pdf', 'Tiny Bank')
    expect(result.bank).toBe('Generic (PDF)')
    expect(result.txns.length).toBe(4)
    expect(result.txns[0].notes).toBe('Generic-PDF-parsed — verify amount sign')
  })

  it('drops "balance" and "total" lines even if they look like transactions', () => {
    const generic = [
      'Statement 04/30/2026',
      '04/02/2026 LEGIT TXN 10.00',
      '04/05/2026 ANOTHER ONE 20.00',
      '04/06/2026 Previous Balance 999.99',
      '04/07/2026 New Balance 1234.56',
      '04/08/2026 Total Charges 50.00'
    ].join('\n')
    const result = parsePdfText(generic, '/tmp/g.pdf', 'g')
    const descs = result.txns.map((t) => t.description.toLowerCase())
    for (const d of descs) {
      expect(d).not.toContain('balance')
      expect(d).not.toContain('total')
    }
  })

  it('falls back to generic when no specific extractor matches', () => {
    // A fixture that doesn't contain "USAA" or "American Express"
    const text = [
      'Anonymous Bank',
      'Closing Date: 05/14/2026',
      '04/02/2026 FOO 10.00',
      '04/03/2026 BAR 20.00',
      '04/04/2026 BAZ 30.00'
    ].join('\n')
    const result = parsePdfText(text, '/tmp/x.pdf', 'Anonymous')
    expect(result.bank).toBe('Generic (PDF)')
    expect(result.txns.length).toBe(3)
  })
})

describe('parsePdfText dispatch', () => {
  it('routes USAA-shaped text to the USAA extractor', () => {
    expect(parsePdfText(usaaText, '/tmp/x.pdf', 'USAA').bank).toBe('USAA (PDF)')
  })

  it('routes AMEX-shaped text to the AMEX extractor', () => {
    expect(parsePdfText(amexText, '/tmp/x.pdf', 'amex').bank).toBe('AMEX (PDF)')
  })
})

// Sanity: confirm the generic extractor's matches() always returns true so it
// can serve as the fallback in the dispatch.
describe('extractor invariants', () => {
  it('generic always matches', () => {
    expect(genericPdf.matches([])).toBe(true)
    expect(genericPdf.matches(['anything'])).toBe(true)
  })
})

describe('statement metadata extraction (USAA)', () => {
  it('populates metadata on the ParsedFile', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata).toBeDefined()
  })

  it('extracts the new balance', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.balance).toBe(1284.55)
  })

  it('extracts the minimum payment', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.minimumPayment).toBe(42)
  })

  it('extracts the payment due date as ISO', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.paymentDueDate).toBe('2026-06-10')
  })

  it('extracts the credit limit', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.creditLimit).toBe(5000)
  })

  it('extracts the APR as a decimal', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.apr).toBeCloseTo(0.1899, 4)
  })

  it('extracts the statement closing date', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.statementClosingDate).toBe('2026-05-14')
  })

  it('extracts the statement period dates', () => {
    const result = parsePdfText(usaaText, '/tmp/usaa-credit-statement.pdf', 'USAA')
    expect(result.metadata?.statementPeriodStart).toBe('2026-04-15')
    expect(result.metadata?.statementPeriodEnd).toBe('2026-05-14')
  })
})

describe('statement metadata extraction (AMEX)', () => {
  it('populates metadata on the ParsedFile', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata).toBeDefined()
  })

  it('extracts the new balance', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.balance).toBe(1876.49)
  })

  it('extracts the minimum payment', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.minimumPayment).toBe(40)
  })

  it('extracts the payment due date as ISO', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.paymentDueDate).toBe('2026-05-27')
  })

  it('extracts the credit limit', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.creditLimit).toBe(25000)
  })

  it('extracts the APR as a decimal', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.apr).toBeCloseTo(0.2299, 4)
  })

  it('extracts the closing date', () => {
    const result = parsePdfText(amexText, '/tmp/amex-platinum.pdf', 'amex platinum')
    expect(result.metadata?.statementClosingDate).toBe('2026-04-30')
  })
})

describe('extractStatementMetadata (direct)', () => {
  it('returns an empty object when nothing matches', () => {
    expect(extractStatementMetadata('hello world')).toEqual({})
  })

  it('parses a simple synthetic statement', () => {
    const meta = extractStatementMetadata(
      [
        'Some Bank',
        'New Balance: $250.00',
        'Minimum Payment Due: $25.00',
        'Payment Due Date: 06/15/2026',
        'Credit Limit: $5,000.00',
        'APR: 19.99%'
      ].join('\n')
    )
    expect(meta).toMatchObject({
      balance: 250,
      minimumPayment: 25,
      paymentDueDate: '2026-06-15',
      creditLimit: 5000
    })
    expect(meta.apr).toBeCloseTo(0.1999, 4)
  })

  it('parses APR values even when the percent sign is omitted', () => {
    const meta = extractStatementMetadata('APR: 19.99')
    expect(meta.apr).toBeCloseTo(0.1999, 4)
  })

  it('treats absent fields as undefined (not zero)', () => {
    const meta = extractStatementMetadata('New Balance: $100.00')
    expect(meta.balance).toBe(100)
    expect(meta.minimumPayment).toBeUndefined()
    expect(meta.creditLimit).toBeUndefined()
    expect(meta.apr).toBeUndefined()
  })

  it('rejects sentinel APR values that fall outside [0, 1)', () => {
    // A line like "APR: 200%" would be obvious junk. Helper drops it.
    const meta = extractStatementMetadata('APR: 200%')
    expect(meta.apr).toBeUndefined()
  })
})

describe('Generic PDF metadata gating', () => {
  it('emits metadata when balance or minimum payment is found', () => {
    const generic = [
      'Tiny Bank',
      'Statement Period: 04/01/2026 - 04/30/2026',
      'New Balance: $123.45',
      '04/02/2026 GROCERY 12.34',
      '04/05/2026 GAS 45.67',
      '04/10/2026 SHOP 89.10'
    ].join('\n')
    const result = parsePdfText(generic, '/tmp/g.pdf', 'tiny')
    expect(result.metadata?.balance).toBe(123.45)
  })

  it('omits metadata when neither balance nor minimum payment was found', () => {
    const generic = [
      'Tiny Bank',
      'Statement 04/30/2026',
      '04/02/2026 LEGIT 10.00',
      '04/05/2026 ANOTHER 20.00',
      '04/06/2026 ALSO 30.00'
    ].join('\n')
    const result = parsePdfText(generic, '/tmp/g.pdf', 'tiny')
    expect(result.metadata).toBeUndefined()
  })
})
