/**
 * Shared list body for the Merchants and Places pages: loads ONE derived-entity
 * kind, with search, one-click Save (promote to the owned `places` table),
 * timeline deep-links, and multi-select "Not interested" (permanent exclusion
 * via entities:exclude — the same curation mechanism as the People page).
 */
import { EyeOff, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import BulkActionBar from './ui/BulkActionBar'
import { useToast } from './ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const PLURAL: Record<'merchant' | 'place' | 'person', string> = {
  merchant: 'merchants',
  place: 'places',
  person: 'people'
}

/** "Mar 2022" for a touchpoint timestamp (UTC, matching the Timeline span rendering). */
function fmtMonth(ms: number | null): string {
  if (ms == null) return ''
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

export default function DerivedEntityList({
  kind,
  searchPlaceholder,
  emptyState,
  onCount,
  promoteLabel = 'Save',
  promotedLabel = 'Saved',
  onPromoted
}: {
  kind: 'merchant' | 'place' | 'person'
  searchPlaceholder: string
  emptyState: React.ReactNode
  onCount?: (n: number) => void
  /** Verb on the promote button — the Merchants page says "Track". */
  promoteLabel?: string
  promotedLabel?: string
  /** Fired after a successful promote with the owned `places` row id. */
  onPromoted?: (promotedId: number, entity: DerivedEntity) => void
}): JSX.Element {
  const [items, setItems] = useState<DerivedEntity[]>([])
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [excluding, setExcluding] = useState(false)
  const navigate = useNavigate()
  const { toast } = useToast()

  useEffect(() => {
    if (!isElectron()) {
      setLoaded(true)
      onCount?.(0)
      return
    }
    window.api.entities
      .list({ kind, limit: 500 })
      .then((rows) => {
        setItems(rows)
        onCount?.(rows.length)
      })
      .catch(() => toast(`Could not load your ${PLURAL[kind]}`, 'error'))
      .finally(() => setLoaded(true))
  }, [kind, onCount, toast])

  async function save(e: DerivedEntity): Promise<void> {
    if (!isElectron() || promoting) return
    setPromoting(e.key)
    try {
      const res = await window.api.entities.promote({ kind: e.kind, key: e.key })
      if (res.success) {
        // The backend now excludes promoted rows from entities:list, so a
        // reload would drop this row anyway — remove it immediately instead
        // of waiting on one, mirroring excludeSelected() below.
        setItems((prev) => {
          const next = prev.filter((x) => x.key !== e.key)
          onCount?.(next.length)
          return next
        })
        toast(`${promotedLabel} ${e.name}`, 'success')
        if (res.promotedId != null) onPromoted?.(res.promotedId, e)
      } else {
        toast(res.error ?? 'Could not save', 'error')
      }
    } catch {
      toast('Could not save', 'error')
    } finally {
      setPromoting(null)
    }
  }

  /** Permanently hide the selection — survives every cache rebuild. */
  async function excludeSelected(): Promise<void> {
    if (!isElectron() || selected.size === 0) return
    setExcluding(true)
    try {
      const payload = [...selected].map((key) => ({ kind, key }))
      const r = await window.api.entities.exclude(payload)
      if (r.success) {
        setItems((prev) => {
          const next = prev.filter((e) => !selected.has(e.key))
          onCount?.(next.length)
          return next
        })
        toast(
          `Hidden ${r.excluded} ${r.excluded === 1 ? 'entry' : 'entries'} — they won't come back. (Undo in Settings.)`,
          'success'
        )
        setSelected(new Set())
      } else {
        toast('Could not hide the selection', 'error')
      }
    } catch {
      toast('Could not hide the selection', 'error')
    } finally {
      setExcluding(false)
    }
  }

  function toggleSelect(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Match on both the displayed name AND the normalized key, so typing what the
  // user sees (with original casing/punctuation) finds the row.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((e) => e.key.includes(q) || e.name.toLowerCase().includes(q)) : items
  }, [items, query])

  if (loaded && items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
        {emptyState}
      </div>
    )
  }

  return (
    <>
      {items.length > 0 && (
        <div className="relative mb-4">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      )}

      <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <button
          type="button"
          onClick={excludeSelected}
          disabled={excluding}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors disabled:opacity-50"
        >
          <EyeOff size={12} />
          {excluding ? 'Hiding…' : `Not interested (${selected.size})`}
        </button>
      </BulkActionBar>

      <ul className="flex flex-col gap-1.5">
        {shown.map((e) => (
          <li
            key={e.key}
            className="flex items-center gap-2 rounded-lg border border-border bg-card pr-2 hover:border-primary/40 hover:bg-card/80 transition-colors"
          >
            <label className="pl-3 py-2.5 shrink-0 flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(e.key)}
                onChange={() => toggleSelect(e.key)}
                aria-label={`Select ${e.name}`}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))] cursor-pointer"
              />
            </label>
            <button
              type="button"
              onClick={() => navigate(`/timeline?q=${encodeURIComponent(e.name)}`)}
              title={`See everything involving ${e.name} on the timeline`}
              className="flex-1 min-w-0 flex items-center gap-3 pr-4 py-2.5 text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-foreground capitalize truncate block">
                  {e.name}
                </span>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {e.sources.join(', ')}
                  {e.lastSeen != null && ` · ${fmtMonth(e.lastSeen)}`}
                </div>
              </div>
              <div className="text-right shrink-0">
                {e.attrs.totalSpend != null && (
                  <div className="text-sm font-semibold text-foreground">
                    {money(e.attrs.totalSpend)}
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  {e.count} {e.count === 1 ? 'touchpoint' : 'touchpoints'}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => save(e)}
              disabled={promoting === e.key}
              title={`${promoteLabel} ${e.name}`}
              aria-label={`${promoteLabel} ${e.name}`}
              className="shrink-0 flex items-center gap-1 text-[11px] text-primary border border-primary/30 rounded px-2 py-1 hover:bg-primary/10 disabled:opacity-50 transition-colors"
            >
              <Plus size={12} /> {promoteLabel}
            </button>
          </li>
        ))}
        {shown.length === 0 && query && (
          <li className="text-sm text-muted-foreground px-4 py-3">Nothing matches "{query}".</li>
        )}
      </ul>
    </>
  )
}
