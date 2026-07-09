/**
 * Source value-tiers (Phase 10.7 "Curate"). The firehose classification that lets
 * the timeline collapse high-volume/low-signal sources without deleting anything.
 */

import { describe, expect, it } from 'vitest'
import { FIREHOSE_SOURCE_LIST, isFirehose, sourceTier } from './source-tiers'

describe('source tiers', () => {
  it('classifies browser history + generic imports as firehose, everything else as signal', () => {
    expect(sourceTier('browser')).toBe('firehose')
    expect(isFirehose('browser')).toBe(true)
    // 'generic' = the catch-all recognizer's residue (device telemetry,
    // impressions) after the Amazon signal families were promoted (PR 2).
    expect(sourceTier('generic')).toBe('firehose')
    for (const s of [
      'linkedin',
      'paypal',
      'netflix',
      'apple-health',
      'facebook',
      'email',
      'prime-video',
      'kindle',
      'amazon-music',
      'alexa'
    ]) {
      expect(sourceTier(s)).toBe('signal')
      expect(isFirehose(s)).toBe(false)
    }
  })

  it('exposes the firehose set as a list for SQL exclusion', () => {
    expect(FIREHOSE_SOURCE_LIST).toContain('browser')
    expect(FIREHOSE_SOURCE_LIST).toContain('generic')
  })
})
