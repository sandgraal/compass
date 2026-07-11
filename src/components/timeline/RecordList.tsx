/**
 * Day-grouped record list with rollups (Timeline 2.0, PR 4). Same-day bursts
 * of one (source, kind) — 300 track listens, 40 telemetry pings — collapse
 * into a single digest row ("312 Listened · Amazon Music") with the newest
 * few titles as a preview and one click to expand. Rollup grouping is
 * client-side over the loaded page (the list is server-capped anyway), so it
 * works identically for browse, range, and search slices.
 */

import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { groupRecordsForDisplay } from '../../lib/timeline-rollups'
import { RecordRow, sourceColor, sourceMeta, typeLabel } from './timeline-meta'

export function RecordList({
  records,
  onOpenRecord
}: {
  records: TimelineRecord[]
  onOpenRecord: (record: TimelineRecord) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const groups = groupRecordsForDisplay(records)

  function toggle(day: string, key: string): void {
    const id = `${day}|${key}`
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        // Timeline spine: a rail down the left with a node dot at each day.
        <div key={g.day} className="relative pl-6">
          <span aria-hidden className="absolute left-[7px] top-2 bottom-0 w-px bg-border" />
          <span
            aria-hidden
            className="absolute left-[3px] top-[5px] w-2.5 h-2.5 rounded-full bg-primary/60 ring-2 ring-background"
          />
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {g.day}
          </h2>
          <div className="space-y-1.5">
            {g.singles.map((r) => (
              <RecordRow key={r.id} record={r} onOpen={onOpenRecord} />
            ))}
            {g.rollups.map((roll) => {
              const isOpen = expanded.has(`${g.day}|${roll.key}`)
              const meta = sourceMeta(roll.source)
              const color = sourceColor(roll.source)
              const preview = roll.rows
                .slice(0, 3)
                .map((r) => r.title)
                .join(' · ')
              return (
                <Fragment key={roll.key}>
                  <button
                    type="button"
                    onClick={() => toggle(g.day, roll.key)}
                    aria-expanded={isOpen}
                    style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                    className="w-full text-left flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 hover:border-primary/40 transition-colors"
                  >
                    <span
                      className={color ? 'shrink-0' : 'text-muted-foreground shrink-0'}
                      style={color ? { color } : undefined}
                      title={meta.label}
                    >
                      {meta.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        {typeLabel(roll.type)} · {meta.label}
                      </p>
                      {!isOpen && (
                        <p className="text-xs text-muted-foreground truncate">{preview}</p>
                      )}
                    </div>
                    <span className="text-xs font-semibold text-primary px-2 py-0.5 bg-primary/15 rounded-full shrink-0 tabular-nums">
                      {roll.rows.length}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="ml-5 border-l border-border pl-3 space-y-1.5">
                      {roll.rows.map((r) => (
                        <RecordRow key={r.id} record={r} onOpen={onOpenRecord} />
                      ))}
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
