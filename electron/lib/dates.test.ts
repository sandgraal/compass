/**
 * Date-key helpers must produce the user's LOCAL calendar day/month, not a
 * UTC-derived slug. These tests pin the timezone (Node re-reads `process.env.TZ`
 * at runtime) and pick UTC instants that fall on a *different* calendar day
 * than the local day — so a `toISOString().slice(...)` regression would fail.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { localYm, localYmd } from './dates'

const ORIGINAL_TZ = process.env.TZ

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ
  vi.useRealTimers()
})

describe('localYmd', () => {
  it('returns the local day east of UTC when the UTC day is still "yesterday"', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9
    // 20:00Z on the 22nd is 05:00 on the 23rd in Tokyo.
    expect(localYmd(new Date('2026-05-22T20:00:00.000Z'))).toBe('2026-05-23')
  })

  it('returns the local day west of UTC when the UTC day is already "tomorrow"', () => {
    process.env.TZ = 'America/Los_Angeles' // UTC-7 (DST in May)
    // 04:00Z on the 23rd is 21:00 on the 22nd in LA.
    expect(localYmd(new Date('2026-05-23T04:00:00.000Z'))).toBe('2026-05-22')
  })

  it('zero-pads single-digit months and days', () => {
    process.env.TZ = 'UTC'
    expect(localYmd(new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05')
  })

  it('defaults to now (local) when no date is passed', () => {
    process.env.TZ = 'Asia/Tokyo'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-22T20:00:00.000Z'))
    expect(localYmd()).toBe('2026-05-23')
  })
})

describe('localYm', () => {
  it('returns the local month when the UTC instant rolls into the next month locally', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9
    // 16:00Z on May 31 is 01:00 on June 1 in Tokyo.
    expect(localYm(new Date('2026-05-31T16:00:00.000Z'))).toBe('2026-06')
  })

  it('returns the local month when the UTC instant is still the previous month locally', () => {
    process.env.TZ = 'America/Los_Angeles' // UTC-7 (DST)
    // 04:00Z on June 1 is 21:00 on May 31 in LA.
    expect(localYm(new Date('2026-06-01T04:00:00.000Z'))).toBe('2026-05')
  })

  it('defaults to now (local) when no date is passed', () => {
    process.env.TZ = 'Asia/Tokyo'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-31T16:00:00.000Z'))
    expect(localYm()).toBe('2026-06')
  })
})
