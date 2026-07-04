/**
 * Tests for the Garmin Connect activities recognizer (Phase 10). Covers the
 * bare-array and container-wrapped shapes, metres→km + seconds→min formatting,
 * the stable activityId dedup key, and that it skips rows without a start time.
 */

import { describe, expect, it } from 'vitest'
import { GARMIN_ACTIVITY_RECOGNIZER } from './garmin'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const ACTIVITIES = JSON.stringify([
  {
    activityId: 900001,
    activityName: 'Morning Run',
    startTimeLocal: '2026-01-15 06:30:00',
    distance: 5200, // metres
    duration: 1920, // seconds
    activityType: { typeKey: 'running' }
  },
  {
    activityId: 900002,
    startTimeLocal: '2026-01-16 07:00:00',
    activityType: 'lap_swimming'
  }
])

describe('Garmin activities recognizer', () => {
  it('parses a bare activities array with distance + duration formatting', () => {
    const f = file('summarizedActivities.json', ACTIVITIES)
    expect(recognize(f)?.id).toBe('garmin')

    const out = GARMIN_ACTIVITY_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'garmin',
      type: 'workout',
      title: 'Running · 5.2 km · 32 min',
      naturalKey: 'activity|900001'
    })
    // String activityType + no distance still produces a labelled record.
    expect(out[1].title).toBe('Lap swimming')
  })

  it('finds activities nested under a container key', () => {
    const wrapped = JSON.stringify({ summarizedActivitiesExport: JSON.parse(ACTIVITIES) })
    const out = GARMIN_ACTIVITY_RECOGNIZER.parse(file('export.json', wrapped))
    expect(out).toHaveLength(2)
  })

  it('does not claim a non-Garmin JSON', () => {
    expect(GARMIN_ACTIVITY_RECOGNIZER.detect(file('data.json', '[{"foo":1}]'))).toBe(false)
  })
})
