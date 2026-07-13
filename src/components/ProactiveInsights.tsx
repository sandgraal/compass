import {
  Activity,
  Archive,
  BellRing,
  CalendarClock,
  CalendarDays,
  Coffee,
  Flame,
  GitCommitHorizontal,
  Lightbulb,
  Moon,
  PiggyBank,
  Pin,
  PinOff,
  Repeat,
  ShoppingBag,
  Stethoscope,
  Tag,
  Target,
  TrendingUp,
  Users,
  Wallet,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../lib/utils'

type InsightsList = Awaited<ReturnType<Window['api']['insights']['list']>>
type LiveInsight = InsightsList['insights'][number]

// Mirror of the lifecycle layer's kind union (electron/ipc/insights.ts +
// 'series-anomaly' from insights-discovery.ts) — keep in sync (a missing kind
// renders icon-less, which is how the cross-domain kinds shipped broken
// before). The card is otherwise kind-agnostic.
const KIND_ICON: Record<LiveInsight['kind'], JSX.Element> = {
  'spending-anomaly': <TrendingUp size={15} className="text-amber-400" />,
  'uncategorized-spend': <Tag size={15} className="text-sky-400" />,
  'habit-slippage': <Flame size={15} className="text-orange-400" />,
  'stale-notes': <Archive size={15} className="text-muted-foreground" />,
  'goal-off-track': <Target size={15} className="text-amber-400" />,
  'renewal-due': <CalendarClock size={15} className="text-sky-400" />,
  'paycheck-anomaly': <Wallet size={15} className="text-amber-400" />,
  'utility-spike': <BellRing size={15} className="text-orange-400" />,
  // Cross-domain (leverage layer)
  'unused-subscription': <Repeat size={15} className="text-sky-400" />,
  'sleep-vs-spend': <Moon size={15} className="text-indigo-400" />,
  'savings-rate': <PiggyBank size={15} className="text-amber-400" />,
  'medical-out-of-pocket': <Stethoscope size={15} className="text-rose-400" />,
  'dev-productivity-vs-recovery': <GitCommitHorizontal size={15} className="text-emerald-400" />,
  'calendar-load-vs-habits': <CalendarDays size={15} className="text-violet-400" />,
  'commits-vs-calendar': <Users size={15} className="text-teal-400" />,
  'calendar-vs-spend': <ShoppingBag size={15} className="text-fuchsia-400" />,
  'commits-vs-spend': <Coffee size={15} className="text-orange-400" />,
  'series-anomaly': <Activity size={15} className="text-primary" />
}

/**
 * Proactive insights card (Phase 7 Track E + the cross-domain leverage layer) —
 * local-only nudges computed by `insights:list`: rule detectors plus
 * series anomalies, enriched with lifecycle state (new-since-last-visit,
 * pin-to-top, dismiss-to-silence). Renders nothing while loading, on error, or
 * when there is nothing to surface — a quiet card is the desired steady state.
 */
export function ProactiveInsights(): JSX.Element | null {
  const [list, setList] = useState<InsightsList | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)

  const refresh = useCallback(() => {
    if (typeof window === 'undefined' || !window.api?.insights) return
    window.api.insights
      .list()
      .then(setList)
      .catch(() => setList(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!list || (list.insights.length === 0 && list.dismissed.length === 0)) return null

  const dismiss = (key: string, dismissed: boolean): void => {
    window.api.insights
      .dismiss(key, dismissed)
      .then(refresh)
      .catch(() => undefined)
  }
  const pin = (key: string, pinned: boolean): void => {
    window.api.insights
      .pin(key, pinned)
      .then(refresh)
      .catch(() => undefined)
  }

  const row = (insight: LiveInsight, isDismissedRow: boolean): JSX.Element => (
    <Link
      key={insight.key}
      to={insight.route}
      className={cn(
        'group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-secondary/40',
        insight.severity === 'warn' && !isDismissedRow && 'bg-amber-500/5',
        isDismissedRow && 'opacity-60'
      )}
    >
      <span className="mt-0.5 shrink-0">{KIND_ICON[insight.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">
          {insight.title}
          {insight.isNew && !isDismissedRow && (
            <span className="ml-2 align-middle text-[10px] font-medium text-primary border border-primary/40 rounded px-1">
              NEW
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground mt-0.5">{insight.detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {isDismissedRow ? (
          <button
            type="button"
            aria-label="Restore insight"
            title="Restore"
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              dismiss(insight.key, false)
            }}
          >
            <Repeat size={13} />
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label={insight.pinned ? 'Unpin insight' : 'Pin insight'}
              title={insight.pinned ? 'Unpin' : 'Pin to top'}
              className={cn(
                'rounded p-1 transition-opacity hover:text-foreground',
                insight.pinned
                  ? 'text-primary opacity-100'
                  : 'text-muted-foreground opacity-0 group-hover:opacity-100'
              )}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                pin(insight.key, !insight.pinned)
              }}
            >
              {insight.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              type="button"
              aria-label="Dismiss insight"
              title="Dismiss — stop showing this"
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                dismiss(insight.key, true)
              }}
            >
              <X size={13} />
            </button>
          </>
        )}
      </span>
    </Link>
  )

  return (
    <div className="bg-card border border-border rounded-xl mb-8 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <Lightbulb size={16} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Worth a look</h2>
        <span className="text-xs text-muted-foreground ml-auto">
          {list.insights.length} insight{list.insights.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="divide-y divide-border">{list.insights.map((i) => row(i, false))}</div>
      {list.dismissed.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            className="w-full px-5 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? 'Hide' : 'Show'} {list.dismissed.length} dismissed
          </button>
          {showDismissed && (
            <div className="divide-y divide-border border-t border-border">
              {list.dismissed.map((i) => row(i, true))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
