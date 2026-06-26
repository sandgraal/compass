/**
 * People directory (Phase 10.7 "Connect"). Covers the per-source name extraction,
 * the cross-source collapse (the marquee "one person, many sources" behavior),
 * contact matching by normalized name, and the touchpoint-first sort.
 */

import { describe, expect, it } from 'vitest'
import {
  type ContactRow,
  type PersonSourceRow,
  buildPeople,
  extractPersonName,
  normalizeName
} from './people'

describe('extractPersonName', () => {
  it('pulls the person from each people-bearing title', () => {
    expect(extractPersonName('linkedin', 'connection', 'Connected with John Doe')).toBe('John Doe')
    expect(extractPersonName('linkedin', 'invitation', 'Invited Ana Lopez')).toBe('Ana Lopez')
    expect(extractPersonName('linkedin', 'invitation', 'Invitation from Sam Kim')).toBe('Sam Kim')
    expect(extractPersonName('linkedin', 'recommendation', 'Recommended Barbara Klein')).toBe(
      'Barbara Klein'
    )
    expect(extractPersonName('linkedin', 'recommendation', 'Recommendation from Lee Park')).toBe(
      'Lee Park'
    )
    expect(
      extractPersonName('linkedin', 'endorsement', 'Carlos Calderon endorsed you for SDLC')
    ).toBe('Carlos Calderon')
    expect(extractPersonName('facebook', 'connection', 'Became friends with Maria Cruz')).toBe(
      'Maria Cruz'
    )
  })

  it('returns null for records that do not name a person', () => {
    expect(extractPersonName('linkedin', 'endorsement', 'Endorsed for Leadership')).toBeNull()
    expect(extractPersonName('linkedin', 'job', 'Engineer at Acme')).toBeNull()
    expect(extractPersonName('netflix', 'watch', 'The Matrix')).toBeNull()
    expect(extractPersonName('facebook', 'post', 'Became a fan of something')).toBeNull()
  })
})

describe('normalizeName', () => {
  it('lowercases + collapses whitespace', () => {
    expect(normalizeName('  John   Doe ')).toBe('john doe')
  })
})

const MS = (iso: string): number => Date.parse(iso)

describe('buildPeople', () => {
  it('collapses the same person across sources into one entry', () => {
    const records: PersonSourceRow[] = [
      {
        source: 'linkedin',
        type: 'connection',
        title: 'Connected with John Doe',
        occurredAt: MS('2020-01-01T00:00:00Z')
      },
      {
        source: 'facebook',
        type: 'connection',
        title: 'Became friends with John Doe',
        occurredAt: MS('2015-06-01T00:00:00Z')
      },
      {
        source: 'linkedin',
        type: 'endorsement',
        title: 'John Doe endorsed you for SDLC',
        occurredAt: MS('2022-03-01T00:00:00Z')
      }
    ]
    const people = buildPeople(records, [])
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({
      name: 'John Doe',
      key: 'john doe',
      count: 3,
      sources: ['facebook', 'linkedin'] // distinct, sorted
    })
    expect(people[0].firstSeen).toBe(MS('2015-06-01T00:00:00Z')) // earliest touchpoint
    expect(people[0].lastSeen).toBe(MS('2022-03-01T00:00:00Z')) // latest touchpoint
    expect(people[0].contactId).toBeNull()
  })

  it('matches a person to a contact by normalized name', () => {
    const records: PersonSourceRow[] = [
      {
        source: 'linkedin',
        type: 'connection',
        title: 'Connected with Ada Lovelace',
        occurredAt: null
      }
    ]
    const contacts: ContactRow[] = [
      { id: 7, displayName: 'ada   lovelace' },
      { id: 8, displayName: 'Someone Else' }
    ]
    const [person] = buildPeople(records, contacts)
    expect(person.contactId).toBe(7) // normalized match despite casing/spacing
  })

  it('sorts by touchpoint count (then recency, then name) and ignores non-person records', () => {
    const records: PersonSourceRow[] = [
      {
        source: 'linkedin',
        type: 'connection',
        title: 'Connected with Solo One',
        occurredAt: MS('2021-01-01T00:00:00Z')
      },
      {
        source: 'linkedin',
        type: 'connection',
        title: 'Connected with Busy Two',
        occurredAt: MS('2019-01-01T00:00:00Z')
      },
      {
        source: 'linkedin',
        type: 'recommendation',
        title: 'Recommended Busy Two',
        occurredAt: MS('2023-01-01T00:00:00Z')
      },
      {
        source: 'netflix',
        type: 'watch',
        title: 'The Matrix',
        occurredAt: MS('2024-01-01T00:00:00Z')
      } // ignored
    ]
    const people = buildPeople(records, [])
    expect(people.map((p) => p.name)).toEqual(['Busy Two', 'Solo One']) // Busy Two has 2 touchpoints
  })
})
