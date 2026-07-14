import { describe, expect, it } from 'vitest'
import {
  type EnrichmentRecordHit,
  computeCrossSourceSummary,
  isEmptySummary,
  mergeEnrichment,
  parseEnrichment
} from './contact-enrichment'

const hit = (over: Partial<EnrichmentRecordHit> & { recordId: number }): EnrichmentRecordHit => ({
  source: 'gmail',
  type: 'email',
  title: 'Re: lunch',
  occurredAt: 1000,
  matchedVia: 'email',
  ...over
})

describe('computeCrossSourceSummary', () => {
  it('summarizes a name-only match from the derived person entity', () => {
    const s = computeCrossSourceSummary(
      { sources: ['linkedin', 'facebook'], count: 4, firstSeen: 10, lastSeen: 90 },
      [],
      500
    )
    expect(s.sources).toEqual(['facebook', 'linkedin']) // sorted
    expect(s.touchpointCount).toBe(4)
    expect(s.firstSeen).toBe(10)
    expect(s.lastSeen).toBe(90)
    expect(s.matchedBy).toEqual(['name'])
    expect(s.lastActivity).toBeNull() // cache pass has no per-record detail
    expect(s.refreshedAt).toBe(500)
  })

  it('summarizes an email-only match from record hits (no entity)', () => {
    const s = computeCrossSourceSummary(
      null,
      [
        hit({ recordId: 1, source: 'gmail', occurredAt: 100 }),
        hit({ recordId: 2, source: 'gcal', type: 'event', title: 'Coffee', occurredAt: 300 })
      ],
      500
    )
    expect(s.sources).toEqual(['gcal', 'gmail'])
    expect(s.touchpointCount).toBe(2)
    expect(s.firstSeen).toBe(100)
    expect(s.lastSeen).toBe(300)
    expect(s.matchedBy).toEqual(['email'])
    expect(s.lastActivity).toMatchObject({ recordId: 2, source: 'gcal', title: 'Coffee' })
  })

  it('unions sources and takes the larger count (no double-count) across both inputs', () => {
    const s = computeCrossSourceSummary(
      { sources: ['gmail'], count: 5, firstSeen: 50, lastSeen: 200 },
      [
        hit({ recordId: 1, source: 'gmail', matchedVia: 'name', occurredAt: 60 }),
        hit({ recordId: 2, source: 'venmo', matchedVia: 'email', occurredAt: 400 })
      ],
      500
    )
    expect(s.sources).toEqual(['gmail', 'venmo'])
    // max(entity.count=5, distinctHits=2) = 5 — not 7
    expect(s.touchpointCount).toBe(5)
    expect(s.firstSeen).toBe(50)
    expect(s.lastSeen).toBe(400)
    expect(s.matchedBy).toEqual(['name', 'email'])
    expect(s.lastActivity?.recordId).toBe(2)
  })

  it('dedups record hits by recordId', () => {
    const s = computeCrossSourceSummary(
      null,
      [
        hit({ recordId: 7, matchedVia: 'name', occurredAt: 100 }),
        hit({ recordId: 7, matchedVia: 'email', occurredAt: 100 })
      ],
      1
    )
    expect(s.touchpointCount).toBe(1)
    expect(s.matchedBy).toEqual(['name', 'email'])
  })

  it('tags phone-channel matches', () => {
    const s = computeCrossSourceSummary(
      null,
      [hit({ recordId: 1, source: 'imessage', type: 'message', matchedVia: 'phone' })],
      1
    )
    expect(s.matchedBy).toEqual(['phone'])
  })

  it('returns an empty summary when nothing matches', () => {
    const s = computeCrossSourceSummary(null, [], 1)
    expect(s).toMatchObject({ sources: [], touchpointCount: 0, lastActivity: null, matchedBy: [] })
    expect(isEmptySummary(s)).toBe(true)
  })
})

describe('mergeEnrichment', () => {
  it('preserves the google block when patching crossSource', () => {
    const existing = { google: { nicknames: ['Bob'] } }
    const merged = mergeEnrichment(existing, {
      crossSource: {
        sources: ['gmail'],
        touchpointCount: 1,
        firstSeen: null,
        lastSeen: null,
        lastActivity: null,
        matchedBy: ['email'],
        refreshedAt: 1
      }
    })
    expect(merged.google?.nicknames).toEqual(['Bob'])
    expect(merged.crossSource?.sources).toEqual(['gmail'])
  })

  it('preserves the crossSource block when patching google', () => {
    const existing = {
      crossSource: {
        sources: ['gcal'],
        touchpointCount: 2,
        firstSeen: null,
        lastSeen: null,
        lastActivity: null,
        matchedBy: ['name' as const],
        refreshedAt: 1
      }
    }
    const merged = mergeEnrichment(existing, { google: { biography: 'hi' } })
    expect(merged.crossSource?.sources).toEqual(['gcal'])
    expect(merged.google?.biography).toBe('hi')
  })

  const WEB = {
    searchedAs: 'Jane Doe (Acme)',
    matchConfidence: 'high' as const,
    bio: null,
    location: null,
    links: [{ value: 'https://github.com/jane' }],
    facts: [],
    sources: [{ url: 'https://acme.com/team' }],
    refreshedAt: 5
  }

  it('preserves google + crossSource when patching web', () => {
    const existing = { google: { nicknames: ['Bob'] } }
    const merged = mergeEnrichment(existing, { web: WEB })
    expect(merged.google?.nicknames).toEqual(['Bob'])
    expect(merged.web?.searchedAs).toBe('Jane Doe (Acme)')
  })

  it('preserves web when patching the other namespaces', () => {
    const existing = { web: WEB }
    const merged = mergeEnrichment(existing, { google: { biography: 'hi' } })
    expect(merged.web?.links).toEqual([{ value: 'https://github.com/jane' }])
    expect(merged.google?.biography).toBe('hi')
  })

  it('a fresh web patch replaces the previous web block wholesale', () => {
    const existing = { web: WEB }
    const merged = mergeEnrichment(existing, { web: { ...WEB, links: [], refreshedAt: 9 } })
    expect(merged.web?.links).toEqual([])
    expect(merged.web?.refreshedAt).toBe(9)
  })
})

describe('parseEnrichment', () => {
  it('returns {} for null, bad JSON, and non-objects', () => {
    expect(parseEnrichment(null)).toEqual({})
    expect(parseEnrichment('not json')).toEqual({})
    expect(parseEnrichment('[1,2,3]')).toEqual({})
    expect(parseEnrichment('"str"')).toEqual({})
  })

  it('round-trips a real enrichment blob', () => {
    const blob = JSON.stringify({ google: { nicknames: ['X'] } })
    expect(parseEnrichment(blob).google?.nicknames).toEqual(['X'])
  })
})
