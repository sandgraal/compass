import { Activity, CheckCircle2, Circle } from 'lucide-react'
import { type JSX, useEffect, useState } from 'react'
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { ProactiveInsights } from '../components/ProactiveInsights'
import { cn } from '../lib/utils'

type Correlations = Awaited<ReturnType<Window['api']['insights']['correlations']>>
type PairReadiness = Correlations['readiness'][number]
type Discovery = Awaited<ReturnType<Window['api']['insights']['discovery']>>
type Discovered = Discovery['weekly'][number]

function perDay(v: number, unit: string | null): string {
  const n = v >= 100 ? Math.round(v).toLocaleString('en-US') : `${v}`
  return unit === '$' ? `$${n}/day` : `${n}/day`
}

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const
const TOOLTIP_STYLE = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  fontSize: 12
} as const

/**
 * How routines shifted around life anchors (medical events, trips) — per-day
 * metric means before vs after/during, computed by the discovery engine.
 */
function EventStudies({ events }: { events: Discovery['events'] }): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold text-foreground">Around your life events</h3>
      <p className="text-xs text-muted-foreground mt-0.5 mb-2">
        How your routines shifted around medical events and trips. Correlation, not causation.
      </p>
      <div className="divide-y divide-border">
        {events.map((ev) => (
          <div key={`${ev.kind}-${ev.date}-${ev.label}`} className="py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm text-foreground">{ev.label}</span>
              <span className="text-xs text-muted-foreground">
                {ev.date} · {ev.compareLabel}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
              {ev.deltas.map((d) => (
                <span key={d.id} className="text-xs text-muted-foreground">
                  <span className={d.pctChange > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {d.pctChange > 0 ? '▲' : '▼'}{' '}
                    {d.pctChange >= 4
                      ? `${Math.round(d.pctChange + 1)}×`
                      : `${Math.abs(Math.round(d.pctChange * 100))}%`}
                  </span>{' '}
                  {d.label.toLowerCase()} ({perDay(d.before, d.unit)} → {perDay(d.after, d.unit)})
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One discovered relationship as a scatter card (weekly or monthly buckets). */
function DiscoveredChart({ f }: { f: Discovered }): JSX.Element {
  const windowNoun = f.window === 'weekly' ? 'weeks' : 'months'
  return (
    <ChartCard
      title={`${f.x.label} vs ${f.y.label}`}
      caption={`${f.sentence} (ρ ${f.rho} across ${f.n} ${windowNoun} — correlation, not causation.)`}
    >
      <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          type="number"
          dataKey="x"
          name={f.x.label}
          tick={AXIS_TICK}
          tickFormatter={f.x.unit === '$' ? (v) => `$${Math.round(Number(v))}` : undefined}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={f.y.label}
          tick={AXIS_TICK}
          tickFormatter={f.y.unit === '$' ? (v) => `$${Math.round(Number(v))}` : undefined}
          width={56}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={f.points} fill="hsl(var(--primary))" />
      </ScatterChart>
    </ChartCard>
  )
}

/**
 * Per-pair readiness — replaces the old blind empty state. Ready pairs collapse
 * to one ✓ line; unready pairs show the first unmet gate as a hint plus every
 * check's progress, so the user always knows exactly what unlocks each chart.
 */
function ReadinessPanel({
  readiness,
  hasCharts
}: {
  readiness: PairReadiness[]
  hasCharts: boolean
}): JSX.Element {
  const allReady = readiness.every((r) => r.ready)
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold text-foreground">
        {allReady
          ? 'All charts unlocked'
          : hasCharts
            ? 'What the missing charts need'
            : 'No charts yet — here’s exactly what each one needs'}
      </h3>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">
        Each chart appears as soon as its checks pass — recomputed every time you open this page.
      </p>
      <div className="divide-y divide-border">
        {readiness.map((r) => (
          <div key={r.pair} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-center gap-2">
              {r.ready ? (
                <CheckCircle2 size={14} className="text-emerald-400 shrink-0" aria-hidden />
              ) : (
                <Circle size={14} className="text-muted-foreground/50 shrink-0" aria-hidden />
              )}
              <span className="text-sm text-foreground">{r.label}</span>
              {r.ready && <span className="text-xs text-emerald-400 ml-auto">charted above</span>}
            </div>
            {!r.ready && (
              <div className="mt-1.5 ml-6 space-y-1">
                {r.hint && <p className="text-xs text-muted-foreground">{r.hint}</p>}
                {r.checks.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {r.checks.map((c) => (
                      <span
                        key={c.id}
                        className={cn(
                          'text-xs',
                          c.met ? 'text-emerald-400' : 'text-muted-foreground'
                        )}
                      >
                        {c.met ? '✓' : '○'} {c.label}: {c.current}/{c.needed}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {r.caveats.map((caveat) => (
              <p key={caveat} className="mt-1 ml-6 text-xs text-amber-400">
                {caveat}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A titled card wrapping one responsive scatter. */
function ChartCard({
  title,
  caption,
  children
}: {
  title: string
  caption: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">{caption}</p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/**
 * Insights — the cross-domain correlations surface (leverage layer). Reuses the
 * `insights:get` nudge card up top, then charts the underlying paired series from
 * `insights:correlations` (which surface whenever there's enough data, even when
 * a nudge didn't cross its threshold). A quiet page is the desired steady state.
 */
export default function Insights(): JSX.Element {
  const [corr, setCorr] = useState<Correlations | null>(null)
  const [disc, setDisc] = useState<Discovery | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!isElectron() || !window.api.insights?.correlations) {
      setLoaded(true)
      return
    }
    window.api.insights
      .correlations()
      .then(setCorr)
      .catch(() => setCorr(null))
      .finally(() => setLoaded(true))
    window.api.insights
      .discovery?.()
      .then(setDisc)
      .catch(() => setDisc(null))
  }, [])

  const hasCharts =
    !!corr &&
    !!(
      corr.sleepVsSpend ||
      corr.devVsRecovery ||
      corr.calendarVsHabits ||
      corr.commitsVsCalendar ||
      corr.calendarVsSpend ||
      corr.commitsVsSpend
    )

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Activity size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Insights</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Cross-domain correlations from your own data — how sleep, spending, coding, calendar load,
          and habits move together. Nudges worth acting on up top; the relationships behind them
          below.
        </p>
      </div>

      <ProactiveInsights />

      {disc && disc.events.length > 0 && <EventStudies events={disc.events} />}

      {disc && disc.weekly.length + disc.monthly.length > 0 && (
        <div className="mt-2 mb-4">
          <h2 className="text-sm font-semibold text-foreground">Discovered relationships</h2>
          <p className="text-xs text-muted-foreground mt-0.5 mb-3">
            {disc.scanned.weekly + disc.scanned.monthly} cross-domain pairs scanned across your
            whole archive — these moved together consistently enough to be worth a look.
          </p>
          {disc.weekly.map((f) => (
            <DiscoveredChart key={f.id} f={f} />
          ))}
          {disc.monthly.map((f) => (
            <DiscoveredChart key={f.id} f={f} />
          ))}
        </div>
      )}

      {corr?.sleepVsSpend && (
        <ChartCard
          title="Sleep vs discretionary spend"
          caption={`Each dot is one week — ${corr.sleepVsSpend.source === 'oura' ? 'Oura sleep score' : 'hours slept'} against impulse spend. Down-and-right means better sleep, lighter spending.`}
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              type="number"
              dataKey="sleep"
              name={corr.sleepVsSpend.source === 'oura' ? 'Sleep score' : 'Hours'}
              tick={AXIS_TICK}
            />
            <YAxis
              type="number"
              dataKey="spend"
              name="Spend"
              tick={AXIS_TICK}
              tickFormatter={(v) => `$${Math.round(Number(v))}`}
              width={56}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={corr.sleepVsSpend.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {corr?.devVsRecovery && (
        <ChartCard
          title="Coding load vs recovery"
          caption={`Each dot is one day — commits against ${corr.devVsRecovery.axis}. ${corr.devVsRecovery.betterIsHigher ? 'Higher is better recovery' : 'Lower is better recovery'}.`}
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="commits" name="Commits" tick={AXIS_TICK} />
            <YAxis
              type="number"
              dataKey="recovery"
              name={corr.devVsRecovery.axis}
              tick={AXIS_TICK}
              width={56}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={corr.devVsRecovery.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {corr?.calendarVsHabits && (
        <ChartCard
          title="Calendar load vs habit completion"
          caption="Each dot is one week — calendar events against the share of habit check-ins you hit."
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="events" name="Events" tick={AXIS_TICK} />
            <YAxis
              type="number"
              dataKey="completionRate"
              name="Completion"
              tick={AXIS_TICK}
              domain={[0, 1]}
              tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
              width={48}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(value, name) =>
                name === 'Completion' ? `${Math.round(Number(value) * 100)}%` : value
              }
            />
            <Scatter data={corr.calendarVsHabits.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {corr?.commitsVsCalendar && (
        <ChartCard
          title="Meetings vs coding activity"
          caption="Each dot is one week — calendar events against GitHub activity (commits + PRs). Down-and-right means meeting-heavy weeks cut your coding throughput."
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="events" name="Events" tick={AXIS_TICK} />
            <YAxis type="number" dataKey="activity" name="Activity" tick={AXIS_TICK} width={48} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={corr.commitsVsCalendar.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {corr?.calendarVsSpend && (
        <ChartCard
          title="Calendar load vs discretionary spend"
          caption="Each dot is one week — calendar events against impulse spend. Up-and-right means busier weeks lean harder on takeout and impulse buys."
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="events" name="Events" tick={AXIS_TICK} />
            <YAxis
              type="number"
              dataKey="spend"
              name="Spend"
              tick={AXIS_TICK}
              tickFormatter={(v) => `$${Math.round(Number(v))}`}
              width={56}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={corr.calendarVsSpend.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {corr?.commitsVsSpend && (
        <ChartCard
          title="Coding activity vs discretionary spend"
          caption="Each dot is one week — GitHub activity (commits + PRs) against impulse spend. Up-and-right means heavy coding weeks come with heavier spending."
        >
          <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="activity" name="Activity" tick={AXIS_TICK} />
            <YAxis
              type="number"
              dataKey="spend"
              name="Spend"
              tick={AXIS_TICK}
              tickFormatter={(v) => `$${Math.round(Number(v))}`}
              width={56}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={corr.commitsVsSpend.points} fill="hsl(var(--primary))" />
          </ScatterChart>
        </ChartCard>
      )}

      {loaded && corr?.readiness && (
        <ReadinessPanel readiness={corr.readiness} hasCharts={hasCharts} />
      )}

      {loaded && !corr && (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          No cross-domain correlations to chart yet. Connect more sources — sleep (Apple Health or
          Oura), finance, GitHub, calendar, and habits — and the relationships will appear here as
          the weeks stack up.
        </div>
      )}
    </div>
  )
}
