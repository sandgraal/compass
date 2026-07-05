import { describe, expect, it } from 'vitest'
import { normalizeTerraActivity, normalizeTerraDaily, normalizeTerraSleep } from './terra'

const DAY = '2025-06-14T00:00:00Z'
const at = Date.parse(DAY)

describe('normalizeTerraDaily', () => {
  it('emits steps + resting-HR records the Health hub can read', () => {
    const out = normalizeTerraDaily({
      data: [
        {
          metadata: { start_time: DAY },
          distance_data: { steps: 9123 },
          heart_rate_data: { summary: { resting_hr_bpm: 52 } }
        }
      ]
    })
    expect(out).toHaveLength(2)
    const steps = out.find((r) => r.type === 'steps')
    expect(steps).toMatchObject({ source: 'terra', occurredAt: at, payload: { value: 9123 } })
    const hr = out.find((r) => r.type === 'resting-hr')
    expect(hr).toMatchObject({ payload: { value: 52 } })
  })

  it('skips entries with no usable metrics or no date', () => {
    expect(normalizeTerraDaily({ data: [{ metadata: { start_time: DAY } }] })).toEqual([]) // no metrics
    expect(normalizeTerraDaily({ data: [{ distance_data: { steps: 100 } }] })).toEqual([]) // no date
    expect(normalizeTerraDaily({})).toEqual([])
    expect(normalizeTerraDaily({ data: 'nope' })).toEqual([])
  })
})

describe('normalizeTerraSleep', () => {
  it('converts asleep-seconds to a payload.ms sleep record (non-fitbit branch)', () => {
    const out = normalizeTerraSleep({
      data: [
        {
          metadata: { start_time: DAY },
          sleep_durations_data: { asleep: { duration_asleep_state_seconds: 27000 } }
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: 'terra', type: 'sleep', payload: { ms: 27_000_000 } })
    expect(out[0].title).toBe('7h 30m asleep')
  })

  it('skips zero/absent sleep', () => {
    expect(
      normalizeTerraSleep({
        data: [{ metadata: { start_time: DAY }, sleep_durations_data: { asleep: {} } }]
      })
    ).toEqual([])
  })
})

describe('normalizeTerraActivity', () => {
  it('emits a workout record titled by the session name', () => {
    const out = normalizeTerraActivity({
      data: [{ metadata: { start_time: '2025-06-15T08:00:00Z', name: 'Running' } }]
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: 'terra', type: 'workout', title: 'Running' })
  })

  it('falls back to a generic title when unnamed', () => {
    expect(normalizeTerraActivity({ data: [{ metadata: { start_time: DAY } }] })[0].title).toBe(
      'Workout'
    )
  })
})
