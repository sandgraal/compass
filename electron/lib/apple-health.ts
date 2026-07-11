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

type Rollup = 'sum' | 'last' | 'avg'

// HealthKit quantity types we roll up to one record per day. Anything not listed
// here (and not handled specially below) is ignored. Add a row to support more.
// `avg` (mean of the day's samples) suits point-in-time vitals — HRV, glucose,
// respiratory rate — where neither a sum nor a single last reading is meaningful.
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
  },
  // Recovery / vitals (the signal the cross-domain correlations want). Sampled
  // through the day → averaged. Units are whatever the device wrote (SDNN in ms,
  // glucose typically mg/dL, respiration in breaths/min).
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    type: 'hrv',
    rollup: 'avg',
    label: (v) => `${Math.round(v)} ms HRV`
  },
  HKQuantityTypeIdentifierRespiratoryRate: {
    type: 'respiratory-rate',
    rollup: 'avg',
    label: (v) => `${v.toFixed(1)} br/min`
  },
  HKQuantityTypeIdentifierBloodGlucose: {
    type: 'blood-glucose',
    rollup: 'avg',
    label: (v) => `${Math.round(v)} glucose`
  },
  HKQuantityTypeIdentifierVO2Max: {
    type: 'vo2max',
    rollup: 'last',
    label: (v) => `${v.toFixed(1)} VO₂max`
  }
  // Blood pressure (systolic + diastolic) needs pairing two Record types on the
  // left out here; add it when a correlation-aware pass is worth the complexity.
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

  // Per (hkType, day) accumulator: keep sum + count + last so any rollup mode
  // (sum / last / avg) resolves at emit time from the same running state.
  const daily = new Map<string, { sum: number; count: number; last: number; day: string }>()
  const sleepMs = new Map<string, number>() // key `${day}` → total asleep ms
  const sleepStages = new Map<string, number>() // key `${day}|${stage}` → ms in that stage
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
        if (!cur) daily.set(key, { sum: v, count: 1, last: v, day: dayKey(start) })
        else {
          cur.sum += v
          cur.count++
          cur.last = v
        }
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
          // Newer exports tag the stage (…AsleepCore / …AsleepDeep / …AsleepREM);
          // roll each stage's ms up per day so the daily sleep record can carry a
          // breakdown. Legacy "…Asleep" (unstaged) buckets as 'Unspecified'.
          const stage = a.value.match(/Asleep(Core|Deep|REM|Unspecified)?$/)?.[1] || 'Unspecified'
          sleepStages.set(`${day}|${stage}`, (sleepStages.get(`${day}|${stage}`) ?? 0) + ms)
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

  for (const [key, { sum, count, last, day }] of daily) {
    const meta = DAILY[key.slice(0, key.indexOf('|'))]
    const value = meta.rollup === 'avg' ? sum / count : meta.rollup === 'last' ? last : sum
    out.push({
      source: 'apple-health',
      type: meta.type,
      occurredAt: dayMidnight(day),
      title: meta.label(value),
      payload: { value, day, samples: count },
      naturalKey: `${meta.type}|${day}`
    })
  }
  for (const [day, ms] of sleepMs) {
    // Attach the per-stage breakdown when the export tagged stages (a lone
    // 'Unspecified' bucket means the export didn't). Kept as ONE record per day
    // (not one per stage) so sleep doesn't flood the timeline; the structured
    // stages live in `payload` and a compact summary rides in the body.
    const stages: Record<string, number> = {}
    for (const [k, sm] of sleepStages) {
      if (k.startsWith(`${day}|`)) stages[k.slice(day.length + 1)] = sm
    }
    const staged = Object.keys(stages).filter((s) => s !== 'Unspecified')
    const body =
      staged.length > 0
        ? staged
            .sort()
            .map((s) => `${s} ${fmtDuration(stages[s])}`)
            .join(' · ')
        : undefined
    out.push({
      source: 'apple-health',
      type: 'sleep',
      occurredAt: dayMidnight(day),
      title: `${fmtDuration(ms)} asleep`,
      body,
      payload: { day, ms, stages },
      naturalKey: `sleep|${day}`
    })
  }

  return out
}
