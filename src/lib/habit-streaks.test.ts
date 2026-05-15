/**
 * Habit-streak math tests. All times are mocked via an explicit `today`
 * arg so the helpers stay deterministic regardless of the host clock.
 */

import { describe, expect, it } from 'vitest'
import { _internal, computeHabitStreak } from './habit-streaks'

function entry(...dates: string[]): Record<string, boolean> {
  return Object.fromEntries(dates.map((d) => [d, true]))
}

describe('computeHabitStreak', () => {
  it('counts an active streak that ends today', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e = entry('2026-05-13', '2026-05-14', '2026-05-15')
    expect(computeHabitStreak(e, today)).toEqual({ current: 3, longest: 3 })
  })

  it('keeps the streak alive when today is empty but yesterday is checked', () => {
    const today = new Date('2026-05-15T08:00:00')
    const e = entry('2026-05-12', '2026-05-13', '2026-05-14')
    // Today (the 15th) isn't checked yet — but yesterday is, so the
    // streak isn't broken; we count 3 ending at yesterday.
    expect(computeHabitStreak(e, today)).toEqual({ current: 3, longest: 3 })
  })

  it('zeroes the current streak when today AND yesterday are both empty', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e = entry('2026-05-10', '2026-05-11', '2026-05-12')
    expect(computeHabitStreak(e, today)).toEqual({ current: 0, longest: 3 })
  })

  it('returns 0 / 0 for an empty entries map', () => {
    const today = new Date('2026-05-15T12:00:00')
    expect(computeHabitStreak({}, today)).toEqual({ current: 0, longest: 0 })
  })

  it('breaks the current streak on the first gap walking back', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e = entry('2026-05-15', '2026-05-14', '2026-05-12') // gap on the 13th
    expect(computeHabitStreak(e, today)).toEqual({ current: 2, longest: 2 })
  })

  it('reports the longest run when it is older than the current streak', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e = entry(
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-05-14',
      '2026-05-15'
    )
    expect(computeHabitStreak(e, today)).toEqual({ current: 2, longest: 5 })
  })

  it('ignores explicit false values', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e: Record<string, boolean> = {
      '2026-05-13': true,
      '2026-05-14': false,
      '2026-05-15': true
    }
    // 14th is explicit false, breaks the run → current is just today (1).
    expect(computeHabitStreak(e, today)).toEqual({ current: 1, longest: 1 })
  })

  it('ignores malformed date keys in longest-streak computation', () => {
    const today = new Date('2026-05-15T12:00:00')
    const e: Record<string, boolean> = {
      '2026-05-15': true,
      'not-a-date': true,
      '2026-05-14': true
    }
    expect(computeHabitStreak(e, today)).toEqual({ current: 2, longest: 2 })
  })

  it('handles a streak that spans a month boundary', () => {
    const today = new Date('2026-06-02T12:00:00')
    const e = entry('2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02')
    expect(computeHabitStreak(e, today)).toEqual({ current: 4, longest: 4 })
  })

  it('toDateKey zero-pads month and day', () => {
    const { toDateKey } = _internal
    expect(toDateKey(new Date('2026-01-05T00:00:00'))).toBe('2026-01-05')
    expect(toDateKey(new Date('2026-12-31T00:00:00'))).toBe('2026-12-31')
  })
})
