import { describe, expect, it } from 'vitest'
import { type ContactLike, buildRelationshipsMarkdown } from './contacts-extractor'

const STAMP = '2026-06-14 10:00:00'

describe('buildRelationshipsMarkdown', () => {
  it('renders an empty-state placeholder when there are no contacts', () => {
    const md = buildRelationshipsMarkdown([], STAMP)
    expect(md).toContain('# People & Relationships')
    expect(md).toContain('No contacts yet')
  })

  it('groups contacts by relationship bucket in a stable order', () => {
    const contacts: ContactLike[] = [
      { displayName: 'Zoe Friend', relationship: 'friend' },
      { displayName: 'Mom', relationship: 'family' },
      { displayName: 'Coworker Carl', relationship: 'colleague' },
      { displayName: 'Random Person', relationship: '' }
    ]
    const md = buildRelationshipsMarkdown(contacts, STAMP)
    expect(md).toContain('## Family')
    expect(md).toContain('## Friend')
    expect(md).toContain('## Colleague')
    expect(md).toContain('## Other')
    // Family bucket must come before Friend (stable GROUP_ORDER).
    expect(md.indexOf('## Family')).toBeLessThan(md.indexOf('## Friend'))
    expect(md).toContain('**4** contacts on file.')
  })

  it('sorts members alphabetically within a bucket and renders a one-liner', () => {
    const contacts: ContactLike[] = [
      {
        displayName: 'Beth',
        relationship: 'friend',
        org: 'Acme',
        jobTitle: 'CTO',
        phones: [{ value: '+1 555 0100' }],
        emails: [{ value: 'beth@example.com' }],
        birthday: '1990-02-02'
      },
      { displayName: 'Ada', relationship: 'friend' }
    ]
    const md = buildRelationshipsMarkdown(contacts, STAMP)
    expect(md.indexOf('Ada')).toBeLessThan(md.indexOf('Beth'))
    expect(md).toContain('**Beth** · CTO, Acme · +1 555 0100 · beth@example.com · 🎂 1990-02-02')
  })

  it('treats coworker/business synonyms as their canonical buckets', () => {
    const md = buildRelationshipsMarkdown(
      [
        { displayName: 'A', relationship: 'co-worker' },
        { displayName: 'B', relationship: 'business partner' }
      ],
      STAMP
    )
    expect(md).toContain('## Colleague')
    expect(md).toContain('## Work')
  })
})
