import { describe, expect, it } from 'vitest'
import { type ParsedContact, parseVCard, serializeVCard } from './vcard'

const SAMPLE_30 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;Augusta;Ms.;PhD',
  'ORG:Analytical Engine Co.;Research',
  'TITLE:Mathematician',
  'TEL;TYPE=CELL,VOICE,PREF:+1 555 0100',
  'TEL;TYPE=HOME:+1 555 0199',
  'EMAIL;TYPE=INTERNET,WORK:ada@example.com',
  'ADR;TYPE=HOME:;;12 Babbage Lane;London;;SW1;UK',
  'BDAY:1815-12-10',
  'URL:https://example.com/ada',
  'NOTE:First programmer\\, allegedly.',
  'UID:urn:uuid:ada-0001',
  'END:VCARD'
].join('\r\n')

describe('parseVCard', () => {
  it('parses a full vCard 3.0 card', () => {
    const [c] = parseVCard(SAMPLE_30)
    expect(c.displayName).toBe('Ada Lovelace')
    expect(c.familyName).toBe('Lovelace')
    expect(c.givenName).toBe('Ada')
    expect(c.middleName).toBe('Augusta')
    expect(c.prefix).toBe('Ms.')
    expect(c.suffix).toBe('PhD')
    expect(c.org).toBe('Analytical Engine Co.')
    expect(c.jobTitle).toBe('Mathematician')
    expect(c.phones).toEqual([
      { type: 'cell', value: '+1 555 0100', pref: true },
      { type: 'home', value: '+1 555 0199' }
    ])
    expect(c.emails).toEqual([{ type: 'work', value: 'ada@example.com' }])
    expect(c.addresses).toEqual([
      { type: 'home', street: '12 Babbage Lane', city: 'London', postalCode: 'SW1', country: 'UK' }
    ])
    expect(c.birthday).toBe('1815-12-10')
    expect(c.url).toBe('https://example.com/ada')
    expect(c.notes).toBe('First programmer, allegedly.')
    expect(c.externalId).toBe('urn:uuid:ada-0001')
  })

  it('parses multiple cards in one file', () => {
    const two = `${SAMPLE_30}\r\n${SAMPLE_30.replace('Ada Lovelace', 'Alan Turing').replace('ada-0001', 'alan-0002')}`
    const cards = parseVCard(two)
    expect(cards).toHaveLength(2)
    expect(cards[1].displayName).toBe('Alan Turing')
    expect(cards[1].externalId).toBe('urn:uuid:alan-0002')
  })

  it('falls back to N when FN is missing, and mints a UID when absent', () => {
    const card = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Hopper;Grace;;;', 'END:VCARD'].join('\r\n')
    const [c] = parseVCard(card)
    expect(c.displayName).toBe('Grace Hopper')
    expect(c.externalId).toMatch(/^urn:uuid:/)
  })

  it('unfolds folded continuation lines', () => {
    const folded = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Folded',
      'NOTE:This is a very long note that has been',
      '  folded across two physical lines',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(folded)
    expect(c.notes).toBe('This is a very long note that has been folded across two physical lines')
  })

  it('strips group prefixes like item1.TEL', () => {
    const grouped = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Grouped',
      'item1.TEL;TYPE=CELL:+1 555 7777',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(grouped)
    expect(c.phones).toEqual([{ type: 'cell', value: '+1 555 7777' }])
  })

  it('handles vCard 4.0 year-less BDAY and PREF param', () => {
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:NoYear',
      'BDAY:--0412',
      'TEL;PREF=1:+1 555 2222',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(v4)
    expect(c.birthday).toBe('--04-12')
    expect(c.phones[0]).toMatchObject({ value: '+1 555 2222', pref: true })
  })

  it('decodes a base64 PHOTO into a data URI', () => {
    const withPhoto = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Pic',
      'PHOTO;ENCODING=b;TYPE=PNG:aGVsbG8=',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(withPhoto)
    expect(c.photo).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('does NOT treat ENCODING=8bit as base64 (token match, not substring)', () => {
    const card = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:EightBit',
      'PHOTO;ENCODING=8bit:not-base64-data',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(card)
    expect(c.photo).toBeUndefined()
  })

  it('ignores a non-image PHOTO data URI', () => {
    const card = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Sneaky',
      'PHOTO;VALUE=uri:data:text/html;base64,PHNjcmlwdD4=',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(card)
    expect(c.photo).toBeUndefined()
  })

  it('drops a wholly empty ADR', () => {
    const card = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Empty',
      'ADR;TYPE=HOME:;;;;;;',
      'END:VCARD'
    ].join('\r\n')
    const [c] = parseVCard(card)
    expect(c.addresses).toEqual([])
  })
})

describe('serializeVCard', () => {
  it('round-trips every field through parse → serialize → parse', () => {
    const [original] = parseVCard(SAMPLE_30)
    const reparsed = parseVCard(serializeVCard([original]))[0]
    expect(reparsed.displayName).toBe(original.displayName)
    expect(reparsed.familyName).toBe(original.familyName)
    expect(reparsed.givenName).toBe(original.givenName)
    expect(reparsed.middleName).toBe(original.middleName)
    expect(reparsed.org).toBe(original.org)
    expect(reparsed.jobTitle).toBe(original.jobTitle)
    expect(reparsed.phones).toEqual(original.phones)
    expect(reparsed.emails).toEqual(original.emails)
    expect(reparsed.addresses).toEqual(original.addresses)
    expect(reparsed.birthday).toBe(original.birthday)
    expect(reparsed.url).toBe(original.url)
    expect(reparsed.notes).toBe(original.notes)
    expect(reparsed.externalId).toBe(original.externalId)
  })

  it('escapes commas, semicolons, and newlines in TEXT values', () => {
    const c: ParsedContact = {
      externalId: 'x',
      displayName: 'Comma, Semi; Newline',
      phones: [],
      emails: [],
      addresses: [],
      notes: 'line1\nline2, with; chars'
    }
    const out = serializeVCard([c])
    expect(out).toContain('FN:Comma\\, Semi\\; Newline')
    expect(out).toContain('NOTE:line1\\nline2\\, with\\; chars')
    // and it survives a re-parse
    const back = parseVCard(out)[0]
    expect(back.displayName).toBe('Comma, Semi; Newline')
    expect(back.notes).toBe('line1\nline2, with; chars')
  })

  it('round-trips a base64 photo', () => {
    const c: ParsedContact = {
      externalId: 'p',
      displayName: 'Pic',
      phones: [],
      emails: [],
      addresses: [],
      photo: 'data:image/jpeg;base64,QUJD'
    }
    const back = parseVCard(serializeVCard([c]))[0]
    expect(back.photo).toBe('data:image/jpeg;base64,QUJD')
  })

  it('folds output lines to 75 octets', () => {
    const c: ParsedContact = {
      externalId: 'f',
      displayName: 'F',
      phones: [],
      emails: [],
      addresses: [],
      notes: 'x'.repeat(200)
    }
    const out = serializeVCard([c])
    for (const line of out.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    }
  })

  it('emits VERSION 4.0 when requested', () => {
    const c: ParsedContact = {
      externalId: 'v',
      displayName: 'V',
      phones: [],
      emails: [],
      addresses: []
    }
    expect(serializeVCard([c], '4.0')).toContain('VERSION:4.0')
  })
})
