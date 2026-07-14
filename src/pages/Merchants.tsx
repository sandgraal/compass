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
import { Compass, Store } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import DerivedEntityList from '../components/DerivedEntityList'
import MerchantDetail from '../components/MerchantDetail'
import { useToast } from '../components/ui/Toast'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'

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
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
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

  // Spend-by-category rollup chips across the tracked set.
  const categories = useMemo(() => {
    const byCat = new Map<string, { category: string; currency: string; spend: number }>()
    for (const m of tracked) {
      const cat = m.category?.trim()
      if (!cat || !m.live) continue
      const key = `${cat}\u0000${m.live.currency}`
      const row = byCat.get(key) ?? { category: cat, currency: m.live.currency, spend: 0 }
      row.spend += m.live.totalSpend
      byCat.set(key, row)
    }
    return [...byCat.entries()]
      .map(([key, row]) => ({ key, ...row }))
      .sort((a, b) => b.spend - a.spend)
  }, [tracked])

  const shownTracked = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tracked.filter(
      (m) =>
        (!q || m.name.toLowerCase().includes(q) || m.matchKey.includes(q)) &&
        (!categoryFilter || m.category === categoryFilter)
    )
  }, [tracked, search, categoryFilter])

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
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a tracked merchant…"
                aria-label="Search tracked merchants"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
              {categories.length > 1 && (
                <div className="flex gap-1.5 flex-wrap">
                  {categories.map(({ key, category, currency, spend }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setCategoryFilter((prev) => (prev === category ? null : category))
                      }
                      title={`${formatMoney(spend, currency)} across ${category}`}
                      className={cn(
                        'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                        categoryFilter === category
                          ? 'border-primary/60 bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {category} · {formatMoney(spend, currency, { decimals: 0, compact: true })}
                    </button>
                  ))}
                </div>
              )}
              <ul className="space-y-1">
                {shownTracked.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(m.id)}
                      className={cn(
                        'w-full text-left rounded-lg px-3 py-2 transition-colors border',
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
                {shownTracked.length === 0 && trackedLoaded && (
                  <li className="text-xs text-muted-foreground px-3 py-4">
                    {search || categoryFilter ? 'No matches.' : 'Nothing tracked yet.'}
                  </li>
                )}
              </ul>
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
    </div>
  )
}
