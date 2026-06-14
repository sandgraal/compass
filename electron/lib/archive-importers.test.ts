import { describe, expect, it } from 'vitest'
import {
  parseFacebookFriends,
  parseGoogleVoice,
  parseLinkedInConnections
} from './archive-importers'

describe('parseLinkedInConnections', () => {
  // Real Connections.csv ships with a Notes preamble before the header row.
  const csv = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the',
    'email addresses are missing. ..."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@example.com,Analytical Engine,Mathematician,01 Jan 2024',
    'Alan,Turing,https://www.linkedin.com/in/alan,,Bletchley,Cryptanalyst,02 Feb 2024'
  ].join('\n')

  it('skips the Notes preamble and maps columns', () => {
    const out = parseLinkedInConnections(csv)
    expect(out).toHaveLength(2)
    const ada = out[0]
    expect(ada.displayName).toBe('Ada Lovelace')
    expect(ada.org).toBe('Analytical Engine')
    expect(ada.jobTitle).toBe('Mathematician')
    expect(ada.url).toBe('https://www.linkedin.com/in/ada')
    expect(ada.emails).toEqual([{ value: 'ada@example.com' }])
    expect(ada.relationship).toBe('colleague')
    expect(ada.source).toBe('linkedin')
    expect(ada.externalId).toBe('linkedin:https://www.linkedin.com/in/ada')
    expect(ada.notes).toMatch(/01 Jan 2024/)
  })

  it('keeps an email-less connection (privacy redaction) and uses URL as the key', () => {
    const out = parseLinkedInConnections(csv)
    expect(out[1].displayName).toBe('Alan Turing')
    expect(out[1].emails).toBeUndefined()
    expect(out[1].externalId).toBe('linkedin:https://www.linkedin.com/in/alan')
  })

  it('returns [] when there is no header row', () => {
    expect(parseLinkedInConnections('just,some,random\n1,2,3')).toEqual([])
  })
})

describe('parseFacebookFriends', () => {
  it('parses friends_v2 with timestamps', () => {
    const json = JSON.stringify({
      friends_v2: [
        { name: 'Grace Hopper', timestamp: 1577836800 }, // 2020-01-01
        { name: 'Katherine Johnson' }
      ]
    })
    const out = parseFacebookFriends(json)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      displayName: 'Grace Hopper',
      relationship: 'friend',
      source: 'facebook',
      externalId: 'facebook:grace hopper'
    })
    expect(out[0].notes).toMatch(/2020-01-01/)
    expect(out[1].notes).toBeUndefined()
  })

  it('parses an uploaded address book with phone numbers', () => {
    const json = JSON.stringify({
      address_book_v2: {
        address_book: [{ name: 'Mom', details: [{ contact_point: '+1 555 0100' }] }]
      }
    })
    const out = parseFacebookFriends(json)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ displayName: 'Mom', source: 'facebook' })
    expect(out[0].phones).toEqual([{ value: '+1 555 0100' }])
  })

  it('returns [] on malformed JSON', () => {
    expect(parseFacebookFriends('{not json')).toEqual([])
  })
})

describe('parseGoogleVoice', () => {
  it('extracts a unique contact per number, preferring the markup name', () => {
    const files = [
      {
        name: 'Grace Hopper - Text - 2024-01-01.html',
        content:
          '<cite class="sender vcard"><a class="tel" href="tel:+15550100"><abbr class="fn">Grace Hopper</abbr></a></cite>' +
          '<a class="tel" href="tel:+15550100"><abbr class="fn"></abbr></a>'
      },
      {
        name: '+15550199 - Text - 2024-02-02.html',
        content: '<a class="tel" href="tel:+15550199"><abbr class="fn"></abbr></a>'
      }
    ]
    const out = parseGoogleVoice(files)
    expect(out).toHaveLength(2)
    const grace = out.find((c) => c.phones?.[0].value === '+15550100')
    expect(grace?.displayName).toBe('Grace Hopper')
    expect(grace?.source).toBe('gvoice')
    expect(grace?.externalId).toBe('gvoice:+15550100')
    // No name anywhere → falls back to the number as the display name.
    const unknown = out.find((c) => c.phones?.[0].value === '+15550199')
    expect(unknown?.displayName).toBe('+15550199')
  })

  it('falls back to the filename name hint when the markup fn is empty', () => {
    const out = parseGoogleVoice([
      {
        name: 'Aunt May - Text - 2024.html',
        content: '<a class="tel" href="tel:+15551234567"><abbr class="fn"></abbr></a>'
      }
    ])
    expect(out[0].displayName).toBe('Aunt May')
  })

  it('dedupes the same number across files', () => {
    const out = parseGoogleVoice([
      { name: 'a.html', content: '<a class="tel" href="tel:+15550100">x' },
      { name: 'b.html', content: '<a class="tel" href="tel:+1 555-0100">y' }
    ])
    expect(out).toHaveLength(1)
  })
})
