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
import { RecordRow, sourceMeta, typeLabel } from './timeline-meta'

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
        <div key={g.day}>
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
                    className="w-full text-left flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 hover:border-primary/40 transition-colors"
                  >
                    <span className="text-muted-foreground shrink-0" title={meta.label}>
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
