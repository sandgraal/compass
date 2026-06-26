import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { groupOnThisDay, yearsAgoLabel } from '../lib/on-this-day'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

/**
 * "On this day" memory card (Phase 10.7 "Connect" cont.) — surfaces records from
 * prior years sharing today's date, grouped by year. Renders nothing while loading,
 * on error, or when there's no history for today, so it's quiet by default. Each
 * memory deep-links to the Timeline pre-filtered to it (reusing the `?q=` seed).
 */
export function OnThisDay(): JSX.Element | null {
  const [records, setRecords] = useState<TimelineRecord[] | null>(null)

  useEffect(() => {
    if (!isElectron() || !window.api?.records) {
      setRecords([])
      return
    }
    window.api.records
      .onThisDay({ limit: 12 })
      .then(setRecords)
      .catch(() => setRecords([]))
  }, [])

  if (!records) return null
  const groups = groupOnThisDay(records, new Date())
  if (groups.length === 0) return null

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  return (
    <div className="bg-card border border-border rounded-xl mb-8 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <History size={16} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">On this day</h2>
        <span className="text-xs text-muted-foreground">· {today}</span>
        <Link to="/timeline" className="text-xs text-primary hover:underline ml-auto">
          Timeline →
        </Link>
      </div>
      <div className="divide-y divide-border">
        {groups.map((g) => (
          <div key={g.year} className="px-5 py-3">
            <div className="text-xs font-medium text-muted-foreground mb-1.5">
              {yearsAgoLabel(g.yearsAgo)} · {g.year}
            </div>
            <ul className="flex flex-col gap-1">
              {g.records.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/timeline?q=${encodeURIComponent(r.title)}`}
                    className="group flex items-baseline gap-2"
                    title={`See "${r.title}" on the timeline`}
                  >
                    <span className="text-sm text-foreground truncate transition-colors group-hover:text-primary">
                      {r.title}
                    </span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{r.source}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
