import { AlertTriangle, Calendar, CheckSquare, Inbox, Sparkles, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cn, formatTime } from '../lib/utils'

/**
 * Morning Brief card (Phase 7 Track A) — one glanceable digest of what matters
 * today, backed by the single `morning-brief:get` aggregator. Renders nothing
 * until the digest loads (and stays hidden outside Electron / on error) so it
 * never shows an empty shell.
 */
export function MorningBrief(): JSX.Element | null {
  const [brief, setBrief] = useState<MorningBrief | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.morningBrief) return
    window.api.morningBrief
      .get()
      .then(setBrief)
      .catch(() => setBrief(null))
  }, [])

  if (!brief) return null

  const sections: Array<{
    key: string
    icon: JSX.Element
    label: string
    count: number
    to: string
    lines: string[]
  }> = [
    {
      key: 'calendar',
      icon: <Calendar size={15} className="text-sky-400" />,
      label: 'Events',
      count: brief.calendar.count,
      to: '/daily',
      lines: brief.calendar.events.map(
        (e) => `${e.allDay || !e.startAt ? 'All day' : formatTime(e.startAt)} · ${e.title}`
      )
    },
    {
      key: 'tasks',
      icon: <CheckSquare size={15} className="text-primary" />,
      label: 'Tasks due',
      count: brief.tasks.dueCount,
      to: '/daily',
      lines: brief.tasks.items.map((t) => t.title)
    },
    {
      key: 'payments',
      icon: <Wallet size={15} className="text-amber-400" />,
      label: 'Payments',
      count: brief.payments.count,
      to: '/finance',
      lines: brief.payments.items.map(
        (p) =>
          `${p.name} · ${p.daysRemaining === 0 ? 'today' : `in ${p.daysRemaining}d`}${p.minPayment > 0 ? ` ($${p.minPayment})` : ''}`
      )
    },
    {
      key: 'inbox',
      icon: <Inbox size={15} className="text-emerald-400" />,
      label: 'Inbox',
      count: brief.inbox.count,
      to: '/daily',
      lines: brief.inbox.items.map((m) => m.subject)
    }
  ]

  return (
    <div className="bg-card border border-border rounded-xl mb-8 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <Sparkles size={16} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Today's brief</h2>
        <span className="text-xs text-muted-foreground ml-auto">{brief.summary}</span>
      </div>
      {brief.lowCash.soonest && (
        <Link
          to="/finance"
          className="flex items-center gap-2 px-5 py-2.5 bg-amber-500/10 border-b border-amber-500/30 hover:bg-amber-500/15 transition-colors"
        >
          <AlertTriangle size={14} className="text-amber-400 shrink-0" />
          <span className="text-xs text-amber-200">
            <span className="font-semibold">Low cash ahead:</span>{' '}
            {brief.lowCash.soonest.accountName} projected to dip to $
            {brief.lowCash.soonest.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })}{' '}
            {brief.lowCash.soonest.daysRemaining <= 0
              ? 'today'
              : `in ${brief.lowCash.soonest.daysRemaining}d`}
            {brief.lowCash.count > 1 && ` · ${brief.lowCash.count} accounts affected`}
          </span>
        </Link>
      )}
      <div className="grid grid-cols-4 divide-x divide-border">
        {sections.map((s) => (
          <Link
            key={s.key}
            to={s.to}
            className="group px-5 py-4 hover:bg-secondary/40 transition-colors"
          >
            <div className="flex items-center gap-1.5">
              {s.icon}
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {s.label}
              </span>
            </div>
            <p
              className={cn(
                'text-2xl font-semibold mt-1',
                s.count === 0 ? 'text-muted-foreground/40' : 'text-foreground'
              )}
            >
              {s.count}
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {s.lines.slice(0, 3).map((line, idx) => (
                // Section-scoped positional key: line text isn't guaranteed
                // unique (duplicate titles/subjects/times are plausible), and
                // these lists are static per render (never reordered).
                <li key={`${s.key}-${idx}`} className="text-xs text-muted-foreground truncate">
                  {line}
                </li>
              ))}
              {s.count === 0 && (
                <li className="text-xs text-muted-foreground/50">Nothing — nice.</li>
              )}
            </ul>
          </Link>
        ))}
      </div>
    </div>
  )
}
