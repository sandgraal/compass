/**
 * Garmin Connect export recognizer (Phase 10 — "The Acquisition Engine").
 *
 * The EXPORT path for Garmin (Garmin Connect → Account → Export Your Data → the
 * `DI_CONNECT` archive). Turns the activities/summarized-activities JSON into one
 * timeline record per workout — "Running · 5.2 km · 32 min" — so your training
 * history lands on the unified Timeline.
 *
 * (A LIVE OAuth sync is a planned follow-up; Garmin's Connect Developer Program
 * has an app-approval step, so export lands the data today without it.)
 *
 * FORMAT CAVEAT: based on the documented Garmin activity shape (`activityId`,
 * `activityName`/`name`, `startTimeLocal`/`beginTimestamp`, `distance` (metres),
 * `duration` (seconds), `activityType`); the bulk export nests these under a few
 * container keys and the exact shape drifts, so detection is conservative
 * (`activityId` + a start-time field) and each row degrades to skip rather than
 * throw. Unvalidated against a fresh real export.
 */

import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

type Activity = {
  activityId?: number | string
  activityName?: string | null
  name?: string | null
  startTimeLocal?: string | null
  startTimeGmt?: string | null
  beginTimestamp?: number | null
  distance?: number | null // metres
  duration?: number | null // seconds
  activityType?: string | { typeKey?: string } | null
}

/** Garmin's export wraps the activity list under a few possible container keys;
 *  find the first array of activity-shaped objects. */
function activitiesFrom(text: string): Activity[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const looksLikeActivities = (v: unknown): v is Activity[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    typeof v[0] === 'object' &&
    v[0] != null &&
    'activityId' in v[0]
  if (looksLikeActivities(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const val of Object.values(parsed as Record<string, unknown>)) {
      if (looksLikeActivities(val)) return val
    }
  }
  return []
}

function typeLabel(t: Activity['activityType']): string {
  const key = typeof t === 'string' ? t : (t?.typeKey ?? '')
  if (!key) return 'Activity'
  // 'running' / 'lap_swimming' → 'Running' / 'Lap swimming'
  const words = key.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Activity'
}

function startMs(a: Activity): number | null {
  const fromStr = parseWhen(a.startTimeLocal ?? a.startTimeGmt ?? '')
  if (fromStr != null) return fromStr
  if (typeof a.beginTimestamp === 'number') return a.beginTimestamp
  return null
}

export const GARMIN_ACTIVITY_RECOGNIZER: Recognizer = {
  id: 'garmin',
  label: 'Garmin Connect activities',
  detect: (f) => {
    if (f.ext !== 'json') return false
    return activitiesFrom(f.text).length > 0
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const a of activitiesFrom(f.text)) {
      const when = startMs(a)
      if (when == null) continue
      const bits = [typeLabel(a.activityType)]
      if (typeof a.distance === 'number' && a.distance > 0) {
        bits.push(`${(Math.round(a.distance / 10) / 100).toLocaleString('en-US')} km`)
      }
      if (typeof a.duration === 'number' && a.duration > 0) {
        bits.push(`${Math.round(a.duration / 60)} min`)
      }
      out.push({
        source: 'garmin',
        type: 'workout',
        occurredAt: when,
        title: bits.join(' · '),
        payload: a,
        naturalKey: a.activityId != null ? `activity|${a.activityId}` : `activity|${when}`
      })
    }
    return out
  }
}
