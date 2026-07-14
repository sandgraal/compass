/**
 * Places (places redesign) — three views over where your life happens:
 *
 *   Tracked    — places you promoted into the owned `places` table, each with
 *                live visit stats (calendar events, rides, trips matched from
 *                the timeline) and a full profile (PlaceDetail) in a
 *                Contacts-style master–detail
 *   Discovered — every place the cross-reference engine derives from your
 *                timeline (calendar locations, rideshare dropoffs, trips)
 *   Travel     — the offline map of everywhere you've been (GPS imports,
 *                rendered fully locally) plus your trips with per-trip spend
 *
 * Tracking a place moves it to Tracked and opens its profile immediately.
 */
import { Compass, MapPin, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DerivedEntityList from '../components/DerivedEntityList'
import LocationMap from '../components/LocationMap'
import PlaceDetail from '../components/PlaceDetail'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'
import { FINANCE_TAB_STORAGE_KEY, type Tab as FinanceTab } from './Finance'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

type Tab = 'tracked' | 'discovered' | 'travel'

type TripBundle = Awaited<ReturnType<Window['api']['finance']['getTripBundles']>>[number]

const fmtShortTs = (ts: number | null): string =>
  ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''

/** ISO-3166 alpha-2 → emoji flag (pure codepoint math, offline). */
const countryFlag = (iso2: string): string =>
  /^[A-Za-z]{2}$/.test(iso2)
    ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : ''

/** Format a trip amount in its currency: USD gets a '$' prefix, else an ISO-code suffix. */
const fmtTripMoney = (amount: number, currency: string | null): string => {
  const n = Math.round(amount).toLocaleString('en-US')
  return currency && currency !== 'USD' ? `${n} ${currency}` : `$${n}`
}

const fmtTripDates = (start: string, end: string): string => {
  const s = new Date(`${start}T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  const sameYear = s.getFullYear() === e.getFullYear()
  const sFmt = s.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  const eFmt = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${sFmt} – ${eFmt}`
}

export default function Places(): JSX.Element {
  const [tab, setTab] = useState<Tab | null>(null) // null until data loads (pick default)
  const [tracked, setTracked] = useState<TrackedPlace[]>([])
  const [trackedLoaded, setTrackedLoaded] = useState(false)
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [mapData, setMapData] = useState<LocationMapData | null>(null)
  const [trips, setTrips] = useState<TripBundle[]>([])
  const navigate = useNavigate()
  const { toast } = useToast()

  const loadTracked = useCallback(async (): Promise<TrackedPlace[]> => {
    if (!isElectron()) {
      setTrackedLoaded(true)
      return []
    }
    try {
      const rows = await window.api.places.listTracked()
      setTracked(rows)
      return rows
    } catch {
      toast('Could not load tracked places', 'error')
      return []
    } finally {
      setTrackedLoaded(true)
    }
  }, [toast])

  useEffect(() => {
    async function init(): Promise<void> {
      const [rows, map, tb] = await Promise.all([
        loadTracked(),
        isElectron() && window.api.location
          ? window.api.location.mapData().catch(() => null)
          : Promise.resolve(null),
        isElectron() && window.api.finance?.getTripBundles
          ? window.api.finance.getTripBundles().catch(() => [] as TripBundle[])
          : Promise.resolve([] as TripBundle[])
      ])
      setMapData(map)
      setTrips(tb)
      // Land on Tracked when it has content; else the map/trips when they
      // exist; else the discovery list.
      const hasTravel = (map?.cells.length ?? 0) > 0 || tb.length > 0
      setTab((prev) => prev ?? (rows.length > 0 ? 'tracked' : hasTravel ? 'travel' : 'discovered'))
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null)
    }
    void init()
  }, [loadTracked])

  const shownTracked = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tracked.filter((p) => !q || p.name.toLowerCase().includes(q) || p.matchKey.includes(q))
  }, [tracked, search])

  const sortedTrips = useMemo(
    () => [...trips].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [trips]
  )

  const countriesVisited = useMemo(() => new Set(trips.map((t) => t.country)).size, [trips])

  const mostVisited = useMemo(() => {
    let best: TrackedPlace | null = null
    for (const p of tracked) {
      if (p.live && (!best?.live || p.live.visitCount > best.live.visitCount)) best = p
    }
    return best
  }, [tracked])

  const selected = tracked.find((p) => p.id === selectedId) ?? null

  function handlePromoted(promotedId: number): void {
    void loadTracked().then(() => {
      setTab('tracked')
      setSelectedId(promotedId)
      setAdding(false)
    })
  }

  function handleUntracked(): void {
    setSelectedId(null)
    void loadTracked().then((rows) => {
      setSelectedId(rows[0]?.id ?? null)
      if (rows.length === 0) setTab('discovered')
    })
  }

  function openResidency(): void {
    const target: FinanceTab = 'residency'
    sessionStorage.setItem(FINANCE_TAB_STORAGE_KEY, target)
    navigate('/finance')
  }

  const yearRange = useMemo(() => {
    if (mapData?.firstSeen == null || mapData.lastSeen == null) return null
    const a = new Date(mapData.firstSeen).getUTCFullYear()
    const b = new Date(mapData.lastSeen).getUTCFullYear()
    return a === b ? String(a) : `${a}–${b}`
  }, [mapData])

  const trackedCount = trackedLoaded ? tracked.length : null
  const showStats =
    trackedLoaded && (tracked.length > 0 || countriesVisited > 0 || (mapData?.totalPoints ?? 0) > 0)

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      <div className="mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <MapPin size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Places</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          The places in your life — track the ones that matter to see your visits, trips, and
          everything that happened there. All rendered locally, nothing leaves your machine.
        </p>
      </div>

      {/* Stat strip */}
      {showStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatTile label="Tracked places" value={String(tracked.length)} />
          {countriesVisited > 0 && (
            <StatTile
              label="Countries visited"
              value={String(countriesVisited)}
              sub={`${trips.length} trip${trips.length === 1 ? '' : 's'}`}
            />
          )}
          {(mapData?.totalPoints ?? 0) > 0 && mapData && (
            <StatTile
              label="Location points"
              value={mapData.totalPoints.toLocaleString()}
              sub={yearRange ?? undefined}
            />
          )}
          {mostVisited?.live && (
            <StatTile
              label="Most visited"
              value={mostVisited.name}
              sub={`${mostVisited.live.visitCount} visit${mostVisited.live.visitCount === 1 ? '' : 's'}`}
              valueClass="capitalize text-sm leading-6 truncate"
            />
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-5">
        {(
          [
            { key: 'tracked' as Tab, label: 'Tracked', count: trackedCount },
            { key: 'discovered' as Tab, label: 'Discovered', count: discoveredCount },
            { key: 'travel' as Tab, label: 'Travel', count: trips.length > 0 ? trips.length : null }
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
          kind="place"
          searchPlaceholder="Find a place…"
          onCount={setDiscoveredCount}
          promoteLabel="Track"
          promotedLabel="Tracked"
          onPromoted={handlePromoted}
          emptyState={
            <>
              No named places yet. Import your <span className="text-foreground">calendar</span>,{' '}
              <span className="text-foreground">Uber/Lyft</span> rides, or a{' '}
              <span className="text-foreground">location history</span> export on the Timeline.
            </>
          }
        />
      )}

      {tab === 'tracked' &&
        (trackedLoaded && tracked.length === 0 && !adding ? (
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
            and hit <span className="text-foreground">Track</span> on the places you care about, or{' '}
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-primary hover:underline"
            >
              add one manually
            </button>
            .
          </div>
        ) : (
          <div className="flex gap-6 items-start">
            {/* Tracked list */}
            <div className="w-64 shrink-0 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Find a tracked place…"
                  aria-label="Search tracked places"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  title="Add a place manually"
                  aria-label="Add a place manually"
                  className="shrink-0 p-2 rounded-lg border border-border text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
              <ul className="space-y-1">
                {shownTracked.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(p.id)
                        setAdding(false)
                      }}
                      className={cn(
                        'w-full text-left rounded-lg px-3 py-2 transition-colors border',
                        p.id === selectedId && !adding
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-transparent hover:bg-secondary/60'
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className="text-sm font-medium text-foreground capitalize truncate"
                          title={p.name}
                        >
                          {p.name}
                        </span>
                        {p.live && (
                          <span className="text-xs text-foreground shrink-0 tabular-nums">
                            {p.live.visitCount}×
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {p.category ? `${p.category} · ` : ''}
                        {p.live
                          ? `${p.live.visitCount} visit${p.live.visitCount === 1 ? '' : 's'} · ${fmtShortTs(p.live.lastVisit)}`
                          : 'no visits found'}
                      </div>
                    </button>
                  </li>
                ))}
                {shownTracked.length === 0 && trackedLoaded && (
                  <li className="text-xs text-muted-foreground px-3 py-4">
                    {search ? 'No matches.' : 'Nothing tracked yet.'}
                  </li>
                )}
              </ul>
            </div>

            {/* Profile / create form */}
            <div className="flex-1 min-w-0">
              {adding ? (
                <CreatePlaceForm
                  onCreated={(id) => {
                    setAdding(false)
                    void loadTracked().then(() => setSelectedId(id))
                  }}
                  onCancel={() => setAdding(false)}
                />
              ) : selected ? (
                <PlaceDetail
                  placeId={selected.id}
                  onChanged={() => void loadTracked()}
                  onUntracked={handleUntracked}
                />
              ) : (
                <p className="text-sm text-muted-foreground pt-8 text-center">
                  Select a place to see everything that happened there.
                </p>
              )}
            </div>
          </div>
        ))}

      {tab === 'travel' && (
        <div className="space-y-6">
          {mapData && mapData.cells.length > 0 ? (
            <div>
              <LocationMap data={mapData} />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {mapData.totalPoints.toLocaleString()}
                </span>{' '}
                location points{yearRange && ` · ${yearRange}`} — rendered fully offline.
                {mapData.truncated &&
                  ` Showing your ${mapData.cells.length.toLocaleString()} most-visited spots.`}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 flex items-center gap-3 text-sm text-muted-foreground">
              <MapPin size={18} className="text-primary shrink-0" />
              Import a location export (Google Location History / Takeout, GPX, OwnTracks, or an
              Amazon export) on the Timeline and your map of everywhere you've been appears here —
              fully offline.
            </div>
          )}

          {sortedTrips.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Trips
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {sortedTrips.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="text-lg shrink-0" aria-hidden="true">
                      {countryFlag(t.country) || '🌍'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        {t.countryName}
                        <span className="text-muted-foreground ml-2 text-xs">
                          {fmtTripDates(t.startDate, t.endDate)}
                        </span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {t.days} day{t.days === 1 ? '' : 's'}
                        {t.recordCount > 0 &&
                          ` · ${t.recordCount} record${t.recordCount === 1 ? '' : 's'}`}
                      </p>
                    </div>
                    {t.spend > 0 && (
                      <span className="text-sm text-foreground shrink-0 tabular-nums">
                        {fmtTripMoney(t.spend, t.currency)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={openResidency}
            className="text-xs text-primary hover:underline"
          >
            Manage travel & residency in Finance →
          </button>
        </div>
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  valueClass
}: {
  label: string
  value: string
  sub?: string
  valueClass?: string
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold text-foreground mt-0.5 tabular-nums truncate',
          valueClass
        )}
        title={value}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function CreatePlaceForm({
  onCreated,
  onCancel
}: {
  onCreated: (id: number) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState({ name: '', category: '', address: '', url: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  async function save(): Promise<void> {
    if (!draft.name.trim()) {
      toast('Name is required', 'error')
      return
    }
    if (draft.url.trim() && !/^https?:\/\//i.test(draft.url.trim())) {
      toast('Website must start with http:// or https://', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.places.createManual({
        name: draft.name,
        category: draft.category.trim() || null,
        address: draft.address.trim() || null,
        url: draft.url.trim() || null,
        notes: draft.notes.trim() || null
      })
      toast(`Added ${draft.name.trim()}`, 'success')
      onCreated(res.id)
    } catch {
      toast('Could not add the place', 'error')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <p className="text-sm font-medium text-foreground">Add a place</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Grandma's house, the gym, the office…"
            className={field}
            // biome-ignore lint/a11y/noAutofocus: the form only appears on explicit "Add place"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Category</span>
          <input
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            placeholder="Gym, Café, School…"
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Website</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://…"
            className={field}
          />
        </label>
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Address</span>
          <input
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            className={field}
          />
        </label>
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={3}
            className={field}
          />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-sm px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Adding…' : 'Add place'}
        </button>
      </div>
    </div>
  )
}
