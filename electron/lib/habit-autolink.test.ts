import { describe, expect, it } from 'vitest'
import { computeHabitAutoFills } from './habit-autolink'

describe('computeHabitAutoFills', () => {
  it('fills a habit whose linked metric meets the threshold', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: 'oura-sleep-score', autoLinkThreshold: 80 }],
      '2026-07-03',
      { 'oura-sleep-score': 82 }
    )
    expect(fills).toEqual([{ habitId: 1, date: '2026-07-03' }])
  })

  it('fills a habit whose metric is exactly at the threshold (inclusive)', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: 'oura-steps', autoLinkThreshold: 10000 }],
      '2026-07-03',
      { 'oura-steps': 10000 }
    )
    expect(fills).toEqual([{ habitId: 1, date: '2026-07-03' }])
  })

  it('skips a habit whose metric is below the threshold', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: 'oura-readiness-score', autoLinkThreshold: 80 }],
      '2026-07-03',
      { 'oura-readiness-score': 79 }
    )
    expect(fills).toEqual([])
  })

  it('skips a habit with no autoLinkSource configured (a manual habit)', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: null, autoLinkThreshold: null }],
      '2026-07-03',
      { 'oura-sleep-score': 99 }
    )
    expect(fills).toEqual([])
  })

  it('skips a habit whose autoLinkSource has no matching metric this sync', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: 'whoop-recovery-score', autoLinkThreshold: 70 }],
      '2026-07-03',
      { 'oura-sleep-score': 90 }
    )
    expect(fills).toEqual([])
  })

  it('skips a habit whose threshold is set but source is missing (malformed config)', () => {
    const fills = computeHabitAutoFills(
      [{ id: 1, autoLinkSource: null, autoLinkThreshold: 80 }],
      '2026-07-03',
      { 'oura-sleep-score': 90 }
    )
    expect(fills).toEqual([])
  })

  it('handles multiple habits linked to different metrics independently', () => {
    const fills = computeHabitAutoFills(
      [
        { id: 1, autoLinkSource: 'oura-sleep-score', autoLinkThreshold: 80 },
        { id: 2, autoLinkSource: 'oura-steps', autoLinkThreshold: 10000 },
        { id: 3, autoLinkSource: 'oura-readiness-score', autoLinkThreshold: 90 }
      ],
      '2026-07-03',
      { 'oura-sleep-score': 82, 'oura-steps': 5000, 'oura-readiness-score': 91 }
    )
    expect(fills).toEqual([
      { habitId: 1, date: '2026-07-03' },
      { habitId: 3, date: '2026-07-03' }
    ])
  })
})
