import { Clock, FileText, Film, Music, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const SOURCE_META: Record<string, { label: string; icon: JSX.Element }> = {
  netflix: { label: 'Netflix', icon: <Film size={13} /> },
  spotify: { label: 'Spotify', icon: <Music size={13} /> },
  generic: { label: 'Imported', icon: <FileText size={13} /> }
}
function sourceMeta(s: string): { label: string; icon: JSX.Element } {
  return SOURCE_META[s] ?? { label: s, icon: <FileText size={13} /> }
}

function fmtDay(ms: number | null): string {
  if (ms == null) return 'Undated'
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
function fmtTime(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms)
  // Hide the time for date-only records (parsed as local midnight).
  if (d.getHours() === 0 && d.getMinutes() === 0) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function Timeline(): JSX.Element {
  const [items, setItems] = useState<TimelineRecord[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    if (!isElectron()) return
    setItems(await window.api.records.list({ limit: 500 }))
  }

  function report(r: RecordsImportResult): void {
    if (r.canceled) return
    if (!r.success) {
      toast(r.error ?? 'Import failed', 'error')
      return
    }
    const parts: string[] = []
    if (r.imported) parts.push(`${r.imported} imported`)
    if (r.duplicates) parts.push(`${r.duplicates} already on your timeline`)
    if (r.unrecognized.length) parts.push(`${r.unrecognized.length} unrecognized`)
    toast(parts.join(' · ') || 'Nothing to import', r.imported > 0 ? 'success' : 'error')
    void load()
  }

  async function pickFiles(): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      report(await window.api.records.importFiles())
    } finally {
      setBusy(false)
    }
  }

  async function onDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    if (!isElectron()) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = window.api.records.pathsForFiles(files).filter(Boolean)
    if (paths.length === 0) {
      toast('Could not read the dropped file(s).', 'error')
      return
    }
    setBusy(true)
    try {
      report(await window.api.records.importPaths(paths))
    } finally {
      setBusy(false)
    }
  }

  const sources = [...new Set(items.map((i) => i.source))].sort()
  const shown = source ? items.filter((i) => i.source === source) : items

  // Records arrive newest-first, so consecutive same-day rows bucket cleanly.
  const groups: { day: string; rows: TimelineRecord[] }[] = []
  for (const r of shown) {
    const day = fmtDay(r.occurredAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.rows.push(r)
    else groups.push({ day, rows: [r] })
  }

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <Clock size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Timeline</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {items.length > 0 ? (
              <>
                <span className="font-semibold text-foreground">{items.length}</span> record
                {items.length === 1 ? '' : 's'} imported from your data exports
              </>
            ) : (
              'Bring your history home — drop a data export to begin'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={pickFiles}
          disabled={busy}
          className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
        >
          <Upload size={14} /> {busy ? 'Importing…' : 'Import'}
        </button>
      </div>

      {/* Drop zone */}
      <button
        type="button"
        onClick={pickFiles}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'w-full mb-6 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 bg-card/40'
        )}
      >
        <Upload size={22} className="mx-auto mb-2 text-muted-foreground" />
        <span className="block text-sm text-foreground font-medium">Drop a data export here</span>
        <span className="block text-xs text-muted-foreground mt-1">
          Netflix viewing history, Spotify streaming history, or any dated CSV / JSON. Nothing
          leaves your machine.
        </span>
      </button>

      {/* Source filter chips */}
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <Chip active={source === null} onClick={() => setSource(null)}>
            All
          </Chip>
          {sources.map((s) => (
            <Chip key={s} active={source === s} onClick={() => setSource(s)}>
              {sourceMeta(s).icon}
              {sourceMeta(s).label}
            </Chip>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <p className="text-sm text-muted-foreground max-w-sm">
              Your timeline is empty. Export your data from a service you use (Netflix, Spotify, …)
              and drop the file above — it becomes a private, searchable, exportable timeline you
              own forever.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">No {source} records.</p>
        )
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.day}>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {g.day}
              </h2>
              <div className="space-y-1.5">
                {g.rows.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5"
                  >
                    <span
                      className="text-muted-foreground shrink-0"
                      title={sourceMeta(r.source).label}
                    >
                      {sourceMeta(r.source).icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{r.title}</p>
                      {r.body && <p className="text-xs text-muted-foreground">{r.body}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground/70 shrink-0 tabular-nums">
                      {fmtTime(r.occurredAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors capitalize',
        active
          ? 'border-primary/50 bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
