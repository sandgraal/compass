/**
 * Timeline (Timeline 2.0, PR 4) — the "story of your life" surface.
 *
 * Two lenses over the records spine, plus search across both:
 *  - THIS DAY (default): the all-years "On this day" hero — year-grouped
 *    memories for any month-day, ◀ ▶ browsable (records:on-this-day-v2).
 *  - BROWSE: year scrubber + month drill-down (records:histogram) over the
 *    newest-first list, with multi-select source/kind chips, "Load earlier"
 *    pagination, and same-day noise collapsed into digest rows.
 * Every record opens the detail drawer (payload, provenance, find-similar).
 * Import stays one drag-drop away: the whole page is a drop target.
 */

import { Clock, Globe, Search, Sparkles, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { OnThisDayHero } from '../components/timeline/OnThisDayHero'
import { RecordDetailDrawer } from '../components/timeline/RecordDetailDrawer'
import { RecordList } from '../components/timeline/RecordList'
import { type TimelineRange, YearScrubber } from '../components/timeline/YearScrubber'
import { Chip, fmtSpan, sourceMeta, typeLabel } from '../components/timeline/timeline-meta'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const PAGE_SIZE = 500
const VIEW_SETTING_KEY = 'timelineView'
type View = 'day' | 'browse'

export default function Timeline(): JSX.Element {
  const [view, setView] = useState<View>('day')
  const [items, setItems] = useState<TimelineRecord[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const offsetRef = useRef(0)
  const [stats, setStats] = useState<{
    total: number
    sources: number
    earliest: number | null
    latest: number | null
    firehose: number
  } | null>(null)
  // Multi-select filters (Timeline 2.0): every selected chip is included.
  const [sourcesSel, setSourcesSel] = useState<string[]>([])
  const [typesSel, setTypesSel] = useState<string[]>([])
  // Curate: collapse firehose sources (browser history, export telemetry) from
  // the default browse. Off by default; revealable, never deleted.
  const [showFirehose, setShowFirehose] = useState(false)
  const [range, setRange] = useState<TimelineRange>(null)
  const [facets, setFacets] = useState<{ sources: string[]; types: string[] }>({
    sources: [],
    types: []
  })
  // Seed the search from a ?q= param so deep links (e.g. the People page's "see
  // everything involving X") land with the search pre-filled.
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '')
  const [semantic, setSemantic] = useState(false)
  const [semStatus, setSemStatus] = useState<{
    available: boolean
    building: boolean
    count: number
  } | null>(null)
  const [detail, setDetail] = useState<TimelineRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()

  const searching = query.trim() !== ''

  // Restore the last-used lens (fire-and-forget persistence via app_settings).
  useEffect(() => {
    if (!isElectron()) return
    let canceled = false
    void window.api.settings.get(VIEW_SETTING_KEY).then((v) => {
      if (canceled) return
      if (v === 'browse' || v === 'day') setView((prev) => (prev === 'day' ? v : prev))
    })
    return () => {
      canceled = true
    }
  }, [])
  function switchView(next: View): void {
    setView(next)
    if (isElectron()) void window.api.settings.set(VIEW_SETTING_KEY, next)
  }

  // Search AND all filters run server-side so they span the whole timeline, not
  // just the loaded page — a "PayPal" chip shows every PayPal record.
  const reload = useCallback((): void => {
    if (!isElectron()) return
    const q = query.trim()
    offsetRef.current = 0
    if (q) {
      // Ranked FTS (or the opt-in semantic index) across the whole timeline; hits
      // re-sorted newest-first so they read as a timeline slice. The search API
      // takes ONE source/type — with one chip selected it pushes server-side,
      // with several the (≤200) hits are narrowed client-side.
      void window.api.records
        .search({
          q,
          source: sourcesSel.length === 1 ? sourcesSel[0] : undefined,
          type: typesSel.length === 1 ? typesSel[0] : undefined,
          from: range?.from ?? undefined,
          to: range?.to ?? undefined,
          limit: 200,
          mode: semantic ? 'semantic' : undefined
        })
        .then((hits) => {
          let rows: TimelineRecord[] = hits.map((h) => ({
            id: h.id,
            source: h.source,
            type: h.type,
            occurredAt: h.occurredAt,
            title: h.title,
            body: h.body,
            payload: null,
            provenance: null,
            ingestedAt: null
          }))
          if (sourcesSel.length > 1) rows = rows.filter((r) => sourcesSel.includes(r.source))
          if (typesSel.length > 1) rows = rows.filter((r) => typesSel.includes(r.type))
          rows.sort(
            (a, b) =>
              (b.occurredAt ?? Number.NEGATIVE_INFINITY) -
              (a.occurredAt ?? Number.NEGATIVE_INFINITY)
          )
          setItems(rows)
          setHasMore(false)
        })
      return
    }
    // Empty query → browse (newest-first, server-paginated). Firehose stays
    // collapsed only in the fully-unfiltered browse — explicit chips are the
    // user narrowing, so include it then.
    void window.api.records
      .list({
        sources: sourcesSel.length > 0 ? sourcesSel : undefined,
        types: typesSel.length > 0 ? typesSel : undefined,
        from: range?.from ?? undefined,
        to: range?.to ?? undefined,
        limit: PAGE_SIZE,
        includeFirehose: showFirehose || typesSel.length > 0
      })
      .then((rows) => {
        setItems(rows)
        setHasMore(rows.length === PAGE_SIZE)
      })
  }, [query, sourcesSel, typesSel, range, semantic, showFirehose])

  async function loadEarlier(): Promise<void> {
    if (!isElectron() || loadingMore) return
    setLoadingMore(true)
    try {
      offsetRef.current += PAGE_SIZE
      const rows = await window.api.records.list({
        sources: sourcesSel.length > 0 ? sourcesSel : undefined,
        types: typesSel.length > 0 ? typesSel : undefined,
        from: range?.from ?? undefined,
        to: range?.to ?? undefined,
        limit: PAGE_SIZE,
        offset: offsetRef.current,
        includeFirehose: showFirehose || typesSel.length > 0
      })
      setItems((prev) => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } finally {
      setLoadingMore(false)
    }
  }

  // Status of the opt-in local semantic index (whether "search by meaning" is ready).
  const loadSemStatus = useCallback((): void => {
    if (!isElectron()) return
    void window.api.records
      .semanticStatus()
      .then((s) => setSemStatus({ available: s.available, building: s.building, count: s.count }))
  }, [])

  async function buildSemanticIndex(): Promise<void> {
    if (!isElectron()) return
    setSemStatus((s) => ({
      available: s?.available ?? false,
      count: s?.count ?? 0,
      building: true
    }))
    try {
      const res = await window.api.records.rebuildSemantic()
      if (res.success) toast(`Semantic index ready · ${res.total ?? 0} records`, 'success')
      else toast(res.error ?? 'Could not build the semantic index', 'error')
    } catch {
      toast('Could not build the semantic index', 'error')
    } finally {
      loadSemStatus()
      reload()
    }
  }

  // True totals + whole-table facets (the list is capped, so chips must come
  // from the full table) — independent of the active search/filter.
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
    loadStats()
    loadSemStatus()
  }, [loadStats, loadSemStatus])

  function report(r: RecordsImportResult): void {
    if (r.canceled) return
    if (!r.success) {
      toast(r.error ?? 'Import failed', 'error')
      return
    }
    const parts: string[] = []
    if (r.imported) parts.push(`${r.imported} imported`)
    // Snapshot facts (the Ad Profile / Profile / … themed pages) are a successful
    // import too, even when nothing landed on the timeline.
    if (r.snapshots) parts.push(`${r.snapshots} snapshot ${r.snapshots === 1 ? 'fact' : 'facts'}`)
    if (r.duplicates) parts.push(`${r.duplicates} already on your timeline`)
    if (r.unrecognized.length) parts.push(`${r.unrecognized.length} unrecognized`)
    const ok = r.imported > 0 || r.snapshots > 0
    toast(parts.join(' · ') || 'Nothing to import', ok ? 'success' : 'error')
    reload()
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

  function toggleIn(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
  }

  // "See all N from this day" (hero) → Browse narrowed to that one UTC day.
  function openDay(day: string): void {
    const start = Date.parse(`${day}T00:00:00.000Z`)
    if (Number.isNaN(start)) return
    setRange({ from: start, to: start + 24 * 60 * 60 * 1000 - 1, label: day })
    switchView('browse')
  }

  function findSimilar(title: string): void {
    setDetail(null)
    setQuery(title)
  }

  // Chips come from whole-timeline facets, unioned with active selections so a
  // chip stays clearable even if a concurrent import narrows the table.
  const sources = [...new Set([...facets.sources, ...sourcesSel])].sort()
  const types = [...new Set([...facets.types, ...typesSel])].sort()
  const span = stats ? fmtSpan(stats.earliest, stats.latest) : ''
  const filterLabel = [
    ...sourcesSel.map((s) => sourceMeta(s).label),
    ...typesSel.map((t) => typeLabel(t))
  ].join(' · ')
  const empty = stats !== null && stats.total === 0

  return (
    <div
      className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <Clock size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Timeline</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {searching ? (
              <>
                <span className="font-semibold text-foreground">{items.length}</span> record
                {items.length === 1 ? '' : 's'} matching your search
              </>
            ) : stats && stats.total > 0 ? (
              <>
                <span className="font-semibold text-foreground">
                  {stats.total.toLocaleString()}
                </span>{' '}
                record{stats.total === 1 ? '' : 's'} · {stats.sources} source
                {stats.sources === 1 ? '' : 's'}
                {span && ` · ${span}`}
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

      {/* Whole-page drop feedback (the entire Timeline is a drop target). */}
      {dragOver && (
        <div className="mb-4 rounded-xl border-2 border-dashed border-primary bg-primary/5 px-6 py-4 text-center text-sm text-primary">
          Drop to import — nothing leaves your machine
        </div>
      )}

      {/* First run: the drop zone IS the page. */}
      {empty ? (
        <button
          type="button"
          onClick={pickFiles}
          className="w-full rounded-xl border-2 border-dashed border-border hover:border-primary/50 bg-card/40 px-6 py-12 text-center transition-colors"
        >
          <Upload size={22} className="mx-auto mb-2 text-muted-foreground" />
          <span className="block text-sm text-foreground font-medium">Drop a data export here</span>
          <span className="block text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Netflix viewing history, a full Amazon archive, Spotify, LinkedIn — any dated CSV / JSON
            / ZIP becomes a private, searchable timeline you own forever.
          </span>
        </button>
      ) : (
        <>
          {/* Search */}
          <div className="mb-4">
            <div className="relative">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={semantic ? 'Search by meaning…' : 'Search your timeline…'}
                aria-label="Search your timeline"
                className="w-full rounded-lg border border-border bg-card pl-9 pr-28 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
              />
              <button
                type="button"
                onClick={() => setSemantic((v) => !v)}
                aria-pressed={semantic}
                title={
                  semantic
                    ? 'Searching by meaning (semantic)'
                    : 'Search by meaning instead of keywords'
                }
                className={cn(
                  'absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors',
                  semantic
                    ? 'bg-primary/20 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <Sparkles size={13} /> Meaning
              </button>
            </div>
            {semantic && semStatus && !semStatus.available && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {semStatus.building ? (
                  'Building the semantic index on your machine…'
                ) : (
                  <>
                    Search-by-meaning needs a local index (uses Ollama, stays on your machine).{' '}
                    <button
                      type="button"
                      onClick={buildSemanticIndex}
                      className="text-primary hover:underline"
                    >
                      Build it
                    </button>
                    . Until then, results fall back to keyword search.
                  </>
                )}
              </p>
            )}
            {semantic && semStatus?.available && searching && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Searching by meaning across {semStatus.count.toLocaleString()} indexed records.
              </p>
            )}
          </div>

          {/* Lens switch — hidden while a search narrows everything anyway. */}
          {!searching && (
            <div className="flex items-center gap-1 mb-4" aria-label="Timeline view">
              {(
                [
                  ['day', 'This day'],
                  ['browse', 'Browse']
                ] as Array<[View, string]>
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => switchView(v)}
                  className={cn(
                    'text-xs px-3 py-1.5 rounded-lg border transition-colors',
                    view === v
                      ? 'border-primary/50 bg-primary/15 text-primary font-medium'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
              {view === 'browse' && range && (
                <button
                  type="button"
                  onClick={() => setRange(null)}
                  className="ml-2 text-xs text-primary hover:underline"
                  title="Clear the selected period"
                >
                  {range.label} ✕
                </button>
              )}
            </div>
          )}

          {/* THIS DAY — the all-years memory lens. */}
          {!searching && view === 'day' && (
            <OnThisDayHero onOpenRecord={setDetail} onOpenDay={openDay} />
          )}

          {/* BROWSE + search results share the filters and the list. */}
          {(searching || view === 'browse') && (
            <>
              {!searching && (
                <YearScrubber
                  range={range}
                  onRangeChange={setRange}
                  includeFirehose={showFirehose}
                />
              )}

              {(sources.length > 1 || sourcesSel.length > 0) && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <Chip
                    active={sourcesSel.length === 0}
                    onClick={() => setSourcesSel([])}
                    title="Show every source"
                  >
                    All sources
                  </Chip>
                  {sources.map((s) => (
                    <Chip
                      key={s}
                      active={sourcesSel.includes(s)}
                      onClick={() => setSourcesSel((prev) => toggleIn(prev, s))}
                    >
                      {sourceMeta(s).icon}
                      {sourceMeta(s).label}
                    </Chip>
                  ))}
                </div>
              )}

              {(types.length > 1 || typesSel.length > 0) && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  <Chip
                    active={typesSel.length === 0}
                    onClick={() => setTypesSel([])}
                    title="Show every kind"
                  >
                    All kinds
                  </Chip>
                  {types.map((t) => (
                    <Chip
                      key={t}
                      active={typesSel.includes(t)}
                      onClick={() => setTypesSel((prev) => toggleIn(prev, t))}
                    >
                      {typeLabel(t)}
                    </Chip>
                  ))}
                </div>
              )}

              {/* Curate: firehose (browsing history, export telemetry) stays
                  collapsed until revealed — never deleted. */}
              {!searching &&
                sourcesSel.length === 0 &&
                typesSel.length === 0 &&
                stats &&
                stats.firehose > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowFirehose((v) => !v)}
                    aria-pressed={showFirehose}
                    className="flex items-center gap-1.5 mb-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Globe size={13} />
                    {showFirehose
                      ? 'Hide background activity'
                      : `Show background activity (${stats.firehose.toLocaleString()} hidden)`}
                  </button>
                )}

              {items.length === 0 ? (
                searching || sourcesSel.length > 0 || typesSel.length > 0 || range ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    No {filterLabel ? `${filterLabel} ` : ''}records
                    {searching ? ` match “${query.trim()}”` : range ? ` in ${range.label}` : ''}.
                  </p>
                ) : null /* still loading — don't flash an empty message */
              ) : (
                <>
                  <RecordList records={items} onOpenRecord={setDetail} />
                  {!searching && hasMore && (
                    <div className="mt-6 text-center">
                      <button
                        type="button"
                        onClick={loadEarlier}
                        disabled={loadingMore}
                        className="text-sm px-4 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                      >
                        {loadingMore ? 'Loading…' : 'Load earlier records'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {detail && (
        <RecordDetailDrawer
          record={detail}
          onClose={() => setDetail(null)}
          onFindSimilar={findSimilar}
        />
      )}
    </div>
  )
}
