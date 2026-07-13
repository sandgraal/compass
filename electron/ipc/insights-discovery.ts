/**
 * Insight discovery — the generic successor to the hand-picked correlation
 * pairs in `insights.ts`.
 *
 * A registry of metric series is derived from the `records` spine + finance,
 * bucketed weekly (recent behaviour) and monthly (the multi-year archive
 * depth the storehouse actually holds), then scanned pairwise with Spearman
 * rank correlation. Honesty guards keep it from becoming a spurious-pattern
 * generator:
 *   - same-family pairs are skipped (netflix × prime-video is coverage, not
 *     insight),
 *   - the |ρ| gate scales with sample size (≈ p<0.01 via the normal
 *     approximation SE ≈ 1/√(n−1)),
 *   - a split-half stability check rejects relationships that flip sign
 *     between the first and second half of the window,
 *   - count metrics are zero-filled ONLY inside their own active range, so an
 *     archive that simply stops (Kindle in 2023) never manufactures zeros.
 *
 * The same registry powers event studies: for each recent life anchor
 * (medical encounter/procedure day, travel segment) it compares per-day metric
 * means before vs after (or before vs during, for travel) and surfaces the
 * material swings.
 *
 * Pure functions over the DB — no network, no LLM, no writes. `buildDiscovery`
 * is exported for tests; thresholds are exported consts so tests pin them.
 */
import { and, eq, gte, inArray, isNotNull, lt, lte, or } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { financeTransactions, medicalRecords, records, travelSegments } from '../db/schema'
import { localWeekKey, localYm, localYmd } from '../lib/dates'
import { DISCRETIONARY_CATEGORIES } from './insights'

type Db = ReturnType<typeof getDb>

// ── Thresholds (exported so tests pin behavior) ──────────────────────────────

/** Complete weeks scanned for the weekly window (current partial week excluded). */
export const DISCOVERY_WEEKS = 13
/** Minimum overlapping buckets for a pair to be scored. */
export const DISCOVERY_MIN_WEEKS = 8
export const DISCOVERY_MIN_MONTHS = 24
/** |ρ| floor — below this a relationship isn't worth a chart even if "significant". */
export const DISCOVERY_RHO_FLOOR = 0.35
/** z for the n-aware gate: |ρ| ≥ z/√(n−1) ≈ two-tailed p<0.01. */
export const DISCOVERY_Z = 2.6
/** Max findings surfaced per window (weekly / monthly). */
export const DISCOVERY_TOP_K = 6
/** Event studies: days on each side of an anchor, and the surfacing gates. */
export const EVENT_WINDOW_DAYS = 28
export const EVENT_MIN_PCT = 0.25
export const EVENT_MAX_ANCHORS = 3
export const EVENT_MAX_DELTAS = 6
/** Travel segments shorter than this aren't a meaningful "during" period. */
export const EVENT_MIN_TRIP_DAYS = 5
/** How far back anchors are considered (days). */
export const EVENT_LOOKBACK_DAYS = 400

const DAY_MS = 86_400_000

// ── Metric registry ──────────────────────────────────────────────────────────

type MetricRead =
  | { kind: 'spine-count'; source: string; types: string[] }
  | { kind: 'spine-sum'; source: string; types: string[]; field: string }
  | { kind: 'spend'; discretionaryOnly: boolean }

export interface MetricDef {
  id: string
  label: string
  /** Same-family pairs are never correlated (they co-vary trivially). */
  family: string
  unit: string | null
  /** Event-study floor: a per-day mean below this on BOTH sides is noise. */
  minDaily: number
  read: MetricRead
}

export const METRICS: MetricDef[] = [
  // Movement
  {
    id: 'steps',
    label: 'Steps',
    family: 'movement',
    unit: 'steps',
    minDaily: 500,
    read: { kind: 'spine-sum', source: 'apple-health', types: ['steps'], field: 'value' }
  },
  {
    id: 'active-energy',
    label: 'Active energy',
    family: 'movement',
    unit: 'kcal',
    minDaily: 50,
    read: { kind: 'spine-sum', source: 'apple-health', types: ['active-energy'], field: 'value' }
  },
  {
    id: 'fitness-sessions',
    label: 'Fitness sessions',
    family: 'movement',
    unit: null,
    minDaily: 0.07,
    read: { kind: 'spine-count', source: 'google-fit', types: ['fitness'] }
  },
  // Web
  {
    id: 'browsing',
    label: 'Browsing',
    family: 'web',
    unit: 'visits',
    minDaily: 3,
    read: { kind: 'spine-count', source: 'browser', types: ['visit'] }
  },
  {
    id: 'searches',
    label: 'Searches',
    family: 'web',
    unit: null,
    minDaily: 0.5,
    read: { kind: 'spine-count', source: 'google', types: ['search'] }
  },
  // Places
  {
    id: 'maps',
    label: 'Maps lookups',
    family: 'places',
    unit: null,
    minDaily: 0.3,
    read: { kind: 'spine-count', source: 'google', types: ['maps'] }
  },
  // Media
  {
    id: 'youtube',
    label: 'YouTube watching',
    family: 'media',
    unit: 'videos',
    minDaily: 0.5,
    read: { kind: 'spine-count', source: 'google', types: ['watch'] }
  },
  {
    id: 'netflix',
    label: 'Netflix watching',
    family: 'media',
    unit: 'titles',
    minDaily: 0.2,
    read: { kind: 'spine-count', source: 'netflix', types: ['watch'] }
  },
  {
    id: 'prime-video',
    label: 'Prime Video watching',
    family: 'media',
    unit: 'titles',
    minDaily: 0.2,
    read: { kind: 'spine-count', source: 'prime-video', types: ['watch'] }
  },
  {
    id: 'kindle',
    label: 'Kindle reading',
    family: 'media',
    unit: 'sessions',
    minDaily: 0.2,
    read: { kind: 'spine-count', source: 'kindle', types: ['read'] }
  },
  {
    id: 'alexa',
    label: 'Alexa requests',
    family: 'assistant',
    unit: null,
    minDaily: 0.3,
    read: { kind: 'spine-count', source: 'alexa', types: ['ask'] }
  },
  // Communication
  {
    id: 'texts',
    label: 'Texts',
    family: 'communication',
    unit: null,
    minDaily: 0.5,
    read: { kind: 'spine-count', source: 'google-voice', types: ['text'] }
  },
  {
    id: 'calls',
    label: 'Calls',
    family: 'communication',
    unit: null,
    minDaily: 0.15,
    read: { kind: 'spine-count', source: 'google-voice', types: ['call'] }
  },
  {
    id: 'emails',
    label: 'Email volume',
    family: 'communication',
    unit: null,
    minDaily: 0.5,
    read: { kind: 'spine-count', source: 'gmail', types: ['email'] }
  },
  // Calendar / coding
  {
    id: 'calendar',
    label: 'Calendar load',
    family: 'calendar',
    unit: 'events',
    minDaily: 0.15,
    read: { kind: 'spine-count', source: 'gcal', types: ['event'] }
  },
  {
    id: 'coding',
    label: 'Coding activity',
    family: 'coding',
    unit: 'commits/PRs',
    minDaily: 0.2,
    read: { kind: 'spine-count', source: 'github', types: ['commit', 'pr'] }
  },
  // Commerce / money
  {
    id: 'amazon-orders',
    label: 'Amazon orders',
    family: 'commerce',
    unit: 'orders',
    minDaily: 0.1,
    read: { kind: 'spine-count', source: 'amazon', types: ['order'] }
  },
  {
    id: 'paypal-payments',
    label: 'PayPal payments',
    family: 'commerce',
    unit: null,
    minDaily: 0.1,
    read: { kind: 'spine-count', source: 'paypal', types: ['payment'] }
  },
  {
    id: 'total-spend',
    label: 'Total spend',
    family: 'money',
    unit: '$',
    minDaily: 5,
    read: { kind: 'spend', discretionaryOnly: false }
  },
  {
    id: 'discretionary-spend',
    label: 'Discretionary spend',
    family: 'money',
    unit: '$',
    minDaily: 2,
    read: { kind: 'spend', discretionaryOnly: true }
  }
]

// ── Raw row fetch (one pass; every series derives from these) ────────────────

interface SpineRow {
  source: string
  type: string
  at: number
  payload: string | null
}

interface TxnRow {
  date: string
  amount: number
  category: string | null
}

/**
 * All spine rows any registry metric could need. The per-metric source/type
 * filter and the future-event cap (synced calendars carry upcoming events) run
 * IN SQL — the spine can hold hundreds of thousands of rows and this executes
 * on every Insights page load. Guarded: an older DB without `records` yields
 * an empty list, and every series goes empty.
 */
function fetchSpineRows(db: Db, untilMs: number): SpineRow[] {
  const spineReads = METRICS.flatMap((m) =>
    m.read.kind === 'spine-count' || m.read.kind === 'spine-sum' ? [m.read] : []
  )
  try {
    const rows = db
      .select({
        source: records.source,
        type: records.type,
        occurredAt: records.occurredAt,
        payload: records.payload
      })
      .from(records)
      .where(
        and(
          isNotNull(records.occurredAt),
          gte(records.occurredAt, new Date(2000, 0, 1)),
          lte(records.occurredAt, new Date(untilMs)),
          or(
            ...spineReads.map((r) =>
              and(eq(records.source, r.source), inArray(records.type, r.types))
            )
          )
        )
      )
      .all()
    const out: SpineRow[] = []
    for (const r of rows) {
      if (!r.occurredAt) continue
      out.push({ source: r.source, type: r.type, at: r.occurredAt.getTime(), payload: r.payload })
    }
    return out
  } catch {
    return []
  }
}

function fetchTxnRows(db: Db): TxnRow[] {
  try {
    return db
      .select({
        date: financeTransactions.date,
        amount: financeTransactions.amount,
        category: financeTransactions.category
      })
      .from(financeTransactions)
      .where(lt(financeTransactions.amount, 0))
      .all()
  } catch {
    return []
  }
}

// ── Series building ──────────────────────────────────────────────────────────

function payloadNumber(payload: string | null, field: string): number | null {
  if (!payload) return null
  try {
    const v = (JSON.parse(payload) as Record<string, unknown>)[field]
    const n = v == null ? Number.NaN : Number(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** value per bucket for one metric, using a caller-supplied bucket keyer. */
function bucketMetric(
  metric: MetricDef,
  spine: SpineRow[],
  txns: TxnRow[],
  keyOf: (at: number) => string,
  keyOfYmd: (ymd: string) => string
): Map<string, number> {
  const out = new Map<string, number>()
  const read = metric.read
  if (read.kind === 'spend') {
    for (const t of txns) {
      if (read.discretionaryOnly && !DISCRETIONARY_CATEGORIES.has(t.category ?? '')) continue
      const k = keyOfYmd(t.date)
      if (!k) continue
      out.set(k, (out.get(k) ?? 0) + Math.abs(t.amount))
    }
    return out
  }
  const types = new Set(read.types)
  for (const r of spine) {
    if (r.source !== read.source || !types.has(r.type)) continue
    const k = keyOf(r.at)
    if (read.kind === 'spine-count') {
      out.set(k, (out.get(k) ?? 0) + 1)
    } else {
      const v = payloadNumber(r.payload, read.field)
      if (v == null) continue
      out.set(k, (out.get(k) ?? 0) + v)
    }
  }
  return out
}

/**
 * Zero-fill a COUNT series inside its own active range: a week with no Netflix
 * rows while the archive was live is a real 0; a week after the archive
 * stopped is missing data. Sum metrics stay sparse (an unworn watch is not
 * 0 steps). `universe` is the ordered list of complete buckets in the window.
 */
function fillCounts(
  series: Map<string, number>,
  universe: string[],
  isCount: boolean
): Map<string, number> {
  if (!isCount || series.size === 0) return series
  const present = [...series.keys()].sort()
  const first = present[0]
  const last = present[present.length - 1]
  const out = new Map(series)
  for (const b of universe) {
    if (b >= first && b <= last && !out.has(b)) out.set(b, 0)
  }
  // Drop anything outside the universe (history beyond the window).
  for (const k of out.keys()) {
    if (universe.length > 0 && (k < universe[0] || k > universe[universe.length - 1])) out.delete(k)
  }
  return out
}

/** The last `count` COMPLETE weeks (Monday keys), oldest first. */
function weeklyUniverse(now: Date, count: number): string[] {
  const currentMonday = localWeekKey(now)
  const d = new Date(`${currentMonday}T00:00:00`)
  const out: string[] = []
  for (let i = count; i >= 1; i--) {
    const m = new Date(d)
    m.setDate(m.getDate() - i * 7)
    out.push(localYmd(m))
  }
  return out
}

/** Complete months from `firstYm` through the month BEFORE `now`, oldest first. */
function monthlyUniverse(now: Date, firstYm: string): string[] {
  const currentYm = localYm(now)
  const [fy, fm] = firstYm.split('-').map(Number)
  const out: string[] = []
  const d = new Date(fy, fm - 1, 1)
  for (;;) {
    const ym = localYm(d)
    if (ym >= currentYm) break
    out.push(ym)
    d.setMonth(d.getMonth() + 1)
  }
  return out
}

// ── Spearman + stability ─────────────────────────────────────────────────────

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length).fill(0)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k][1]] = r
    i = j + 1
  }
  return out
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null
  const ra = ranks(xs)
  const rb = ranks(ys)
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length
  const mb = rb.reduce((s, x) => s + x, 0) / rb.length
  let num = 0
  let da = 0
  let dbb = 0
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb)
    da += (ra[i] - ma) ** 2
    dbb += (rb[i] - mb) ** 2
  }
  if (da === 0 || dbb === 0) return null // a constant series correlates with nothing
  return num / Math.sqrt(da * dbb)
}

export interface StableCorrelation {
  rho: number
  n: number
}

/**
 * Spearman over the common buckets of two series, gated for honesty:
 * enough overlap, |ρ| past both the floor and the n-aware significance bar,
 * and the SAME SIGN in each half of the window (a relationship that flips
 * halfway through is a coincidence, not a pattern). Returns null when any
 * gate fails.
 */
export function stableSpearman(
  a: Map<string, number>,
  b: Map<string, number>,
  minN: number
): StableCorrelation | null {
  const keys = [...a.keys()].filter((k) => b.has(k)).sort()
  if (keys.length < minN) return null
  const xs = keys.map((k) => a.get(k) as number)
  const ys = keys.map((k) => b.get(k) as number)
  const rho = spearman(xs, ys)
  if (rho == null) return null
  const gate = Math.max(DISCOVERY_RHO_FLOOR, DISCOVERY_Z / Math.sqrt(keys.length - 1))
  if (Math.abs(rho) < gate) return null
  const mid = Math.floor(keys.length / 2)
  const rho1 = spearman(xs.slice(0, mid), ys.slice(0, mid))
  const rho2 = spearman(xs.slice(mid), ys.slice(mid))
  if (rho1 == null || rho2 == null) return null
  if (Math.sign(rho1) !== Math.sign(rho) || Math.sign(rho2) !== Math.sign(rho)) return null
  return { rho, n: keys.length }
}

// ── Result shapes ────────────────────────────────────────────────────────────

export interface DiscoveredCorrelation {
  id: string
  window: 'weekly' | 'monthly'
  x: { id: string; label: string; unit: string | null }
  y: { id: string; label: string; unit: string | null }
  rho: number
  n: number
  /** Plain-English mean-split reading of the relationship. */
  sentence: string
  points: Array<{ bucket: string; x: number; y: number }>
}

export interface EventDelta {
  id: string
  label: string
  unit: string | null
  /** Per-day means on each side of the anchor. */
  before: number
  after: number
  pctChange: number
}

export interface EventStudy {
  kind: 'medical' | 'travel'
  label: string
  date: string
  /** e.g. "the 28 days after vs the 28 days before" / "while away (12 days) vs the 28 days before". */
  compareLabel: string
  deltas: EventDelta[]
}

export interface DiscoveryResult {
  generatedAt: string
  weekly: DiscoveredCorrelation[]
  monthly: DiscoveredCorrelation[]
  /** Cross-family pairs that had enough overlap to be scored. */
  scanned: { weekly: number; monthly: number }
  events: EventStudy[]
}

// ── Correlation scan ─────────────────────────────────────────────────────────

function fmtVal(v: number, unit: string | null): string {
  if (unit === '$') return `$${Math.round(v).toLocaleString('en-US')}`
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  return rounded.toLocaleString('en-US')
}

function meanOf(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function meanSplitSentence(
  window: 'weekly' | 'monthly',
  x: MetricDef,
  y: MetricDef,
  points: Array<{ x: number; y: number }>
): string {
  const mx = meanOf(points.map((p) => p.x))
  const hi = points.filter((p) => p.x >= mx).map((p) => p.y)
  const lo = points.filter((p) => p.x < mx).map((p) => p.y)
  const noun = window === 'weekly' ? 'Weeks' : 'Months'
  // "…average $412 vs $250" / "…average 9.2 events vs 1.9 events" /
  // "…average 43.7 texts vs 24.8 texts" (unit falls back to the label).
  const yBit = (v: number): string =>
    y.unit === '$' ? fmtVal(v, '$') : `${fmtVal(v, y.unit)} ${y.unit ?? y.label.toLowerCase()}`
  return `${noun} with above-average ${x.label.toLowerCase()} average ${yBit(meanOf(hi))} vs ${yBit(meanOf(lo))} otherwise.`
}

function scanWindow(
  window: 'weekly' | 'monthly',
  seriesById: Map<string, Map<string, number>>,
  minN: number
): { findings: DiscoveredCorrelation[]; scanned: number } {
  const findings: DiscoveredCorrelation[] = []
  let scanned = 0
  for (let i = 0; i < METRICS.length; i++) {
    for (let j = i + 1; j < METRICS.length; j++) {
      const A = METRICS[i]
      const B = METRICS[j]
      if (A.family === B.family) continue
      const sa = seriesById.get(A.id)
      const sb = seriesById.get(B.id)
      if (!sa || !sb) continue
      const overlap = [...sa.keys()].filter((k) => sb.has(k))
      if (overlap.length < minN) continue
      scanned++
      const r = stableSpearman(sa, sb, minN)
      if (!r) continue
      const keys = overlap.sort()
      const points = keys.map((k) => ({
        bucket: k,
        x: Math.round((sa.get(k) as number) * 10) / 10,
        y: Math.round((sb.get(k) as number) * 10) / 10
      }))
      findings.push({
        id: `${A.id}~${B.id}:${window}`,
        window,
        x: { id: A.id, label: A.label, unit: A.unit },
        y: { id: B.id, label: B.label, unit: B.unit },
        rho: Math.round(r.rho * 100) / 100,
        n: r.n,
        sentence: meanSplitSentence(window, A, B, points),
        points
      })
    }
  }
  findings.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
  return { findings: findings.slice(0, DISCOVERY_TOP_K), scanned }
}

// ── Event studies ────────────────────────────────────────────────────────────

interface DayRange {
  /** inclusive YMD bounds */
  from: string
  to: string
  days: number
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() + n)
  return localYmd(d)
}

function rangeOf(from: string, to: string): DayRange {
  const days =
    Math.round(
      (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / DAY_MS
    ) + 1
  return { from, to, days }
}

/**
 * Per-day mean of a metric over a range. Counts are averaged over calendar
 * days (zero-filled), but only when the metric's own active daily range covers
 * ≥80% of the window — an archive that stopped must not read as "went to 0".
 * Sums are averaged over days WITH data (an unworn watch is not 0 steps) and
 * need at least ~a third of the days present.
 */
function dailyMean(
  metric: MetricDef,
  daily: Map<string, number>,
  activeFirst: string | null,
  activeLast: string | null,
  range: DayRange
): number | null {
  if (!activeFirst || !activeLast) return null
  const isCount = metric.read.kind !== 'spine-sum'
  if (isCount) {
    const coveredFrom = range.from >= activeFirst ? range.from : activeFirst
    const coveredTo = range.to <= activeLast ? range.to : activeLast
    if (coveredTo < coveredFrom) return null
    const covered = rangeOf(coveredFrom, coveredTo).days
    if (covered / range.days < 0.8) return null
    let sum = 0
    for (const [d, v] of daily) if (d >= range.from && d <= range.to) sum += v
    return sum / range.days
  }
  let sum = 0
  let present = 0
  for (const [d, v] of daily) {
    if (d >= range.from && d <= range.to) {
      sum += v
      present++
    }
  }
  if (present < Math.max(5, Math.ceil(range.days * 0.35))) return null
  return sum / present
}

interface Anchor {
  kind: 'medical' | 'travel'
  label: string
  date: string
  before: DayRange
  after: DayRange
  compareLabel: string
}

function medicalAnchors(db: Db, now: Date): Anchor[] {
  let rows: Array<{ category: string; description: string | null; recordedAt: string | null }> = []
  try {
    rows = db
      .select({
        category: medicalRecords.category,
        description: medicalRecords.description,
        recordedAt: medicalRecords.recordedAt
      })
      .from(medicalRecords)
      .where(isNotNull(medicalRecords.recordedAt))
      .all()
  } catch {
    return []
  }
  const nowYmd = localYmd(now)
  const oldest = addDaysYmd(nowYmd, -EVENT_LOOKBACK_DAYS)
  // Group same-day clinical rows into one anchor; an encounter names the day.
  const byDay = new Map<string, { label: string; isEncounter: boolean }>()
  for (const r of rows) {
    if (!r.recordedAt || r.recordedAt < oldest) continue
    if (r.category !== 'encounter' && r.category !== 'procedure') continue
    // Need at least two weeks of "after" to say anything.
    if (r.recordedAt > addDaysYmd(nowYmd, -14)) continue
    const cur = byDay.get(r.recordedAt)
    const isEncounter = r.category === 'encounter'
    if (!cur || (isEncounter && !cur.isEncounter)) {
      const raw = r.description ?? (isEncounter ? 'Medical encounter' : 'Medical procedure')
      const label = raw.length > 72 ? `${raw.slice(0, 69)}…` : raw
      byDay.set(r.recordedAt, { label, isEncounter })
    }
  }
  // One clinical episode often spans adjacent days (admission, imaging, echo…)
  // — collapse anchors within a week of each other into the earliest day,
  // preferring the encounter's label for the group.
  const sortedAsc = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const grouped: Array<[string, { label: string; isEncounter: boolean }]> = []
  for (const [date, info] of sortedAsc) {
    const last = grouped[grouped.length - 1]
    if (last && date <= addDaysYmd(last[0], 7)) {
      if (info.isEncounter && !last[1].isEncounter) last[1] = info
      continue
    }
    grouped.push([date, { ...info }])
  }
  return grouped
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, EVENT_MAX_ANCHORS)
    .map(([date, { label }]) => {
      const afterTo = addDaysYmd(date, EVENT_WINDOW_DAYS)
      const cappedTo = afterTo <= nowYmd ? afterTo : nowYmd
      return {
        kind: 'medical' as const,
        label,
        date,
        before: rangeOf(addDaysYmd(date, -EVENT_WINDOW_DAYS), addDaysYmd(date, -1)),
        after: rangeOf(addDaysYmd(date, 1), cappedTo),
        compareLabel: `the ${EVENT_WINDOW_DAYS} days after vs the ${EVENT_WINDOW_DAYS} days before`
      }
    })
}

function travelAnchors(db: Db, now: Date): Anchor[] {
  let rows: Array<{ country: string; startDate: string; endDate: string }> = []
  try {
    rows = db
      .select({
        country: travelSegments.country,
        startDate: travelSegments.startDate,
        endDate: travelSegments.endDate
      })
      .from(travelSegments)
      .all()
  } catch {
    return []
  }
  const nowYmd = localYmd(now)
  const oldest = addDaysYmd(nowYmd, -EVENT_LOOKBACK_DAYS)
  return rows
    .filter((r) => r.endDate >= oldest && r.startDate <= nowYmd)
    .map((r) => {
      const durTo = r.endDate <= nowYmd ? r.endDate : nowYmd
      const during = rangeOf(r.startDate, durTo)
      return { r, during }
    })
    .filter(({ during }) => during.days >= EVENT_MIN_TRIP_DAYS)
    .sort((a, b) => (a.r.startDate < b.r.startDate ? 1 : -1))
    .slice(0, EVENT_MAX_ANCHORS)
    .map(({ r, during }) => ({
      kind: 'travel' as const,
      label: `Trip to ${r.country}`,
      date: r.startDate,
      before: rangeOf(addDaysYmd(r.startDate, -EVENT_WINDOW_DAYS), addDaysYmd(r.startDate, -1)),
      after: during,
      compareLabel: `while away (${during.days} days) vs the ${EVENT_WINDOW_DAYS} days before`
    }))
}

function buildEventStudies(db: Db, now: Date, spine: SpineRow[], txns: TxnRow[]): EventStudy[] {
  const anchors = [...medicalAnchors(db, now), ...travelAnchors(db, now)]
  if (anchors.length === 0) return []

  // Daily series per metric, plus each metric's active daily range.
  const dailyById = new Map<string, Map<string, number>>()
  const activeRange = new Map<string, { first: string; last: string }>()
  for (const m of METRICS) {
    const daily = bucketMetric(
      m,
      spine,
      txns,
      (at) => localYmd(new Date(at)),
      (ymd) => ymd
    )
    dailyById.set(m.id, daily)
    if (daily.size > 0) {
      const keys = [...daily.keys()].sort()
      activeRange.set(m.id, { first: keys[0], last: keys[keys.length - 1] })
    }
  }

  const studies: EventStudy[] = []
  for (const anchor of anchors) {
    const deltas: EventDelta[] = []
    for (const m of METRICS) {
      const daily = dailyById.get(m.id)
      const range = activeRange.get(m.id)
      if (!daily || !range) continue
      const before = dailyMean(m, daily, range.first, range.last, anchor.before)
      const after = dailyMean(m, daily, range.first, range.last, anchor.after)
      if (before == null || after == null) continue
      if (Math.max(before, after) < m.minDaily) continue
      if (before <= 0) continue
      const pct = (after - before) / before
      if (Math.abs(pct) < EVENT_MIN_PCT) continue
      deltas.push({
        id: m.id,
        label: m.label,
        unit: m.unit,
        before: Math.round(before * 10) / 10,
        after: Math.round(after * 10) / 10,
        pctChange: Math.round(pct * 100) / 100
      })
    }
    if (deltas.length === 0) continue
    deltas.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange))
    studies.push({
      kind: anchor.kind,
      label: anchor.label,
      date: anchor.date,
      compareLabel: anchor.compareLabel,
      deltas: deltas.slice(0, EVENT_MAX_DELTAS)
    })
  }
  return studies
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Weekly series for every registry metric over the last complete weeks —
 *  confined to the window, counts zero-filled inside their active range. */
function buildWeeklySeries(
  spine: SpineRow[],
  txns: TxnRow[],
  now: Date
): { weeks: string[]; byId: Map<string, Map<string, number>> } {
  const weeks = weeklyUniverse(now, DISCOVERY_WEEKS)
  const byId = new Map<string, Map<string, number>>()
  for (const m of METRICS) {
    const raw = bucketMetric(
      m,
      spine,
      txns,
      (at) => localWeekKey(new Date(at)),
      (ymd) => localWeekKey(new Date(`${ymd}T00:00:00`))
    )
    const windowed = new Map<string, number>()
    for (const [k, v] of raw)
      if (weeks.length && k >= weeks[0] && k <= weeks[weeks.length - 1]) windowed.set(k, v)
    byId.set(m.id, fillCounts(windowed, weeks, m.read.kind !== 'spine-sum'))
  }
  return { weeks, byId }
}

export function buildDiscovery(db: Db, now: Date = new Date()): DiscoveryResult {
  const spine = fetchSpineRows(db, now.getTime())
  const txns = fetchTxnRows(db)

  const { byId: weeklyById } = buildWeeklySeries(spine, txns, now)

  // Monthly window over the full archive.
  const firstYm = spine.length
    ? localYm(new Date(Math.min(...spine.map((r) => r.at))))
    : localYm(now)
  const months = monthlyUniverse(now, firstYm)
  const monthlyById = new Map<string, Map<string, number>>()
  for (const m of METRICS) {
    const raw = bucketMetric(
      m,
      spine,
      txns,
      (at) => localYm(new Date(at)),
      (ymd) => ymd.slice(0, 7)
    )
    const windowed = new Map<string, number>()
    for (const [k, v] of raw)
      if (months.length && k >= months[0] && k <= months[months.length - 1]) windowed.set(k, v)
    monthlyById.set(m.id, fillCounts(windowed, months, m.read.kind !== 'spine-sum'))
  }

  const weekly = scanWindow('weekly', weeklyById, DISCOVERY_MIN_WEEKS)
  const monthly = scanWindow('monthly', monthlyById, DISCOVERY_MIN_MONTHS)

  return {
    generatedAt: now.toISOString(),
    weekly: weekly.findings,
    monthly: monthly.findings,
    scanned: { weekly: weekly.scanned, monthly: monthly.scanned },
    events: buildEventStudies(db, now, spine, txns)
  }
}

// ── Single-series anomalies ──────────────────────────────────────────────────

/** z-score bar for last week vs the trailing baseline. */
export const ANOMALY_Z = 2
/** …AND at least this relative change (tiny-σ series must not cry wolf). */
export const ANOMALY_MIN_REL = 0.25
/** Baseline weeks required before a series can be judged. */
export const ANOMALY_BASELINE_MIN = 8
/** Max anomalies surfaced per run (top by relative change). */
export const ANOMALY_MAX = 4

export interface SeriesAnomaly {
  kind: 'series-anomaly'
  /** Stable identity for the lifecycle log. */
  key: string
  severity: 'info'
  title: string
  detail: string
  route: string
}

/**
 * "Your last complete week was way off YOUR OWN norm" — z-score of the latest
 * complete week against the trailing baseline, per registry metric. A series
 * whose archive already stopped has no latest bucket (zero-fill is confined to
 * the active range), so a dead import can never read as "dropped to 0".
 */
export function detectSeriesAnomalies(db: Db, now: Date = new Date()): SeriesAnomaly[] {
  const spine = fetchSpineRows(db, now.getTime())
  const txns = fetchTxnRows(db)
  const { weeks, byId } = buildWeeklySeries(spine, txns, now)
  if (weeks.length < ANOMALY_BASELINE_MIN + 1) return []
  const latestWeek = weeks[weeks.length - 1]
  const out: Array<SeriesAnomaly & { rel: number }> = []
  for (const m of METRICS) {
    const s = byId.get(m.id)
    if (!s?.has(latestWeek)) continue
    const latest = s.get(latestWeek) as number
    const baseline = weeks
      .slice(0, -1)
      .map((w) => s.get(w))
      .filter((v): v is number => v != null)
    if (baseline.length < ANOMALY_BASELINE_MIN) continue
    const mu = baseline.reduce((a, b) => a + b, 0) / baseline.length
    if (mu <= 0) continue
    const sigma = Math.sqrt(baseline.reduce((a, b) => a + (b - mu) ** 2, 0) / baseline.length)
    const rel = (latest - mu) / mu
    if (Math.abs(rel) < ANOMALY_MIN_REL) continue
    if (sigma > 0 && Math.abs(latest - mu) / sigma < ANOMALY_Z) continue
    const pct = Math.abs(Math.round(rel * 100))
    const unitBit = m.unit && m.unit !== '$' ? ` ${m.unit}` : ''
    out.push({
      kind: 'series-anomaly',
      key: `series-anomaly:${m.id}`,
      severity: 'info',
      title: `${m.label} ${rel > 0 ? 'jumped' : 'dropped'} ${pct}% ${rel > 0 ? 'above' : 'below'} your norm last week`,
      detail: `${fmtVal(latest, m.unit)}${unitBit} vs a ${fmtVal(mu, m.unit)}${unitBit} weekly average over the prior ${baseline.length} weeks.`,
      route: '/insights',
      rel: Math.abs(rel)
    })
  }
  out.sort((a, b) => b.rel - a.rel)
  return out.slice(0, ANOMALY_MAX).map(({ rel: _rel, ...rest }) => rest)
}

export function registerDiscoveryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('insights:discovery', (): DiscoveryResult => {
    return buildDiscovery(getDb())
  })
}
