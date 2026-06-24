import {
  Activity,
  ArrowLeftRight,
  BookOpen,
  Clock,
  CreditCard,
  Facebook,
  FileText,
  Film,
  Globe,
  Landmark,
  Linkedin,
  Mail,
  MessageSquare,
  Music,
  Package,
  Receipt,
  Search,
  Sparkles,
  Upload,
  Wallet,
  Youtube
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const SOURCE_META: Record<string, { label: string; icon: JSX.Element }> = {
  netflix: { label: 'Netflix', icon: <Film size={13} /> },
  spotify: { label: 'Spotify', icon: <Music size={13} /> },
  amazon: { label: 'Amazon', icon: <Package size={13} /> },
  paypal: { label: 'PayPal', icon: <Wallet size={13} /> },
  venmo: { label: 'Venmo', icon: <ArrowLeftRight size={13} /> },
  'credit-report': { label: 'Credit', icon: <CreditCard size={13} /> },
  'tax-document': { label: 'Tax', icon: <Receipt size={13} /> },
  'social-security': { label: 'Social Security', icon: <Landmark size={13} /> },
  document: { label: 'Document', icon: <FileText size={13} /> },
  linkedin: { label: 'LinkedIn', icon: <Linkedin size={13} /> },
  goodreads: { label: 'Goodreads', icon: <BookOpen size={13} /> },
  'apple-health': { label: 'Apple Health', icon: <Activity size={13} /> },
  email: { label: 'Email', icon: <Mail size={13} /> },
  youtube: { label: 'YouTube', icon: <Youtube size={13} /> },
  browser: { label: 'Browser', icon: <Globe size={13} /> },
  imessage: { label: 'Messages', icon: <MessageSquare size={13} /> },
  facebook: { label: 'Facebook', icon: <Facebook size={13} /> },
  generic: { label: 'Imported', icon: <FileText size={13} /> }
}
function sourceMeta(s: string): { label: string; icon: JSX.Element } {
  return SOURCE_META[s] ?? { label: s, icon: <FileText size={13} /> }
}

// Friendly labels for record kinds (the `type` column); unknown kinds fall back
// to a title-cased version of the raw value ("credit-report" → "Credit Report").
const TYPE_LABEL: Record<string, string> = {
  watch: 'Watched',
  listen: 'Listened',
  order: 'Orders',
  payment: 'Payments',
  post: 'Posts',
  comment: 'Comments',
  messages: 'Messages',
  reaction: 'Reactions',
  group: 'Groups',
  event: 'Events',
  marketplace: 'Marketplace',
  saved: 'Saved',
  search: 'Searches',
  page: 'Pages',
  'off-facebook': 'Off-Facebook',
  security: 'Security',
  location: 'Location',
  activity: 'Activity',
  book: 'Books',
  connection: 'Connections',
  email: 'Email',
  browse: 'Browsing',
  document: 'Documents'
}
function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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
/** "2019–2026" (or a single year) for the dated-records span — UTC to match the overview. */
function fmtSpan(earliest: number | null, latest: number | null): string {
  if (earliest == null || latest == null) return ''
  const a = new Date(earliest).getUTCFullYear()
  const b = new Date(latest).getUTCFullYear()
  return a === b ? `${a}` : `${a}–${b}`
}

export default function Timeline(): JSX.Element {
  const [items, setItems] = useState<TimelineRecord[]>([])
  const [onThisDay, setOnThisDay] = useState<TimelineRecord[]>([])
  const [stats, setStats] = useState<{
    total: number
    sources: number
    earliest: number | null
    latest: number | null
  } | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [facets, setFacets] = useState<{ sources: string[]; types: string[] }>({
    sources: [],
    types: []
  })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()

  // Search AND the source/kind filters all run server-side so they span the whole
  // timeline, not just the loaded 500-row page — a "PayPal" chip shows every PayPal
  // record, not only the ones near the top.
  const reload = useCallback((): void => {
    if (!isElectron()) return
    void window.api.records
      .list({
        q: query.trim() || undefined,
        source: source ?? undefined,
        type: type ?? undefined,
        limit: 500
      })
      .then(setItems)
  }, [query, source, type])

  // "On this day" recap (prior years, today's month/day) — independent of search.
  const loadOnThisDay = useCallback((): void => {
    if (!isElectron()) return
    void window.api.records.onThisDay({ limit: 8 }).then(setOnThisDay)
  }, [])

  // True totals + the full set of filter facets (the list is capped at 500, so
  // chips must come from the whole table, not the loaded page) — both independent
  // of the active search/filter.
  const loadStats = useCallback((): void => {
    if (!isElectron()) return
    void window.api.records.stats().then(setStats)
    void window.api.records.facets().then(setFacets)
  }, [])

  // Debounced — re-queries as the search text or active filters change (and on mount).
  useEffect(() => {
    const t = setTimeout(reload, 200)
    return () => clearTimeout(t)
  }, [reload])

  useEffect(() => {
    loadOnThisDay()
    loadStats()
  }, [loadOnThisDay, loadStats])

  function report(r: RecordsImportResult): void {
    if (r.canceled) return
    if (!r.success) {
      toast(r.error ?? 'Import failed', 'error')
      return
    }
    const parts: string[] = []
    if (r.imported) parts.push(`${r.imported} imported`)
    // Snapshot facts (e.g. the Ad Profile / Profile pages) are a successful import
    // too, even when nothing landed on the timeline — don't let a snapshot-only drop
    // read as a failure.
    if (r.snapshots) parts.push(`${r.snapshots} profile ${r.snapshots === 1 ? 'fact' : 'facts'}`)
    if (r.duplicates) parts.push(`${r.duplicates} already on your timeline`)
    if (r.unrecognized.length) parts.push(`${r.unrecognized.length} unrecognized`)
    const ok = r.imported > 0 || r.snapshots > 0
    toast(parts.join(' · ') || 'Nothing to import', ok ? 'success' : 'error')
    reload()
    loadOnThisDay()
    loadStats()
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

  // Chips come from the whole-timeline facets (not the loaded page), unioned with
  // the active filter so it stays clearable even if a concurrent search narrows the
  // table. Filtering itself is server-side now, so the loaded page IS the result.
  const sources = [...new Set([...facets.sources, ...(source ? [source] : [])])].sort()
  const types = [...new Set([...facets.types, ...(type ? [type] : [])])].sort()
  const shown = items
  const span = stats ? fmtSpan(stats.earliest, stats.latest) : ''
  // Active source/kind filter, joined for the empty-state message (e.g. "PayPal · Payments").
  const filterLabel = [source ? sourceMeta(source).label : null, type ? typeLabel(type) : null]
    .filter(Boolean)
    .join(' · ')

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
            {query ? (
              <>
                <span className="font-semibold text-foreground">{items.length}</span> record
                {items.length === 1 ? '' : 's'} matching your search
                {items.length === 500 ? ' (first 500 shown)' : ''}
              </>
            ) : stats && stats.total > 0 ? (
              <>
                <span className="font-semibold text-foreground">{stats.total}</span> record
                {stats.total === 1 ? '' : 's'} · {stats.sources} source
                {stats.sources === 1 ? '' : 's'}
                {span && ` · ${span}`}
              </>
            ) : items.length > 0 ? (
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

      {/* On this day — a memory from prior years, shown only in the default view */}
      {query === '' && source === null && type === null && onThisDay.length > 0 && (
        <div className="mb-6 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} className="text-primary" />
            <h2 className="text-sm font-semibold text-foreground">On this day</h2>
          </div>
          <div className="space-y-1">
            {onThisDay.map((r) => (
              <div key={r.id} className="flex items-center gap-2.5 text-sm">
                <span className="text-muted-foreground shrink-0" title={sourceMeta(r.source).label}>
                  {sourceMeta(r.source).icon}
                </span>
                <span className="text-foreground truncate">{r.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground/70 tabular-nums">
                  {r.occurredAt ? new Date(r.occurredAt).getUTCFullYear() : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      {(items.length > 0 || query) && (
        <div className="relative mb-4">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your timeline…"
            aria-label="Search your timeline"
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      )}

      {/* Source filter chips */}
      {(sources.length > 1 || source !== null) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <Chip active={source === null} onClick={() => setSource(null)}>
            All sources
          </Chip>
          {sources.map((s) => (
            <Chip key={s} active={source === s} onClick={() => setSource(s)}>
              {sourceMeta(s).icon}
              {sourceMeta(s).label}
            </Chip>
          ))}
        </div>
      )}

      {/* Kind filter chips — slice the whole timeline by type of activity */}
      {(types.length > 1 || type !== null) && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <Chip active={type === null} onClick={() => setType(null)}>
            All kinds
          </Chip>
          {types.map((t) => (
            <Chip key={t} active={type === t} onClick={() => setType(t)}>
              {typeLabel(t)}
            </Chip>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        query || source || type ? (
          // An active search/filter matched nothing (records exist; this slice is empty).
          // `filterLabel` carries its own trailing space only when present, so a
          // search-only miss reads "No records match …" without a double space.
          <p className="text-sm text-muted-foreground py-8 text-center">
            No {filterLabel ? `${filterLabel} ` : ''}records
            {query ? ` match “${query}”` : ''}.
          </p>
        ) : stats && stats.total === 0 ? (
          // The whole table is empty — first-run call to action.
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <p className="text-sm text-muted-foreground max-w-sm">
              Your timeline is empty. Export your data from a service you use (Netflix, Spotify, …)
              and drop the file above — it becomes a private, searchable, exportable timeline you
              own forever.
            </p>
          </div>
        ) : null /* still loading (stats not in yet) — don't flash an empty message */
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
