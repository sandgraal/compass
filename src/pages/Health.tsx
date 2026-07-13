import { Activity, Dumbbell, Footprints, HeartPulse, Moon, Scale, TrendingUp } from 'lucide-react'
import { type JSX, useEffect, useState } from 'react'
import { cn } from '../lib/utils'

type HealthSummary = Awaited<ReturnType<Window['api']['health']['getSummary']>>
type MedicalSummary = Awaited<ReturnType<Window['api']['medical']['getSummary']>>

const SOURCE_LABEL: Record<string, string> = {
  oura: 'Oura',
  'apple-health': 'Apple Health',
  fitbit: 'Fitbit',
  garmin: 'Garmin',
  terra: 'Terra'
}

function fmtInt(n: number | null, suffix = ''): string {
  return n == null ? '—' : `${Math.round(n).toLocaleString('en-US')}${suffix}`
}

function fmtHrs(min: number | null): string {
  if (min == null) return '—'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${h}h ${m}m`
}

function StatCard({
  icon,
  label,
  value,
  sub
}: {
  icon: JSX.Element
  label: string
  value: string
  sub?: string
}): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

/** Minimal dependency-free bar sparkline over a dated series. */
function Bars({ data }: { data: Array<{ date: string; value: number }> }): JSX.Element {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1
  return (
    <div className="flex items-end gap-0.5 h-16 overflow-x-auto">
      {data.map((d) => (
        <div
          key={d.date}
          className="w-2 shrink-0 rounded-sm bg-primary/70"
          style={{ height: `${Math.max(4, Math.round((d.value / max) * 100))}%` }}
          title={`${d.date}: ${Math.round(d.value).toLocaleString('en-US')}`}
        />
      ))}
    </div>
  )
}

type MedicalDirectory = Awaited<ReturnType<Window['api']['medical']['getDirectory']>>
type LabResultsSummary = Awaited<ReturnType<Window['api']['medical']['getLabResults']>>

/** Flag → badge color. Unflagged/normal renders no badge. */
const FLAG_STYLE: Record<string, string> = {
  low: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  'critical-low': 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
  'critical-high': 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
}

function FlagBadge({ flag }: { flag: string | null }): JSX.Element | null {
  if (!flag || flag === 'normal') return null
  return (
    <span
      className={cn(
        'text-[10px] font-medium px-1.5 py-0.5 rounded border uppercase tracking-wide',
        FLAG_STYLE[flag] ?? 'bg-muted text-muted-foreground border-border'
      )}
    >
      {flag.replace('-', ' ')}
    </span>
  )
}

export default function Health(): JSX.Element {
  const [summary, setSummary] = useState<HealthSummary | null>(null)
  const [medical, setMedical] = useState<MedicalSummary | null>(null)
  const [directory, setDirectory] = useState<MedicalDirectory | null>(null)
  const [labs, setLabs] = useState<LabResultsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setLoading(false)
      return
    }
    window.api.health
      .getSummary()
      .then((s) => setSummary(s))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false))
    // Medical records (Metriport) — optional; renders its own card when present.
    if (window.api.medical?.getSummary) {
      window.api.medical
        .getSummary()
        .then((m) => setMedical(m))
        .catch(() => setMedical(null))
    }
    // The deduped medications/conditions directory (falls back to the flat list
    // if the newer handler isn't present).
    if (window.api.medical?.getDirectory) {
      window.api.medical
        .getDirectory()
        .then((d) => setDirectory(d))
        .catch(() => setDirectory(null))
    }
    // Quantitative lab/vital trends — renders its own card when present.
    if (window.api.medical?.getLabResults) {
      window.api.medical
        .getLabResults()
        .then((l) => setLabs(l))
        .catch(() => setLabs(null))
    }
  }, [])

  if (loading)
    return <p className="p-8 pt-14 text-sm text-muted-foreground">Loading health summary…</p>
  if (!summary)
    return <p className="p-8 pt-14 text-sm text-muted-foreground">Health summary unavailable.</p>

  const anyData = summary.sources.some((s) => s.hasData)
  const o = summary.oura

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Health</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Sleep, activity, and recovery — unified from Oura and any Apple Health / Fitbit / Garmin
          exports you've dropped in.
        </p>
      </header>

      {/* Source coverage */}
      <div className="flex flex-wrap gap-2 mb-6">
        {summary.sources.map((s) => (
          <span
            key={s.source}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full border',
              s.hasData
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-muted text-muted-foreground'
            )}
            title={
              s.hasData
                ? `${s.count.toLocaleString('en-US')} records · ${s.firstDate} → ${s.lastDate}`
                : 'No data yet'
            }
          >
            {SOURCE_LABEL[s.source] ?? s.source}
            {s.hasData ? ` · ${s.count.toLocaleString('en-US')}` : ''}
          </span>
        ))}
      </div>

      {!anyData ? (
        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <HeartPulse className="mx-auto mb-3 text-muted-foreground" size={28} />
          <p className="text-sm text-foreground font-medium">No health data yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Connect Oura in Integrations, or drop an Apple Health <code>export.xml</code> / Fitbit /
            Garmin export into the Timeline Drop Zone. This hub fills in automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Headline stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard
              icon={<Footprints size={15} />}
              label="Steps · 7-day avg"
              value={fmtInt(summary.steps.last7Avg)}
              sub={summary.steps.best ? `Best ${fmtInt(summary.steps.best.steps)}` : undefined}
            />
            <StatCard
              icon={<Moon size={15} />}
              label="Sleep · 7-day avg"
              value={fmtHrs(summary.sleep.last7AvgMin)}
              sub={
                o.hasData && o.sleepScore7Avg != null
                  ? `Score ${fmtInt(o.sleepScore7Avg)}`
                  : undefined
              }
            />
            <StatCard
              icon={<Activity size={15} />}
              label="Active days · 30d"
              value={`${summary.activeDays30}`}
              sub={`≥ ${summary.stepGoal.toLocaleString('en-US')} steps or a workout`}
            />
            <StatCard
              icon={<HeartPulse size={15} />}
              label="Resting HR"
              value={summary.restingHr.latest ? `${summary.restingHr.latest.bpm} bpm` : '—'}
              sub={
                summary.restingHr.last30Avg != null
                  ? `30d avg ${fmtInt(summary.restingHr.last30Avg)}`
                  : undefined
              }
            />
            <StatCard
              icon={<Dumbbell size={15} />}
              label="Workouts · 30d"
              value={`${summary.workouts.last30Count}`}
            />
            <StatCard
              icon={<Scale size={15} />}
              label="Weight"
              value={
                summary.weight.latest
                  ? `${fmtInt(summary.weight.latest.value)} ${summary.weight.latest.unit}`
                  : '—'
              }
              sub={summary.weight.latest?.date}
            />
          </div>

          {/* Steps trend */}
          {summary.steps.series.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-3">
                <TrendingUp size={15} />
                <span className="text-xs font-medium">
                  Steps · last {summary.steps.series.length} days (30-day avg{' '}
                  {fmtInt(summary.steps.last30Avg)})
                </span>
              </div>
              <Bars data={summary.steps.series.map((p) => ({ date: p.date, value: p.steps }))} />
            </div>
          )}

          {/* Oura recovery scores */}
          {o.hasData && o.latest && (
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs font-medium text-muted-foreground mb-3">
                Oura recovery · latest {o.latest.date}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['Sleep', o.latest.sleepScore, o.sleepScore7Avg],
                    ['Readiness', o.latest.readinessScore, o.readiness7Avg],
                    ['Activity', o.latest.activityScore, o.activity7Avg]
                  ] as const
                ).map(([label, latest, avg7]) => (
                  <div key={label} className="text-center">
                    <div className="text-2xl font-semibold text-foreground">{fmtInt(latest)}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="text-[10px] text-muted-foreground/70">7d {fmtInt(avg7)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent workouts */}
          {summary.workouts.recent.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs font-medium text-muted-foreground mb-3">Recent workouts</div>
              <ul className="space-y-1.5">
                {summary.workouts.recent.map((w, i) => (
                  <li
                    key={`${w.date}-${w.title}-${i}`}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-foreground">{w.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {w.date} · {SOURCE_LABEL[w.source] ?? w.source}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Medical records (Metriport FHIR) — renders independently of wearable data. */}
      {medical?.hasData && (
        <div className="bg-card border border-border rounded-xl p-4 mt-6">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <HeartPulse size={15} />
            <span className="text-xs font-medium">
              Medical records · {medical.count} from Metriport
              {medical.lastDate ? ` · latest ${medical.lastDate}` : ''}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatCard
              icon={<HeartPulse size={15} />}
              label="Active conditions"
              value={fmtInt(medical.activeConditions)}
            />
            <StatCard
              icon={<HeartPulse size={15} />}
              label="Medications"
              value={fmtInt(medical.byCategory.medication ?? 0)}
            />
            <StatCard
              icon={<HeartPulse size={15} />}
              label="Immunizations"
              value={fmtInt(medical.byCategory.immunization ?? 0)}
            />
            <StatCard
              icon={<HeartPulse size={15} />}
              label="Labs"
              value={fmtInt(medical.byCategory.lab ?? 0)}
            />
          </div>
          <MedicalDirectoryList
            title="Conditions"
            entries={directory?.conditions ?? medicalFallback(medical.conditions)}
          />
          <MedicalDirectoryList
            title="Medications"
            entries={directory?.medications ?? medicalFallback(medical.medications)}
          />
        </div>
      )}

      {/* Lab/vital results (manually/document-imported) — quantitative, unlike medical records. */}
      {labs?.hasData && (
        <div className="bg-card border border-border rounded-xl p-4 mt-6">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <HeartPulse size={15} />
            <span className="text-xs font-medium">
              Lab &amp; vital results · {labs.count} value{labs.count === 1 ? '' : 's'}
              {labs.lastDate ? ` · latest ${labs.lastDate}` : ''}
              {labs.abnormalCount > 0
                ? ` · ${labs.abnormalCount} flagged out of range`
                : ' · all in normal range'}
            </span>
          </div>
          <ul className="space-y-1.5">
            {labs.series.map((s) => (
              <li
                key={s.testName}
                className="flex items-center justify-between text-sm gap-3 py-1 border-b border-border/50 last:border-0"
              >
                <span className="text-foreground min-w-0 truncate">
                  {s.testName}
                  {s.panel && (
                    <span className="text-xs text-muted-foreground ml-1.5">{s.panel}</span>
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-foreground font-medium">
                    {s.latest.value != null ? s.latest.value : (s.latest.valueText ?? '—')}
                    {s.latest.unit ? ` ${s.latest.unit}` : ''}
                  </span>
                  <FlagBadge flag={s.latest.flag} />
                  <span className="text-xs text-muted-foreground">{s.latest.takenAt}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Adapt the flat summary list to directory entries when the directory handler is absent. */
function medicalFallback(
  items: Array<{ description: string; status: string | null; date: string | null }>
): MedicalDirectoryEntry[] {
  return items.map((i) => ({
    name: i.description,
    code: null,
    count: 1,
    status: i.status,
    firstDate: i.date,
    lastDate: i.date
  }))
}

/** A deduped medical directory section (each name once, with count + date span). */
function MedicalDirectoryList({
  title,
  entries
}: {
  title: string
  entries: MedicalDirectoryEntry[]
}): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs font-medium text-muted-foreground mb-1.5">
        {title} <span className="text-muted-foreground/60">· {entries.length}</span>
      </div>
      <ul className="space-y-1">
        {entries.slice(0, 12).map((e) => {
          const span =
            e.firstDate && e.lastDate && e.firstDate !== e.lastDate
              ? `${e.firstDate} → ${e.lastDate}`
              : (e.lastDate ?? '')
          return (
            <li key={e.name} className="flex items-center justify-between text-sm gap-3">
              <span className="text-foreground min-w-0 truncate">
                {e.name}
                {e.count > 1 && (
                  <span className="text-xs text-muted-foreground ml-1.5">×{e.count}</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {[e.status, span].filter((p): p is string => Boolean(p)).join(' · ')}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
