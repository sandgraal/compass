import { describe, expect, it, vi } from 'vitest'
import {
  ContactsScopeError,
  buildGoogleContactInputs,
  fetchGoogleConnections,
  googlePersonToContact
} from './google-contacts'

const jsonResp = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

describe('googlePersonToContact', () => {
  it('maps a full person to a google-sourced ContactInput', () => {
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
      org: 'Acme',
      jobTitle: 'CTO',
      emails: [{ type: 'home', value: 'jane@example.com' }],
      phones: [{ type: 'mobile', value: '+15551234' }],
      source: 'google'
    })
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
})

describe('fetchGoogleConnections', () => {
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

describe('buildGoogleContactInputs', () => {
  it('maps and filters out unusable connections', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResp({
        connections: [
          { resourceName: 'a', names: [{ displayName: 'Jane Doe' }] },
          { phoneNumbers: [{ value: '+1555' }] } // no name/email → dropped
        ]
      })
    )
    const inputs = await buildGoogleContactInputs('tok', fetchImpl as unknown as typeof fetch)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].displayName).toBe('Jane Doe')
    expect(inputs[0].source).toBe('google')
  })
})
