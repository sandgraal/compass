/**
 * Merchants (merchants redesign) — two areas over the same businesses:
 *
 *   Tracked    — merchants you promoted into the owned `places` table, each
 *                with live ledger stats and a full profile (MerchantDetail)
 *                in a Contacts-style master–detail
 *   Discovered — everything the cross-reference engine derives from your
 *                timeline (the old page), with Save rebranded to Track
 *
 * Tracking a merchant moves it to Tracked and opens its profile immediately.
 */
import { Compass, GitMerge, Store } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import DerivedEntityList from '../components/DerivedEntityList'
import MerchantDetail from '../components/MerchantDetail'
import MergePlacesDialog, { type MergePlaceCandidate } from '../components/places/MergePlacesDialog'
import PossibleDuplicatesPanel from '../components/places/PossibleDuplicatesPanel'
import BulkActionBar from '../components/ui/BulkActionBar'
import { useToast } from '../components/ui/Toast'
import { type SortKey, groupAndSort } from '../lib/entity-grouping'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'primaryMetric', label: 'Total spend' },
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Most recent' },
  { value: 'count', label: 'Most transactions' }
]

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const fmtShortDate = (iso: string | null): string =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : ''

type Tab = 'tracked' | 'discovered'

export default function Merchants(): JSX.Element {
  const [tab, setTab] = useState<Tab | null>(null) // null until tracked loads (pick default)
  const [tracked, setTracked] = useState<TrackedMerchant[]>([])
  const [trackedLoaded, setTrackedLoaded] = useState(false)
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('primaryMetric')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [mergeCandidates, setMergeCandidates] = useState<MergePlaceCandidate[] | null>(null)
  const { toast } = useToast()

  const loadTracked = useCallback(async (): Promise<TrackedMerchant[]> => {
    if (!isElectron()) {
      setTrackedLoaded(true)
      return []
    }
    try {
      const rows = await window.api.merchants.listTracked()
      setTracked(rows)
      return rows
    } catch {
      toast('Could not load tracked merchants', 'error')
      return []
    } finally {
      setTrackedLoaded(true)
    }
  }, [toast])

  useEffect(() => {
    void loadTracked().then((rows) => {
      // Land on Tracked when it has content, otherwise show the discovery list.
      setTab((prev) => prev ?? (rows.length > 0 ? 'tracked' : 'discovered'))
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null)
    })
  }, [loadTracked])

  const shownTracked = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tracked.filter((m) => !q || m.name.toLowerCase().includes(q) || m.matchKey.includes(q))
  }, [tracked, search])

  const groups = useMemo(() => {
    const withMetrics = shownTracked.map((m) => ({
      ...m,
      sortMetrics: {
        primaryMetric: m.live?.totalSpend ?? 0,
        lastActivity: m.live?.lastTxnDate
          ? new Date(`${m.live.lastTxnDate}T00:00:00`).getTime()
          : null,
        count: m.live?.txnCount ?? 0
      }
    }))
    return groupAndSort(withMetrics, sortBy)
  }, [shownTracked, sortBy])

  const selected = tracked.find((m) => m.id === selectedId) ?? null

  function handlePromoted(promotedId: number): void {
    void loadTracked().then(() => {
      setTab('tracked')
      setSelectedId(promotedId)
    })
  }

  function handleUntracked(): void {
    setSelectedId(null)
    void loadTracked().then((rows) => {
      setSelectedId(rows[0]?.id ?? null)
      if (rows.length === 0) setTab('discovered')
    })
  }

  function toggleChecked(id: number): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const merchantSecondary = (m: TrackedMerchant): string =>
    m.live
      ? `${formatMoney(m.live.totalSpend, m.live.currency, { decimals: 0, compact: true })} · ${m.live.txnCount} txn${m.live.txnCount === 1 ? '' : 's'}`
      : 'no ledger activity'

  function openMergeFor(ids: number[]): void {
    const candidates = ids
      .map((id) => tracked.find((m) => m.id === id))
      .filter((m): m is TrackedMerchant => !!m)
      .map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        secondary: merchantSecondary(m)
      }))
    if (candidates.length < 2) return
    setMergeCandidates(candidates)
  }

  async function handleMerged(survivorId: number): Promise<void> {
    setMergeCandidates(null)
    setChecked(new Set())
    await loadTracked()
    setTab('tracked')
    setSelectedId(survivorId)
  }

  const trackedCount = trackedLoaded ? tracked.length : null

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      <div className="mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <Store size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Merchants</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          The businesses in your life — track the ones you care about to get the full picture:
          spend, receipts, subscriptions, documents.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-5">
        {(
          [
            { key: 'tracked' as Tab, label: 'Tracked', count: trackedCount },
            { key: 'discovered' as Tab, label: 'Discovered', count: discoveredCount }
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3.5 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {t.count != null && (
              <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'discovered' && (
        <DerivedEntityList
          kind="merchant"
          searchPlaceholder="Find a merchant…"
          onCount={setDiscoveredCount}
          promoteLabel="Track"
          promotedLabel="Tracked"
          onPromoted={handlePromoted}
          emptyState={
            <>
              No merchants yet. Import a <span className="text-foreground">PayPal</span>,{' '}
              <span className="text-foreground">Amazon</span>, or{' '}
              <span className="text-foreground">Google Pay</span> export on the Timeline, or connect
              a bank via SimpleFIN.
            </>
          }
        />
      )}

      {tab === 'tracked' &&
        (trackedLoaded && tracked.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
            <Compass size={20} className="mx-auto mb-2 text-muted-foreground" />
            Nothing tracked yet. Head to{' '}
            <button
              type="button"
              onClick={() => setTab('discovered')}
              className="text-primary hover:underline"
            >
              Discovered
            </button>{' '}
            and hit <span className="text-foreground">Track</span> on the merchants you care about.
          </div>
        ) : (
          <div className="flex gap-6 items-start">
            {/* Tracked list */}
            <div className="w-64 shrink-0 space-y-2">
              <PossibleDuplicatesPanel
                kind="merchant"
                onReview={(a, b) => openMergeFor([a.id, b.id])}
              />
              <BulkActionBar count={checked.size} onClear={() => setChecked(new Set())}>
                <button
                  type="button"
                  onClick={() => openMergeFor([...checked])}
                  disabled={checked.size < 2}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                >
                  <GitMerge size={12} /> Merge…
                </button>
              </BulkActionBar>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a tracked merchant…"
                aria-label="Search tracked merchants"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                aria-label="Sort tracked merchants"
                className="w-full bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    Sort: {opt.label}
                  </option>
                ))}
              </select>
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.category}>
                    {groups.length > 1 && (
                      <p className="px-1 mb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                        {group.category}
                      </p>
                    )}
                    <ul className="space-y-1">
                      {group.items.map((m) => (
                        <li key={m.id} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={checked.has(m.id)}
                            onChange={() => toggleChecked(m.id)}
                            aria-label={`Select ${m.name}`}
                            className="h-3.5 w-3.5 shrink-0 accent-[hsl(var(--primary))] cursor-pointer"
                          />
                          <button
                            type="button"
                            onClick={() => setSelectedId(m.id)}
                            className={cn(
                              'flex-1 min-w-0 text-left rounded-lg px-3 py-2 transition-colors border',
                              m.id === selectedId
                                ? 'border-primary/50 bg-primary/10'
                                : 'border-transparent hover:bg-secondary/60'
                            )}
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-medium text-foreground capitalize truncate">
                                {m.name}
                              </span>
                              {m.live && (
                                <span className="text-xs text-foreground shrink-0 tabular-nums">
                                  {formatMoney(m.live.totalSpend, m.live.currency, {
                                    decimals: 0,
                                    compact: true
                                  })}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {m.category ? `${m.category} · ` : ''}
                              {m.live
                                ? `${m.live.txnCount} txns · ${fmtShortDate(m.live.lastTxnDate)}`
                                : 'no ledger activity'}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {shownTracked.length === 0 && trackedLoaded && (
                  <p className="text-xs text-muted-foreground px-3 py-4">
                    {search ? 'No matches.' : 'Nothing tracked yet.'}
                  </p>
                )}
              </div>
            </div>

            {/* Profile */}
            <div className="flex-1 min-w-0">
              {selected ? (
                <MerchantDetail
                  merchantId={selected.id}
                  onChanged={() => void loadTracked()}
                  onUntracked={handleUntracked}
                />
              ) : (
                <p className="text-sm text-muted-foreground pt-8 text-center">
                  Select a merchant to see everything you know about it.
                </p>
              )}
            </div>
          </div>
        ))}

      {mergeCandidates && (
        <MergePlacesDialog
          kind="merchant"
          candidates={mergeCandidates}
          open={mergeCandidates !== null}
          onClose={() => setMergeCandidates(null)}
          onMerged={handleMerged}
        />
      )}
    </div>
  )
}
