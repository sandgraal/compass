import { describe, expect, it } from 'vitest'
import { csvEscape, fromHeaderRow, matchHeader, parseCSV, serializeCsv } from './csv'

describe('parseCSV', () => {
  it('parses headers and rows into keyed objects', () => {
    const rows = parseCSV('name,phone\nAda,555-0100\nAlan,555-0199\n')
    expect(rows).toEqual([
      { name: 'Ada', phone: '555-0100' },
      { name: 'Alan', phone: '555-0199' }
    ])
  })

  it('handles quoted fields with embedded commas and newlines', () => {
    const rows = parseCSV('name,note\n"Lovelace, Ada","line1\nline2"\n')
    expect(rows[0].name).toBe('Lovelace, Ada')
    expect(rows[0].note).toBe('line1\nline2')
  })

  it('unescapes doubled quotes', () => {
    const rows = parseCSV('q\n"she said ""hi"""\n')
    expect(rows[0].q).toBe('she said "hi"')
  })

  it('returns [] for empty or header-only input', () => {
    expect(parseCSV('')).toEqual([])
    expect(parseCSV('only,headers')).toEqual([])
  })
})

describe('serializeCsv', () => {
  it('writes headers then rows in column order', () => {
    const out = serializeCsv([{ name: 'Ada', phone: '555' }], ['name', 'phone'])
    expect(out).toBe('name,phone\r\nAda,555\r\n')
  })

  it('quotes fields that contain commas, quotes, or newlines', () => {
    const out = serializeCsv([{ a: 'x,y', b: 'he said "hi"', c: 'l1\nl2' }], ['a', 'b', 'c'])
    expect(out).toContain('"x,y"')
    expect(out).toContain('"he said ""hi"""')
    expect(out).toContain('"l1\nl2"')
  })

  it('renders null/undefined/missing keys as empty fields', () => {
    const out = serializeCsv([{ a: null, b: undefined }], ['a', 'b', 'c'])
    expect(out).toBe('a,b,c\r\n,,\r\n')
  })

  it('round-trips through parseCSV', () => {
    const original = [
      { name: 'Ada, L', phone: '1' },
      { name: 'Alan', phone: '2' }
    ]
    const back = parseCSV(serializeCsv(original, ['name', 'phone']))
    expect(back).toEqual(original)
  })
})

describe('matchHeader', () => {
  it('matches case-insensitively and ignores stray whitespace, returning the real key', () => {
    const keys = [' Order ID ', 'Order Date', ' Product Name ']
    expect(matchHeader(keys, 'order id')).toBe(' Order ID ') // real (untrimmed) key back
    expect(matchHeader(keys, 'PRODUCT NAME')).toBe(' Product Name ')
  })

  it('honors priority order across the wanted names', () => {
    const keys = ['Item Total', 'Total Owed']
    // 'Total Owed' is listed first → wins even though 'Item Total' appears earlier.
    expect(matchHeader(keys, 'Total Owed', 'Item Total')).toBe('Total Owed')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchHeader(['a', 'b'], 'Order ID')).toBeUndefined()
  })
})

describe('fromHeaderRow', () => {
  it('drops preamble lines before the line matching all required tokens', () => {
    const text =
      'Account Statement\nAccount Activity\n,ID,Datetime,Amount (total)\n,1,2026-01-01,$5.00\n'
    const out = fromHeaderRow(text, 'Datetime', 'Amount (total)')
    expect(out.startsWith(',ID,Datetime,Amount (total)')).toBe(true)
    expect(parseCSV(out)).toHaveLength(1)
  })

  it('finds the header across CRLF and bare-CR line endings', () => {
    const rows = ['Title', 'Notes', ',ID,Datetime,Amount (total)', ',1,2026-01-01,$5.00']
    for (const eol of ['\r\n', '\r', '\n']) {
      const out = fromHeaderRow(rows.join(eol), 'Datetime', 'Amount (total)')
      expect(out.startsWith(',ID,Datetime,Amount (total)')).toBe(true)
      expect(parseCSV(out)).toHaveLength(1)
    }
  })

  it('returns the text unchanged when the header is line 0 or not found', () => {
    const already = 'a,b\n1,2\n'
    expect(fromHeaderRow(already, 'a', 'b')).toBe(already) // already line 0
    expect(fromHeaderRow(already, 'zzz')).toBe(already) // no match
  })
})

describe('csvEscape', () => {
  it('leaves plain values untouched', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape(42)).toBe('42')
    expect(csvEscape(null)).toBe('')
  })
})
