import { Activity } from 'lucide-react'
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

type Correlations = Awaited<ReturnType<Window['api']['insights']['correlations']>>

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const
const TOOLTIP_STYLE = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  fontSize: 12
} as const

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
  }, [])

  const hasCharts = !!corr && !!(corr.sleepVsSpend || corr.devVsRecovery || corr.calendarVsHabits)

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

      {loaded && !hasCharts && (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          No cross-domain correlations to chart yet. Connect more sources — sleep (Apple Health or
          Oura), finance, GitHub, calendar, and habits — and the relationships will appear here as
          the weeks stack up.
        </div>
      )}
    </div>
  )
}
