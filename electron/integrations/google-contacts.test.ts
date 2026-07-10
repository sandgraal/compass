import { describe, expect, it, vi } from 'vitest'
import {
  ContactsScopeError,
  buildGoogleContactInputs,
  buildGoogleOtherContactInputs,
  fetchContactGroups,
  fetchGoogleConnections,
  fetchGoogleOtherContacts,
  googlePersonToContact
} from './google-contacts'

const jsonResp = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response

describe('googlePersonToContact', () => {
  it('maps the core fields to a google-sourced ContactInput', () => {
    const c = googlePersonToContact({
      resourceName: 'people/c123',
      names: [{ displayName: 'Jane Doe', givenName: 'Jane', familyName: 'Doe' }],
      emailAddresses: [{ value: 'jane@example.com', type: 'home' }],
      phoneNumbers: [{ value: '+15551234', type: 'mobile' }],
      organizations: [{ name: 'Acme', title: 'CTO' }]
    })
    expect(c).toEqual({
      externalId: 'people/c123',
      displayName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      middleName: null,
      prefix: null,
      suffix: null,
      org: 'Acme',
      jobTitle: 'CTO',
      emails: [{ type: 'home', value: 'jane@example.com' }],
      phones: [{ type: 'mobile', value: '+15551234' }],
      addresses: undefined,
      birthday: null,
      url: null,
      source: 'google'
    })
  })

  it('fills the extended name components (middle/prefix/suffix)', () => {
    const c = googlePersonToContact({
      names: [
        {
          displayName: 'Dr. John Q. Public Jr.',
          givenName: 'John',
          middleName: 'Quincy',
          familyName: 'Public',
          honorificPrefix: 'Dr.',
          honorificSuffix: 'Jr.'
        }
      ]
    })
    expect(c).toMatchObject({ middleName: 'Quincy', prefix: 'Dr.', suffix: 'Jr.' })
  })

  it('maps addresses into structured ContactAddress rows', () => {
    const c = googlePersonToContact({
      names: [{ displayName: 'Addr Person' }],
      addresses: [
        {
          type: 'home',
          streetAddress: '1 Main St',
          city: 'Springfield',
          region: 'IL',
          postalCode: '62701',
          country: 'USA'
        }
      ]
    })
    expect(c?.addresses).toEqual([
      {
        type: 'home',
        street: '1 Main St',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62701',
        country: 'USA'
      }
    ])
  })

  it('composes a birthday ISO date, with and without a year', () => {
    const withYear = googlePersonToContact({
      names: [{ displayName: 'A' }],
      birthdays: [{ date: { year: 1990, month: 3, day: 7 } }]
    })
    expect(withYear?.birthday).toBe('1990-03-07')
    const noYear = googlePersonToContact({
      names: [{ displayName: 'B' }],
      birthdays: [{ date: { month: 12, day: 1 } }]
    })
    expect(noYear?.birthday).toBe('--12-01')
  })

  it('mirrors the first url to `url` and keeps all urls in enrichment', () => {
    const c = googlePersonToContact({
      names: [{ displayName: 'Linky' }],
      urls: [
        { value: 'https://site.example', type: 'homepage' },
        { value: 'https://blog.example', type: 'blog' }
      ]
    })
    expect(c?.url).toBe('https://site.example')
    expect(c?.enrichment?.google?.urls).toEqual([
      { type: 'homepage', value: 'https://site.example' },
      { type: 'blog', value: 'https://blog.example' }
    ])
  })

  it('captures the rich fields into enrichment.google', () => {
    const c = googlePersonToContact({
      names: [{ displayName: 'Rich Person', phoneticFullName: 'Rich Person' }],
      organizations: [
        { name: 'Acme', title: 'CTO' },
        { name: 'SideCo', title: 'Advisor' }
      ],
      nicknames: [{ value: 'Richie' }],
      biographies: [{ value: 'Met at a conference' }],
      occupations: [{ value: 'Engineer' }],
      relations: [{ person: 'Sam', type: 'spouse' }],
      events: [{ date: { year: 2015, month: 6, day: 20 }, type: 'anniversary' }],
      imClients: [{ username: 'rich123', protocol: 'telegram' }],
      userDefined: [{ key: 'Referred by', value: 'Dana' }],
      photos: [
        { url: 'https://lh3.googleusercontent.com/silhouette', default: true },
        { url: 'https://lh3.googleusercontent.com/real-face', default: false }
      ],
      metadata: { sources: [{ updateTime: '2026-01-02T03:04:05Z' }] }
    })
    const g = c?.enrichment?.google
    expect(g?.nicknames).toEqual(['Richie'])
    expect(g?.biography).toBe('Met at a conference')
    expect(g?.occupations).toEqual(['Engineer'])
    expect(g?.relations).toEqual([{ person: 'Sam', type: 'spouse' }])
    expect(g?.importantDates).toEqual([{ type: 'anniversary', date: '2015-06-20' }])
    expect(g?.imHandles).toEqual([{ protocol: 'telegram', username: 'rich123' }])
    expect(g?.userDefined).toEqual([{ key: 'Referred by', value: 'Dana' }])
    expect(g?.organizations).toEqual([{ name: 'SideCo', title: 'Advisor' }]) // beyond the first
    expect(g?.phoneticName).toBe('Rich Person')
    expect(g?.updatedAt).toBe(Date.parse('2026-01-02T03:04:05Z'))
    // Photo BYTES are not fetched here — only the primary (non-default) URL.
    expect(g?.photoUrl).toBe('https://lh3.googleusercontent.com/real-face')
    expect(c?.photo).toBeUndefined()
  })

  it('resolves contact-group memberships into labels, dropping noise groups', () => {
    const groupNames = new Map([['contactGroups/friends', 'Friends']])
    const c = googlePersonToContact(
      {
        names: [{ displayName: 'Grouped' }],
        memberships: [
          { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
          { contactGroupMembership: { contactGroupResourceName: 'contactGroups/friends' } }
        ]
      },
      groupNames
    )
    expect(c?.enrichment?.google?.googleLabels).toEqual(['Friends'])
  })

  it('falls back to the email as display name when no name is present', () => {
    const c = googlePersonToContact({
      resourceName: 'people/c9',
      emailAddresses: [{ value: 'noname@example.com' }]
    })
    expect(c?.displayName).toBe('noname@example.com')
    expect(c?.emails?.[0]).toEqual({ type: 'other', value: 'noname@example.com' })
  })

  it('drops a connection with neither a name nor an email', () => {
    expect(googlePersonToContact({ phoneNumbers: [{ value: '+15550000' }] })).toBeNull()
  })

  it('leaves enrichment absent when there is nothing rich', () => {
    const c = googlePersonToContact({ names: [{ displayName: 'Plain' }] })
    expect(c?.enrichment).toBeUndefined()
  })
})

describe('fetchGoogleConnections', () => {
  it('requests the widened personFields mask', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ connections: [] }))
    await fetchGoogleConnections('tok', fetchImpl as unknown as typeof fetch)
    const calledUrl = String(fetchImpl.mock.calls[0][0])
    for (const field of ['birthdays', 'photos', 'addresses', 'urls', 'memberships', 'metadata']) {
      expect(calledUrl).toContain(field)
    }
  })

  it('accumulates across pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({ connections: [{ resourceName: 'a' }], nextPageToken: 'p2' })
      )
      .mockResolvedValueOnce(jsonResp({ connections: [{ resourceName: 'b' }] }))
    const people = await fetchGoogleConnections('tok', fetchImpl as unknown as typeof fetch)
    expect(people.map((p) => p.resourceName)).toEqual(['a', 'b'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws ContactsScopeError on a 403 (missing scope)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({}, 403))
    await expect(
      fetchGoogleConnections('tok', fetchImpl as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(ContactsScopeError)
  })

  it('throws a generic error on any other non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({}, 500))
    await expect(
      fetchGoogleConnections('tok', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('People API 500')
  })
})

describe('fetchContactGroups', () => {
  it('maps user groups to labels and drops noise system groups', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        contactGroups: [
          { resourceName: 'contactGroups/myContacts', formattedName: 'My Contacts' },
          { resourceName: 'contactGroups/friends', formattedName: 'Friends' },
          { resourceName: 'contactGroups/work', name: 'Work' }
        ]
      })
    )
    const map = await fetchContactGroups('tok', fetchImpl as unknown as typeof fetch)
    expect(map.get('contactGroups/friends')).toBe('Friends')
    expect(map.get('contactGroups/work')).toBe('Work')
    expect(map.has('contactGroups/myContacts')).toBe(false)
  })

  it('returns an empty map (never throws) when the request fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({}, 500))
    const map = await fetchContactGroups('tok', fetchImpl as unknown as typeof fetch)
    expect(map.size).toBe(0)
  })
})

describe('buildGoogleContactInputs', () => {
  it('maps, filters unusable connections, and resolves group labels', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/contactGroups')) {
        return Promise.resolve(
          jsonResp({
            contactGroups: [{ resourceName: 'contactGroups/friends', formattedName: 'Friends' }]
          })
        )
      }
      return Promise.resolve(
        jsonResp({
          connections: [
            {
              resourceName: 'a',
              names: [{ displayName: 'Jane Doe' }],
              memberships: [
                { contactGroupMembership: { contactGroupResourceName: 'contactGroups/friends' } }
              ]
            },
            { phoneNumbers: [{ value: '+1555' }] } // no name/email → dropped
          ]
        })
      )
    })
    const inputs = await buildGoogleContactInputs('tok', fetchImpl as unknown as typeof fetch)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].displayName).toBe('Jane Doe')
    expect(inputs[0].source).toBe('google')
    expect(inputs[0].enrichment?.google?.googleLabels).toEqual(['Friends'])
  })
})

describe('fetchGoogleOtherContacts', () => {
  it('uses the restricted readMask, paginates, and reports no truncation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({ otherContacts: [{ resourceName: 'o1' }], nextPageToken: 'p2' })
      )
      .mockResolvedValueOnce(jsonResp({ otherContacts: [{ resourceName: 'o2' }] }))
    const { people, truncated } = await fetchGoogleOtherContacts(
      'tok',
      fetchImpl as unknown as typeof fetch
    )
    expect(people.map((p) => p.resourceName)).toEqual(['o1', 'o2'])
    expect(truncated).toBe(false)
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/otherContacts')
    expect(url).toContain('readMask=names%2CemailAddresses%2CphoneNumbers%2Cmetadata')
    expect(url).toContain('sources=READ_SOURCE_TYPE_CONTACT')
    // The wide personFields mask must NOT be used here (Google 400s it).
    expect(url).not.toContain('birthdays')
  })

  it('surfaces Google’s error message (status + body) instead of swallowing it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResp(
          { error: { code: 403, status: 'PERMISSION_DENIED', message: 'insufficient scopes' } },
          403
        )
      )
    await expect(
      fetchGoogleOtherContacts('tok', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/otherContacts 403.*insufficient scopes/)
  })
})

describe('buildGoogleOtherContactInputs', () => {
  it("tags rows source:'google-other' and maps email-only rows via the email fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        otherContacts: [
          { resourceName: 'o1', emailAddresses: [{ value: 'emailed@example.com' }] }, // no name
          { resourceName: 'o2', names: [{ displayName: 'Pat Roe' }] }
        ]
      })
    )
    const { inputs } = await buildGoogleOtherContactInputs(
      'tok',
      fetchImpl as unknown as typeof fetch
    )
    expect(inputs).toHaveLength(2)
    expect(inputs.every((c) => c.source === 'google-other')).toBe(true)
    expect(inputs[0].displayName).toBe('emailed@example.com') // fallback to email
  })
})
