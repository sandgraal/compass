/**
 * Apple Health `export.xml` parser (Phase 10.3 — "The Acquisition Engine").
 *
 * The Health export is huge (100s of MB–1 GB) and holds MILLIONS of raw samples
 * (heart rate every few seconds), so this is a STREAMING recognizer: it reads the
 * file line-by-line (constant memory) and AGGREGATES to daily rollups (+ individual
 * workouts / weigh-ins) rather than inserting one record per sample.
 *
 * Zero deps. Apple writes one self-closing `<Record .../>` / `<Workout .../>`
 * element per line with the fields we need on the opening tag, so a line scan + an
 * attribute regex is enough — the same hand-rolled spirit as the finance/vCard
 * parsers. Nested children (`<MetadataEntry/>`, `<WorkoutStatistics/>`) are simply
 * other lines we ignore.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { RecordInput } from './recognizers'

type Rollup = 'sum' | 'last'

// HealthKit quantity types we roll up to one record per day. Anything not listed
// here (and not handled specially below) is ignored. Add a row to support more.
const DAILY: Record<string, { type: string; rollup: Rollup; label: (v: number) => string }> = {
  HKQuantityTypeIdentifierStepCount: {
    type: 'steps',
    rollup: 'sum',
    label: (v) => `${Math.round(v).toLocaleString('en-US')} steps`
  },
  HKQuantityTypeIdentifierActiveEnergyBurned: {
    type: 'active-energy',
    rollup: 'sum',
    label: (v) => `${Math.round(v)} kcal active`
  },
  HKQuantityTypeIdentifierRestingHeartRate: {
    type: 'resting-hr',
    rollup: 'last',
    label: (v) => `${Math.round(v)} bpm resting`
  }
}

const ATTR = /(\w+)="([^"]*)"/g
function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR.lastIndex = 0
  let m: RegExpExecArray | null = ATTR.exec(line)
  while (m !== null) {
    out[m[1]] = m[2]
    m = ATTR.exec(line)
  }
  return out
}

function dayKey(date: string): string {
  return date.slice(0, 10) // 'YYYY-MM-DD' — the export's date already carries the device offset
}

/** Local midnight (epoch ms) for a 'YYYY-MM-DD…' string; null if unparseable. */
function dayMidnight(date: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

function workoutLabel(type: string): string {
  return type.replace(/^HKWorkoutActivityType/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Workout'
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/**
 * Stream-parse an Apple Health `export.xml` into aggregated timeline records.
 * `lines` is injectable for tests; in production it streams `path`.
 */
export async function parseAppleHealth(
  path: string,
  lines?: AsyncIterable<string>
): Promise<RecordInput[]> {
  const src: AsyncIterable<string> =
    lines ??
    createInterface({
      input: createReadStream(path, 'utf-8'),
      crlfDelay: Number.POSITIVE_INFINITY
    })

  const daily = new Map<string, { value: number; day: string }>() // key `${hkType}|${day}`
  const sleepMs = new Map<string, number>() // key `${day}` → total asleep ms
  const out: RecordInput[] = []

  for await (const line of src) {
    if (line.includes('<Record ')) {
      const a = attrs(line)
      const t = a.type
      const start = a.startDate
      if (!t || !start) continue

      const meta = DAILY[t]
      if (meta) {
        const v = Number.parseFloat(a.value)
        if (!Number.isFinite(v)) continue
        const key = `${t}|${dayKey(start)}`
        const cur = daily.get(key)
        if (!cur) daily.set(key, { value: v, day: dayKey(start) })
        else cur.value = meta.rollup === 'sum' ? cur.value + v : v
        continue
      }

      if (t === 'HKQuantityTypeIdentifierBodyMass') {
        const v = Number.parseFloat(a.value)
        const at = Date.parse(start)
        if (Number.isFinite(v) && !Number.isNaN(at)) {
          out.push({
            source: 'apple-health',
            type: 'weight',
            occurredAt: at,
            title: `${v} ${a.unit || 'kg'}`,
            payload: { type: t, value: v, unit: a.unit },
            naturalKey: `weight|${start}|${v}`
          })
        }
        continue
      }

      if (t === 'HKCategoryTypeIdentifierSleepAnalysis') {
        if (!(a.value || '').includes('Asleep')) continue // skip InBed / Awake
        const ms = Date.parse(a.endDate) - Date.parse(start)
        if (Number.isFinite(ms) && ms > 0) {
          const day = dayKey(start)
          sleepMs.set(day, (sleepMs.get(day) ?? 0) + ms)
        }
      }
    } else if (line.includes('<Workout ')) {
      const a = attrs(line)
      const at = Date.parse(a.startDate)
      if (Number.isNaN(at)) continue
      const bits = [workoutLabel(a.workoutActivityType || '')]
      const dist = Number.parseFloat(a.totalDistance)
      if (Number.isFinite(dist) && dist > 0) bits.push(`${dist} ${a.totalDistanceUnit || 'km'}`)
      const dur = Number.parseFloat(a.duration)
      if (Number.isFinite(dur)) bits.push(`${Math.round(dur)} ${a.durationUnit || 'min'}`)
      out.push({
        source: 'apple-health',
        type: 'workout',
        occurredAt: at,
        title: bits.join(' · '),
        payload: a,
        naturalKey: `workout|${a.startDate}|${a.workoutActivityType || ''}|${a.duration || ''}`
      })
    }
  }

  for (const [key, { value, day }] of daily) {
    const meta = DAILY[key.slice(0, key.indexOf('|'))]
    out.push({
      source: 'apple-health',
      type: meta.type,
      occurredAt: dayMidnight(day),
      title: meta.label(value),
      payload: { value, day },
      naturalKey: `${meta.type}|${day}`
    })
  }
  for (const [day, ms] of sleepMs) {
    out.push({
      source: 'apple-health',
      type: 'sleep',
      occurredAt: dayMidnight(day),
      title: `${fmtDuration(ms)} asleep`,
      payload: { day, ms },
      naturalKey: `sleep|${day}`
    })
  }

  return out
}
