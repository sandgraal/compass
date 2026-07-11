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

describe('parseAppleHealth — widened metric allowlist (recovery/vitals)', () => {
  it('averages HRV/respiratory/glucose across a day and takes VO2max as last', async () => {
    const recs = await parseAppleHealth(
      'x',
      gen([
        // HRV: 40 + 60 on 1/2 → avg 50 ms
        '<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" unit="ms" startDate="2026-01-02 02:00:00 -0700" value="40"/>',
        '<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" unit="ms" startDate="2026-01-02 05:00:00 -0700" value="60"/>',
        '<Record type="HKQuantityTypeIdentifierRespiratoryRate" unit="count/min" startDate="2026-01-02 03:00:00 -0700" value="15"/>',
        '<Record type="HKQuantityTypeIdentifierRespiratoryRate" unit="count/min" startDate="2026-01-02 04:00:00 -0700" value="17"/>',
        '<Record type="HKQuantityTypeIdentifierBloodGlucose" unit="mg/dL" startDate="2026-01-02 08:00:00 -0700" value="90"/>',
        '<Record type="HKQuantityTypeIdentifierBloodGlucose" unit="mg/dL" startDate="2026-01-02 20:00:00 -0700" value="110"/>',
        // VO2max: two readings → last wins
        '<Record type="HKQuantityTypeIdentifierVO2Max" unit="mL/min·kg" startDate="2026-01-02 07:00:00 -0700" value="41.0"/>',
        '<Record type="HKQuantityTypeIdentifierVO2Max" unit="mL/min·kg" startDate="2026-01-02 09:00:00 -0700" value="43.5"/>'
      ])
    )
    const one = (type: string) => recs.filter((r) => r.type === type)
    expect(one('hrv')[0].title).toBe('50 ms HRV')
    expect(one('respiratory-rate')[0].title).toBe('16.0 br/min')
    expect(one('blood-glucose')[0].title).toBe('100 glucose')
    expect(one('vo2max')[0].title).toBe('43.5 VO₂max')
    // avg records note how many samples fed them.
    expect((one('hrv')[0].payload as { samples: number }).samples).toBe(2)
  })

  it('splits sleep into per-stage totals in the record body + payload', async () => {
    const recs = await parseAppleHealth(
      'x',
      gen([
        '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-01-02 00:00:00 -0700" endDate="2026-01-02 03:00:00 -0700"/>',
        '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-01-02 03:00:00 -0700" endDate="2026-01-02 04:30:00 -0700"/>',
        '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="2026-01-02 04:30:00 -0700" endDate="2026-01-02 06:00:00 -0700"/>'
      ])
    )
    const sleep = recs.filter((r) => r.type === 'sleep')
    expect(sleep).toHaveLength(1)
    expect(sleep[0].title).toBe('6h 0m asleep') // 3h + 1h30 + 1h30
    expect(sleep[0].body).toBe('Core 3h 0m · Deep 1h 30m · REM 1h 30m')
    expect((sleep[0].payload as { stages: Record<string, number> }).stages).toMatchObject({
      Core: 3 * 3600_000,
      Deep: 90 * 60_000,
      REM: 90 * 60_000
    })
  })

  it('leaves body undefined for legacy unstaged sleep', async () => {
    const recs = await parseAppleHealth(
      'x',
      gen([
        '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleep" startDate="2026-01-02 00:00:00 -0700" endDate="2026-01-02 07:00:00 -0700"/>'
      ])
    )
    const sleep = recs.filter((r) => r.type === 'sleep')
    expect(sleep[0].title).toBe('7h 0m asleep')
    expect(sleep[0].body).toBeUndefined()
  })
})
