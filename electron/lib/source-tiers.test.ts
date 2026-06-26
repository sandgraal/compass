/**
 * Source value-tiers (Phase 10.7 "Curate"). The firehose classification that lets
 * the timeline collapse high-volume/low-signal sources without deleting anything.
 */

import { describe, expect, it } from 'vitest'
import { FIREHOSE_SOURCE_LIST, isFirehose, sourceTier } from './source-tiers'

describe('source tiers', () => {
  it('classifies browser history as a firehose, everything else as signal', () => {
    expect(sourceTier('browser')).toBe('firehose')
    expect(isFirehose('browser')).toBe(true)
    for (const s of ['linkedin', 'paypal', 'netflix', 'apple-health', 'facebook', 'email']) {
      expect(sourceTier(s)).toBe('signal')
      expect(isFirehose(s)).toBe(false)
    }
  })

  it('exposes the firehose set as a list for SQL exclusion', () => {
    expect(FIREHOSE_SOURCE_LIST).toContain('browser')
  })
})
