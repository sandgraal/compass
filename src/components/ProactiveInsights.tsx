import { Archive, Flame, Lightbulb, Tag, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../lib/utils'

type Insight = {
  kind: 'spending-anomaly' | 'uncategorized-spend' | 'habit-slippage' | 'stale-notes'
  severity: 'info' | 'warn'
  title: string
  detail: string
  route: string
}

const KIND_ICON: Record<Insight['kind'], JSX.Element> = {
  'spending-anomaly': <TrendingUp size={15} className="text-amber-400" />,
  'uncategorized-spend': <Tag size={15} className="text-sky-400" />,
  'habit-slippage': <Flame size={15} className="text-orange-400" />,
  'stale-notes': <Archive size={15} className="text-muted-foreground" />
}

/**
 * Proactive insights card (Phase 7 Track E) — local-only nudges computed by
 * `insights:get` (spending anomalies, uncategorized buildup, habit slippage,
 * stale notes). Renders nothing while loading, on error, or when there is
 * nothing to surface — a quiet card is the desired steady state.
 */
export function ProactiveInsights(): JSX.Element | null {
  const [insights, setInsights] = useState<Insight[] | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.insights) return
    window.api.insights
      .get()
      .then((r) => setInsights(r.insights))
      .catch(() => setInsights(null))
  }, [])

  if (!insights || insights.length === 0) return null

  return (
    <div className="bg-card border border-border rounded-xl mb-8 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <Lightbulb size={16} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Worth a look</h2>
        <span className="text-xs text-muted-foreground ml-auto">
          {insights.length} insight{insights.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="divide-y divide-border">
        {insights.map((insight) => (
          <Link
            key={`${insight.kind}-${insight.title}`}
            to={insight.route}
            className={cn(
              'flex items-start gap-3 px-5 py-3 transition-colors hover:bg-secondary/40',
              insight.severity === 'warn' && 'bg-amber-500/5'
            )}
          >
            <span className="mt-0.5 shrink-0">{KIND_ICON[insight.kind]}</span>
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{insight.title}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{insight.detail}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
