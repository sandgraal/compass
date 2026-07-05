/**
 * Health hub (Phase 10.3 — "Health & medical").
 *
 * A pure aggregator over the health data Compass already ingests — the structured
 * `oura_daily_metrics` table plus `apple-health` / `fitbit` / `garmin` rows on the
 * `records` timeline — that unifies them into one set of trends + rollups. Same
 * shape as the finance aggregators (`finance-*.ts`): a pure function over an injected
 * SQLite handle, deterministic (the "today" instant is injected), returning typed
 * aggregates — never raw rows (beyond a short recent-workout list of title+date for
 * the page; the MCP tool strips even that).
 *
 * Numeric extraction, per the recognizers that produce these rows:
 *   steps   — oura.steps · apple-health `steps` payload.value · fitbit `steps` payload.total
 *   sleep   — oura.total_sleep_minutes · fitbit `sleep` payload.minutesAsleep · apple-health `sleep` payload.ms/60000
 *   scores  — oura sleep/readiness/activity (Oura only)
 *   restHR  — apple-health `resting-hr` payload.value
 *   weight  — apple-health `weight` payload.value
 *   workout — apple-health/garmin/fitbit `workout` rows (title + date)
 * Per day we take the MAX across sources for steps/sleep so overlapping trackers
 * don't inflate a total. Missing days simply aren't averaged (no zero-fill).
 */

import type { SqliteForFx } from './finance-fx'

const DAY_MS = 86_400_000
export const STEP_GOAL = 8000 // an "active day" = a workout OR ≥ this many steps

export type HealthSource = 'oura' | 'apple-health' | 'fitbit' | 'garmin'

export type HealthSummary = {
  today: string // local 'YYYY-MM-DD'
  stepGoal: number
  sources: Array<{
    source: HealthSource
    hasData: boolean
    count: number
    firstDate: string | null
    lastDate: string | null
  }>
  steps: {
    last7Avg: number | null
    last30Avg: number | null
    best: { date: string; steps: number } | null
    series: Array<{ date: string; steps: number }> // last 30 days, present days only
  }
  sleep: {
    last7AvgMin: number | null
    last30AvgMin: number | null
    series: Array<{ date: string; minutes: number }>
  }
  oura: {
    hasData: boolean
    latest: {
      date: string
      sleepScore: number | null
      readinessScore: number | null
      activityScore: number | null
    } | null
    sleepScore7Avg: number | null
    readiness7Avg: number | null
    activity7Avg: number | null
  }
  restingHr: { latest: { date: string; bpm: number } | null; last30Avg: number | null }
  weight: { latest: { date: string; value: number; unit: string } | null }
  workouts: { last30Count: number; recent: Array<{ date: string; title: string; source: string }> }
  activeDays30: number
}

// ── helpers ───────────────────────────────────────────────────────────────────

function localYmd(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parsePayload(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}

/** Average of a day→value map over [startYmd, endYmd] inclusive (present days only). */
function windowAvg(byDay: Map<string, number>, startYmd: string, endYmd: string): number | null {
  const vals: number[] = []
  for (const [day, v] of byDay) if (day >= startYmd && day <= endYmd) vals.push(v)
  return avg(vals)
}

type OuraRow = {
  date: string
  sleepScore: number | null
  readinessScore: number | null
  activityScore: number | null
  steps: number | null
  sleepMin: number | null
}

type HealthRecordRow = { at: number; source: string; type: string; title: string; payload: unknown }

function readOura(sqlite: SqliteForFx): OuraRow[] {
  try {
    return sqlite
      .prepare(
        'SELECT date, sleep_score AS sleepScore, readiness_score AS readinessScore, activity_score AS activityScore, steps, total_sleep_minutes AS sleepMin FROM oura_daily_metrics ORDER BY date'
      )
      .all() as OuraRow[]
  } catch {
    return [] // table absent on an old/unusual DB
  }
}

function readHealthRecords(sqlite: SqliteForFx): HealthRecordRow[] {
  try {
    return sqlite
      .prepare(
        "SELECT occurred_at AS at, source, type, title, payload FROM records WHERE source IN ('apple-health','fitbit','garmin') AND occurred_at IS NOT NULL ORDER BY occurred_at"
      )
      .all() as HealthRecordRow[]
  } catch {
    return []
  }
}

// ── the aggregator ──────────────────────────────────────────────────────────

/** Assemble the health summary. `todayMs` injected for determinism. */
export function buildHealthSummary(
  sqlite: SqliteForFx,
  todayMs: number = Date.now()
): HealthSummary {
  const today = localYmd(todayMs)
  const start7 = localYmd(todayMs - 6 * DAY_MS)
  const start30 = localYmd(todayMs - 29 * DAY_MS)

  const ouraRows = readOura(sqlite)
  const recordRows = readHealthRecords(sqlite)

  // Per-day merged signals (MAX across sources so overlapping trackers don't inflate).
  const stepsByDay = new Map<string, number>()
  const sleepByDay = new Map<string, number>()
  const restingHrByDay = new Map<string, number>()
  const weightByDay = new Map<string, { value: number; unit: string }>()
  const workouts: Array<{ date: string; title: string; source: string; at: number }> = []

  const bump = (map: Map<string, number>, day: string, v: number | null): void => {
    if (v == null) return
    const prev = map.get(day)
    if (prev == null || v > prev) map.set(day, v)
  }

  // Oura structured columns.
  for (const r of ouraRows) {
    bump(stepsByDay, r.date, num(r.steps))
    bump(sleepByDay, r.date, num(r.sleepMin))
  }
  // Timeline health records.
  const coverage: Record<string, { count: number; first: number | null; last: number | null }> = {}
  for (const r of recordRows) {
    const day = localYmd(r.at)
    const p = parsePayload(r.payload)
    const cov = coverage[r.source] ?? { count: 0, first: null, last: null }
    cov.count++
    cov.first = cov.first == null ? r.at : Math.min(cov.first, r.at)
    cov.last = cov.last == null ? r.at : Math.max(cov.last, r.at)
    coverage[r.source] = cov

    if (r.type === 'steps') {
      bump(stepsByDay, day, num(r.source === 'fitbit' ? p.total : p.value))
    } else if (r.type === 'sleep') {
      const min =
        r.source === 'fitbit' ? num(p.minutesAsleep) : num(p.ms) != null ? num(p.ms)! / 60000 : null
      bump(sleepByDay, day, min == null ? null : Math.round(min))
    } else if (r.type === 'resting-hr') {
      const v = num(p.value)
      if (v != null) restingHrByDay.set(day, v) // last-write-wins per day
    } else if (r.type === 'weight') {
      const v = num(p.value)
      // Apple Health weight records carry their own unit (kg/lb); keep it so the UI
      // isn't an ambiguous unitless number. Default to kg when the export omits it.
      if (v != null)
        weightByDay.set(day, {
          value: v,
          unit: typeof p.unit === 'string' && p.unit ? p.unit : 'kg'
        })
    } else if (r.type === 'workout') {
      workouts.push({ date: day, title: r.title, source: r.source, at: r.at })
    }
  }

  // ── steps ──
  let best: { date: string; steps: number } | null = null
  for (const [date, steps] of stepsByDay) if (!best || steps > best.steps) best = { date, steps }
  const stepsSeries = [...stepsByDay.entries()]
    .filter(([d]) => d >= start30 && d <= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, steps]) => ({ date, steps }))

  // ── sleep ──
  const sleepSeries = [...sleepByDay.entries()]
    .filter(([d]) => d >= start30 && d <= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, minutes]) => ({ date, minutes }))

  // ── oura scores ──
  const inWindowOura = ouraRows.filter((r) => r.date >= start7 && r.date <= today)
  const latestOura = ouraRows.length ? ouraRows[ouraRows.length - 1] : null
  const ouraAvg = (pick: (r: OuraRow) => number | null): number | null =>
    avg(inWindowOura.map(pick).filter((v): v is number => v != null))

  // ── resting HR ──
  let restingLatest: { date: string; bpm: number } | null = null
  for (const [date, bpm] of restingHrByDay)
    if (!restingLatest || date > restingLatest.date) restingLatest = { date, bpm }

  // ── weight ──
  let weightLatest: { date: string; value: number; unit: string } | null = null
  for (const [date, w] of weightByDay)
    if (!weightLatest || date > weightLatest.date)
      weightLatest = { date, value: w.value, unit: w.unit }

  // ── workouts ── (recent is drawn from the SAME 30-day window as the count, so the
  // card can't show "0 workouts" alongside a non-empty recent list)
  const workouts30 = workouts.filter((w) => w.date >= start30 && w.date <= today)
  const recentWorkouts = [...workouts30]
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)
    .map((w) => ({ date: w.date, title: w.title, source: w.source }))

  // ── active days (last 30): a workout OR ≥ STEP_GOAL steps ──
  const activeSet = new Set<string>()
  for (const [day, steps] of stepsByDay)
    if (day >= start30 && day <= today && steps >= STEP_GOAL) activeSet.add(day)
  for (const w of workouts30) activeSet.add(w.date)

  // ── source coverage ──
  const ouraFirst = ouraRows.length ? ouraRows[0].date : null
  const ouraLast = ouraRows.length ? ouraRows[ouraRows.length - 1].date : null
  const sources: HealthSummary['sources'] = [
    {
      source: 'oura',
      hasData: ouraRows.length > 0,
      count: ouraRows.length,
      firstDate: ouraFirst,
      lastDate: ouraLast
    },
    ...(['apple-health', 'fitbit', 'garmin'] as const).map((src) => {
      const cov = coverage[src]
      return {
        source: src,
        hasData: !!cov && cov.count > 0,
        count: cov?.count ?? 0,
        firstDate: cov?.first != null ? localYmd(cov.first) : null,
        lastDate: cov?.last != null ? localYmd(cov.last) : null
      }
    })
  ]

  return {
    today,
    stepGoal: STEP_GOAL,
    sources,
    steps: {
      last7Avg: windowAvg(stepsByDay, start7, today),
      last30Avg: windowAvg(stepsByDay, start30, today),
      best,
      series: stepsSeries
    },
    sleep: {
      last7AvgMin: windowAvg(sleepByDay, start7, today),
      last30AvgMin: windowAvg(sleepByDay, start30, today),
      series: sleepSeries
    },
    oura: {
      hasData: ouraRows.length > 0,
      latest: latestOura
        ? {
            date: latestOura.date,
            sleepScore: num(latestOura.sleepScore),
            readinessScore: num(latestOura.readinessScore),
            activityScore: num(latestOura.activityScore)
          }
        : null,
      sleepScore7Avg: ouraAvg((r) => num(r.sleepScore)),
      readiness7Avg: ouraAvg((r) => num(r.readinessScore)),
      activity7Avg: ouraAvg((r) => num(r.activityScore))
    },
    restingHr: { latest: restingLatest, last30Avg: windowAvg(restingHrByDay, start30, today) },
    weight: { latest: weightLatest },
    workouts: { last30Count: workouts30.length, recent: recentWorkouts },
    activeDays30: activeSet.size
  }
}
