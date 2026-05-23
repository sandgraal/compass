/**
 * Date-key helpers must produce the user's LOCAL calendar day, not a
 * UTC-derived slug. These tests pin the timezone (Node re-reads `process.env.TZ`
 * at runtime) and pick UTC instants that fall on a *different* calendar day
 * than the local day — so a `toISOString().slice(0, 10)` regression would fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isoDate, todayISO } from './utils'

const ORIGINAL_TZ = process.env.TZ

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ
  vi.useRealTimers()
})

describe('isoDate', () => {
  it('returns the local day east of UTC when the UTC day is still "yesterday"', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9
    // 20:00Z on the 22nd is 05:00 on the 23rd in Tokyo.
    const d = new Date('2026-05-22T20:00:00.000Z')
    expect(isoDate(d)).toBe('2026-05-23')
  })

  it('returns the local day west of UTC when the UTC day is already "tomorrow"', () => {
    process.env.TZ = 'America/Los_Angeles' // UTC-7 (DST in May)
    // 04:00Z on the 23rd is 21:00 on the 22nd in LA.
    const d = new Date('2026-05-23T04:00:00.000Z')
    expect(isoDate(d)).toBe('2026-05-22')
  })

  it('zero-pads single-digit months and days', () => {
    process.env.TZ = 'UTC'
    expect(isoDate(new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05')
  })
})

describe('todayISO', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('uses the local calendar day, not the UTC day', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9
    vi.setSystemTime(new Date('2026-05-22T20:00:00.000Z'))
    // UTC would say 2026-05-22; local Tokyo is the 23rd.
    expect(todayISO()).toBe('2026-05-23')
  })
})
