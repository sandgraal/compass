/**
 * Fitbit export recognizers (Phase 10 — "The Acquisition Engine").
 *
 * The EXPORT path for Fitbit (Account → Data Export, or via Google Takeout →
 * Fitbit). Turns the per-metric JSON files into daily timeline records — steps,
 * calories, distance, floors, and sleep — so your Fitbit history lands on the
 * unified Timeline alongside Apple Health.
 *
 * (A LIVE OAuth sync — auto-refresh + habit auto-link like Oura — is a planned
 * follow-up; see docs/storehouse-roadmap.md. Export lands the data today with no
 * developer app or credentials.)
 *
 * FORMAT CAVEAT: based on the documented Fitbit export shapes (`[{dateTime,
 * value}]` for the additive metrics, `[{dateOfSleep, minutesAsleep}]` for sleep);
 * unvalidated against a fresh real export. Detection keys on the metric filename
 * + the array shape, so a non-Fitbit `{dateTime, value}` file isn't grabbed.
 * Additive metrics are summed per day, which is correct whether the file is
 * daily or intraday.
 */

import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

// Additive daily metrics: filename stem → { record type, how to phrase the total }.
const ADDITIVE: Record<string, { type: string; label: (n: number) => string }> = {
  steps: { type: 'steps', label: (n) => `${n.toLocaleString('en-US')} steps` },
  calories: { type: 'calories', label: (n) => `${n.toLocaleString('en-US')} calories` },
  distance: { type: 'distance', label: (n) => `${n.toLocaleString('en-US')} distance` },
  floors: { type: 'floors', label: (n) => `${n.toLocaleString('en-US')} floors` }
}

/** Which additive metric a filename names (steps-2026-01-15.json → 'steps'), or null. */
function additiveMetric(name: string): string | null {
  const lower = name.toLowerCase()
  for (const key of Object.keys(ADDITIVE)) {
    if (lower.includes(key)) return key
  }
  return null
}

function dayOf(dateTime: string): string | null {
  const ms = parseWhen(dateTime)
  if (ms == null) return null
  return new Date(ms).toISOString().slice(0, 10)
}

type ValueRow = { dateTime?: string; value?: string | number }

function safeArray(text: string): unknown[] {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export const FITBIT_ACTIVITY_RECOGNIZER: Recognizer = {
  id: 'fitbit',
  label: 'Fitbit activity export',
  detect: (f) => {
    if (f.ext !== 'json') return false
    if (!additiveMetric(f.name)) return false
    const arr = safeArray(f.text)
    if (!arr.length) return false
    const first = arr[0] as ValueRow
    return typeof first?.dateTime === 'string' && first?.value != null
  },
  parse: (f) => {
    const metric = additiveMetric(f.name)
    if (!metric) return []
    const meta = ADDITIVE[metric]
    const perDay = new Map<string, number>()
    for (const raw of safeArray(f.text) as ValueRow[]) {
      if (!raw?.dateTime || raw.value == null) continue
      const day = dayOf(raw.dateTime)
      if (!day) continue
      const v = typeof raw.value === 'number' ? raw.value : Number.parseFloat(raw.value)
      if (!Number.isFinite(v)) continue
      perDay.set(day, (perDay.get(day) ?? 0) + v)
    }
    const out: RecordInput[] = []
    for (const [day, total] of perDay) {
      const rounded = Math.round(total * 100) / 100
      out.push({
        source: 'fitbit',
        type: meta.type,
        occurredAt: new Date(`${day}T00:00:00`).getTime(),
        title: meta.label(rounded),
        payload: { day, metric, total: rounded },
        naturalKey: `${meta.type}|${day}`
      })
    }
    return out
  }
}

type SleepRow = { dateOfSleep?: string; minutesAsleep?: number; logId?: number | string }

export const FITBIT_SLEEP_RECOGNIZER: Recognizer = {
  id: 'fitbit-sleep',
  label: 'Fitbit sleep export',
  detect: (f) => {
    if (f.ext !== 'json') return false
    const arr = safeArray(f.text)
    if (!arr.length) return false
    const first = arr[0] as SleepRow
    return typeof first?.dateOfSleep === 'string' && typeof first?.minutesAsleep === 'number'
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const raw of safeArray(f.text) as SleepRow[]) {
      if (!raw?.dateOfSleep || typeof raw.minutesAsleep !== 'number') continue
      const h = Math.floor(raw.minutesAsleep / 60)
      const m = raw.minutesAsleep % 60
      out.push({
        source: 'fitbit',
        type: 'sleep',
        occurredAt: new Date(`${raw.dateOfSleep}T00:00:00`).getTime(),
        title: `${h}h ${m}m asleep`,
        payload: raw,
        naturalKey: `sleep|${raw.logId ?? raw.dateOfSleep}`
      })
    }
    return out
  }
}
