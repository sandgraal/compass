/**
 * Tests for the Apple Health streaming parser (Phase 10.3). Pure — lines are
 * injected, so no filesystem or Electron.
 */

import { describe, expect, it } from 'vitest'
import { parseAppleHealth } from './apple-health'

async function* gen(arr: string[]): AsyncGenerator<string> {
  for (const l of arr) yield l
}

const FIXTURE = [
  '<HealthData locale="en_US">',
  '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-01-02 08:00:00 -0700" endDate="2026-01-02 08:05:00 -0700" value="500"/>',
  '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-01-02 09:00:00 -0700" endDate="2026-01-02 09:05:00 -0700" value="1500"/>',
  '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-01-03 09:00:00 -0700" endDate="2026-01-03 09:05:00 -0700" value="3000"/>',
  '<Record type="HKQuantityTypeIdentifierActiveEnergyBurned" unit="kcal" startDate="2026-01-02 09:00:00 -0700" endDate="2026-01-02 09:05:00 -0700" value="120.5"/>',
  '<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2026-01-02 07:00:00 -0700" endDate="2026-01-02 07:00:00 -0700" value="70.2"/>',
  '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-01-02 00:00:00 -0700" endDate="2026-01-02 06:30:00 -0700"/>',
  '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-01-02 06:30:00 -0700" endDate="2026-01-02 07:00:00 -0700"/>',
  '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" startDate="2026-01-03 07:00:00 -0700" endDate="2026-01-03 07:32:00 -0700"/>',
  '</HealthData>'
]

describe('parseAppleHealth', () => {
  it('aggregates daily metrics and emits workouts/points', async () => {
    const recs = await parseAppleHealth('ignored.xml', gen(FIXTURE))
    const by = (type: string) => recs.filter((r) => r.type === type)

    const steps = by('steps').sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0))
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('2,000 steps') // 500 + 1500 on 1/2
    expect(steps[1].title).toBe('3,000 steps') // 1/3

    expect(by('active-energy')[0].title).toBe('121 kcal active') // 120.5 rounded

    expect(by('weight')).toHaveLength(1)
    expect(by('weight')[0].title).toBe('70.2 kg')

    const sleep = by('sleep')
    expect(sleep).toHaveLength(1)
    expect(sleep[0].title).toBe('6h 30m asleep') // only the Asleep interval counts, not InBed

    const workout = by('workout')
    expect(workout).toHaveLength(1)
    expect(workout[0].title).toBe('Running · 5.2 km · 32 min')

    expect(recs.every((r) => r.source === 'apple-health')).toBe(true)
  })

  it('produces stable dedup keys across re-parses (idempotent re-import)', async () => {
    const keys = (rs: Awaited<ReturnType<typeof parseAppleHealth>>) =>
      rs.map((r) => `${r.type}|${r.naturalKey}`).sort()
    expect(keys(await parseAppleHealth('x', gen(FIXTURE)))).toEqual(
      keys(await parseAppleHealth('x', gen(FIXTURE)))
    )
  })

  it('ignores unknown record types', async () => {
    const recs = await parseAppleHealth(
      'x',
      gen([
        '<Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-01-02 09:00:00 -0700" value="62"/>'
      ])
    )
    expect(recs).toHaveLength(0)
  })
})
