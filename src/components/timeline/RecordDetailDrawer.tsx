/**
 * Record detail drawer (Timeline 2.0, PR 4) — the beta panel's unanimous ask:
 * tap any record and see the whole story. Full title/body, source + kind,
 * local time, the import file it came from (provenance), the raw original row
 * (payload, collapsible), and actions: "Find similar" (pre-fills timeline
 * search) and copy. Closes on backdrop click or Escape.
 */

import { Copy, EyeOff, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '../ui/Toast'
import { fmtDay, fmtTime, payloadFacts, sourceColor, sourceMeta, typeLabel } from './timeline-meta'

export function RecordDetailDrawer({
  record,
  onClose,
  onFindSimilar,
  onPivotSource,
  onMute
}: {
  record: TimelineRecord
  onClose: () => void
  onFindSimilar: (query: string) => void
  /** "See all <source>" pivot — jump to Browse filtered to this record's source. */
  onPivotSource?: (source: string) => void
  /** "Never resurface" (memory mutes) — omit to hide the mute actions. */
  onMute?: (kind: 'record' | 'source-type', target: string) => void
}): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  const { toast } = useToast()
  const meta = sourceMeta(record.source)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The payload column keeps the ORIGINAL export row as JSON — pretty-print it
  // when it parses, fall back to the raw text otherwise.
  let payloadPretty: string | null = null
  if (record.payload) {
    try {
      payloadPretty = JSON.stringify(JSON.parse(record.payload), null, 2)
    } catch {
      payloadPretty = record.payload
    }
  }
  // Structured facts parsed from that payload, shown above the raw dump.
  const facts = payloadFacts(record.payload)
  const color = sourceColor(record.source)

  async function copyDetails(): Promise<void> {
    const lines = [
      record.title,
      record.body ?? '',
      `${meta.label} · ${typeLabel(record.type)} · ${fmtDay(record.occurredAt)} ${fmtTime(record.occurredAt)}`.trim(),
      record.provenance ? `From ${record.provenance}` : ''
    ].filter(Boolean)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast('Copied to clipboard', 'success')
    } catch {
      toast('Could not copy', 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 animate-fade-in">
      {/* Backdrop — a real button so closing works by keyboard too. */}
      <button
        type="button"
        aria-label="Close record details"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal() plumbing; role="dialog" + aria-modal on the drawer is the intended semantics here */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Record details"
        className="absolute right-0 top-0 h-full w-full max-w-md bg-background border-l border-border shadow-2xl overflow-y-auto animate-fade-in"
      >
        <div
          className="flex items-center gap-2.5 px-5 py-4 border-b border-border sticky top-0 bg-background"
          style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
        >
          <span
            className={color ? '' : 'text-muted-foreground'}
            style={color ? { color } : undefined}
          >
            {meta.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {meta.label} · {typeLabel(record.type)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {fmtDay(record.occurredAt)}
              {fmtTime(record.occurredAt) && ` · ${fmtTime(record.occurredAt)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            title="Close"
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              Record
            </p>
            <p className="text-sm text-foreground">{record.title}</p>
            {record.body && <p className="text-sm text-muted-foreground mt-1">{record.body}</p>}
          </div>

          {record.provenance && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Imported from
              </p>
              <p className="text-sm text-foreground font-mono break-all">{record.provenance}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onFindSimilar(record.title)}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border hover:bg-secondary text-foreground transition-colors"
            >
              <Search size={13} /> Find similar
            </button>
            {onPivotSource && (
              <button
                type="button"
                onClick={() => onPivotSource(record.source)}
                title={`Browse everything from ${meta.label}`}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border hover:bg-secondary text-foreground transition-colors"
              >
                <span style={color ? { color } : undefined}>{meta.icon}</span> All {meta.label}
              </button>
            )}
            <button
              type="button"
              onClick={copyDetails}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border hover:bg-secondary text-foreground transition-colors"
            >
              <Copy size={13} /> Copy
            </button>
          </div>

          {onMute && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Memories
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onMute('record', String(record.id))}
                  title="This record stays on the timeline but never resurfaces in On this day"
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                >
                  <EyeOff size={13} /> Never resurface this
                </button>
                <button
                  type="button"
                  onClick={() => onMute('source-type', `${record.source}|${record.type}`)}
                  title={`No ${meta.label} · ${typeLabel(record.type)} records will resurface in On this day`}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                >
                  <EyeOff size={13} /> Mute {meta.label} · {typeLabel(record.type)}
                </button>
              </div>
            </div>
          )}

          {facts.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Details
              </p>
              <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5">
                {facts.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-xs text-muted-foreground truncate">{f.label}</dt>
                    <dd className="text-xs text-foreground break-words">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {payloadPretty && (
            <div>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                aria-expanded={showRaw}
                className="text-xs text-primary hover:underline"
              >
                {showRaw ? 'Hide original data' : 'Show original data'}
              </button>
              {showRaw && (
                <pre className="mt-2 rounded-lg bg-secondary p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all max-h-96">
                  {payloadPretty}
                </pre>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
