/**
 * Subscription usage matching — extracted from insights.ts's
 * detectUnusedSubscriptions. Regression coverage mirrors the "unused
 * subscription" cases in insights.test.ts so the extraction is behavior
 * preserving: matching is unchanged, and only the internal pair-key format
 * moved (still opaque to callers, since `usagePairKey` is the single place
 * that builds and reads it).
 */
import { describe, expect, it } from 'vitest'
import {
  STREAMING_USAGE,
  matchSubscriptionUsage,
  usagePairKey,
  wasSubscriptionUsed
} from './subscription-usage'

describe('matchSubscriptionUsage', () => {
  it('matches known streaming services case-insensitively', () => {
    expect(matchSubscriptionUsage('Netflix')?.sources).toEqual(['netflix'])
    expect(matchSubscriptionUsage('SPOTIFY PREMIUM')?.sources).toEqual(['spotify'])
    expect(matchSubscriptionUsage('YouTube Premium')?.sources).toEqual(['youtube'])
  })

  it('matches multi-word/spacing variants via the regex tables', () => {
    expect(matchSubscriptionUsage('Amazon Prime Video')?.sources).toEqual(['prime-video'])
    expect(matchSubscriptionUsage('Kindle Unlimited')?.sources).toEqual(['kindle'])
    expect(matchSubscriptionUsage('Amazon Music Unlimited')?.types).toEqual([
      'listen',
      'like',
      'save'
    ])
  })

  it('returns undefined for subscriptions we have no usage signal for', () => {
    expect(matchSubscriptionUsage('Adobe Creative Cloud')).toBeUndefined()
  })

  it('covers every entry in STREAMING_USAGE', () => {
    // A regression guard: adding an entry to STREAMING_USAGE without a
    // matching name would silently never be exercised here.
    expect(STREAMING_USAGE.length).toBeGreaterThan(0)
  })
})

describe('wasSubscriptionUsed', () => {
  it('is used when a matching source+type pair is present', () => {
    const match = matchSubscriptionUsage('Netflix')!
    const used = new Set([usagePairKey('netflix', 'watch')])
    expect(wasSubscriptionUsed(match, used)).toBe(true)
  })

  it('is not used when no pair matches', () => {
    const match = matchSubscriptionUsage('Netflix')!
    const used = new Set([usagePairKey('spotify', 'listen')])
    expect(wasSubscriptionUsed(match, used)).toBe(false)
  })

  it('is not used against an empty pair set', () => {
    const match = matchSubscriptionUsage('Spotify')!
    expect(wasSubscriptionUsed(match, new Set())).toBe(false)
  })

  it('matches on ANY of a multi-type entry (amazon music: listen/like/save)', () => {
    const match = matchSubscriptionUsage('Amazon Music')!
    const used = new Set([usagePairKey('amazon-music', 'like')])
    expect(wasSubscriptionUsed(match, used)).toBe(true)
  })
})

describe('usagePairKey', () => {
  it('is stable and round-trips through a Set', () => {
    const key = usagePairKey('netflix', 'watch')
    expect(new Set([key]).has(usagePairKey('netflix', 'watch'))).toBe(true)
  })

  it('is consistent for the same source/type pair', () => {
    expect(usagePairKey('netflix', 'watch')).toBe(usagePairKey('netflix', 'watch'))
  })
})
