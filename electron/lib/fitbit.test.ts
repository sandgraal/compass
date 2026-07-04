/**
 * Tests for the Fitbit export recognizers (Phase 10). Covers the additive
 * daily-metric shape (steps summed across intraday rows, metric from filename),
 * the sleep shape, and that neither grabs an unrelated JSON.
 *
 * NOTE: sample shapes mirror the documented export; update fixtures + the
 * recognizer together if a real export differs.
 */

import { describe, expect, it } from 'vitest'
import { FITBIT_ACTIVITY_RECOGNIZER, FITBIT_SLEEP_RECOGNIZER } from './fitbit'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

describe('Fitbit activity recognizer', () => {
  it('sums additive intraday values into a daily total, metric from filename', () => {
    const steps = JSON.stringify([
      { dateTime: '01/15/26 00:00:00', value: '3000' },
      { dateTime: '01/15/26 12:00:00', value: '5432' },
      { dateTime: '01/16/26 09:00:00', value: '8000' }
    ])
    const f = file('steps-2026-01-15.json', steps)
    expect(recognize(f)?.id).toBe('fitbit')

    const out = FITBIT_ACTIVITY_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2) // two days
    expect(out.every((r) => r.source === 'fitbit' && r.type === 'steps')).toBe(true)
    const d15 = out.find((r) => r.naturalKey === 'steps|2026-01-15')
    expect(d15?.title).toBe('8,432 steps') // 3000 + 5432, summed
  })

  it('needs the metric filename hint — a bare {dateTime,value} file is not claimed', () => {
    const f = file('mystery.json', JSON.stringify([{ dateTime: '01/15/26 00:00:00', value: '1' }]))
    expect(FITBIT_ACTIVITY_RECOGNIZER.detect(f)).toBe(false)
  })
})

describe('Fitbit sleep recognizer', () => {
  it('formats minutes asleep as Xh Ym per sleep log', () => {
    const sleep = JSON.stringify([{ logId: 111, dateOfSleep: '2026-01-15', minutesAsleep: 452 }])
    const f = file('sleep-2026-01-15.json', sleep)
    const out = FITBIT_SLEEP_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: 'fitbit', type: 'sleep', title: '7h 32m asleep' })
    expect(out[0].naturalKey).toBe('sleep|111')
  })
})
