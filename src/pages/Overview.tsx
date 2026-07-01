import {
  ArrowRight,
  CalendarClock,
  Clock,
  CreditCard,
  Home,
  MapPin,
  Network,
  Search,
  Sparkles,
  Store,
  UserPlus,
  Users
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export default function Overview(): JSX.Element {
  const [summary, setSummary] = useState<OverviewSummary | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TimelineSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!isElectron()) return
    void window.api.overview
      .summary()
      .then(setSummary)
      .catch(() => setSummary(null))
  }, [])

  // Debounced "search everything" over the timeline (reuses records:search).
  useEffect(() => {
    const q = query.trim()
    if (!isElectron() || q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const h = setTimeout(() => {
      window.api.records
        .search({ q, limit: 8 })
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(h)
  }, [query])

  const s = summary
  const sug = s?.suggestions

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground mb-1">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Everything you've brought into Compass, in one place.
        </p>
      </div>

      {/* Search everything */}
      <div className="relative mb-2">
        <Search
          size={17}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim())
              navigate(`/timeline?q=${encodeURIComponent(query.trim())}`)
          }}
          placeholder="Search everything in your timeline…"
          aria-label="Search everything"
          className="w-full rounded-xl border border-border bg-card pl-11 pr-3 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
        />
      </div>
      {query.trim().length >= 2 && (
        <div className="mb-6 rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {searching && results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No matches for "{query.trim()}".
            </p>
          ) : (
            <>
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => navigate(`/timeline?q=${encodeURIComponent(query.trim())}`)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-sidebar-accent/40 transition-colors"
                >
                  <span className="text-[11px] text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0 capitalize">
                    {r.source}
                  </span>
                  <span className="flex-1 min-w-0 text-sm text-foreground truncate">{r.title}</span>
                  {r.occurredAt != null && (
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {new Date(r.occurredAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        timeZone: 'UTC'
                      })}
                    </span>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={() => navigate(`/timeline?q=${encodeURIComponent(query.trim())}`)}
                className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-xs text-primary hover:bg-primary/5 transition-colors"
              >
                See all in Timeline <ArrowRight size={12} />
              </button>
            </>
          )}
        </div>
      )}

      {/* At-a-glance tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Tile
          label="Timeline"
          value={s ? s.timeline.records.toLocaleString() : '—'}
          hint={s ? `${s.timeline.sources} sources` : ''}
          icon={<Clock size={16} />}
          onClick={() => navigate('/timeline')}
        />
        <Tile
          label="People"
          value={s ? String(s.suggestions.peopleUnpromoted + s.storehouse.contacts.count) : '—'}
          hint={sug && sug.peopleUnpromoted > 0 ? `${sug.peopleUnpromoted} to add` : 'in contacts'}
          icon={<Network size={16} />}
          onClick={() => navigate('/people')}
        />
        <Tile
          label="Merchants"
          value={s ? String(s.suggestions.merchants) : '—'}
          hint="from spending"
          icon={<Store size={16} />}
          onClick={() => navigate('/places')}
        />
        <Tile
          label="Places"
          value={s ? String(s.suggestions.places) : '—'}
          hint="you've been"
          icon={<MapPin size={16} />}
          onClick={() => navigate('/places')}
        />
        <Tile
          label="Contacts"
          value={s ? s.storehouse.contacts.count.toLocaleString() : '—'}
          hint="saved"
          icon={<Users size={16} />}
          onClick={() => navigate('/contacts')}
        />
        <Tile
          label="Subscriptions"
          value={s ? String(s.storehouse.subscriptions.activeCount) : '—'}
          hint={s ? `${money(s.storehouse.subscriptions.annualTotal)}/yr` : ''}
          icon={<CreditCard size={16} />}
          onClick={() => navigate('/subscriptions')}
        />
        <Tile
          label="Assets"
          value={s ? String(s.storehouse.assets.count) : '—'}
          hint={s ? money(s.storehouse.assets.totalValue) : ''}
          icon={<Home size={16} />}
          onClick={() => navigate('/assets')}
        />
      </div>

      {/* Suggestions from the timeline */}
      {sug && (sug.peopleUnpromoted > 0 || sug.subscriptionsUntracked > 0) && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Sparkles size={12} /> Suggestions
          </h2>
          <div className="space-y-2">
            {sug.peopleUnpromoted > 0 && (
              <Suggestion
                icon={<UserPlus size={16} className="text-primary" />}
                title={`${sug.peopleUnpromoted} ${sug.peopleUnpromoted === 1 ? 'person' : 'people'} to add to your contacts`}
                detail={sug.topPeople
                  .map((p) => p.name)
                  .slice(0, 3)
                  .join(', ')}
                cta="Review in People"
                onClick={() => navigate('/people')}
              />
            )}
            {sug.subscriptionsUntracked > 0 && (
              <Suggestion
                icon={<CreditCard size={16} className="text-primary" />}
                title={`${sug.subscriptionsUntracked} recurring ${sug.subscriptionsUntracked === 1 ? 'service' : 'services'} to track`}
                detail={sug.topSubscriptions
                  .map((c) => c.name)
                  .slice(0, 3)
                  .join(', ')}
                cta="Review in Subscriptions"
                onClick={() => navigate('/subscriptions')}
              />
            )}
          </div>
        </div>
      )}

      {/* Upcoming renewals */}
      {s && s.storehouse.upcomingRenewals.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <CalendarClock size={12} /> Upcoming renewals
          </h2>
          <div className="space-y-1.5">
            {s.storehouse.upcomingRenewals.slice(0, 6).map((r) => (
              <div
                key={`${r.source}-${r.name}-${r.date}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
              >
                <span className="flex-1 min-w-0 text-sm text-foreground truncate">{r.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`} · {r.date}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  icon,
  onClick
}: {
  label: string
  value: string
  hint: string
  icon: JSX.Element
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-xl border border-border bg-card px-4 py-3 hover:border-primary/40 hover:bg-card/80 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </button>
  )
}

function Suggestion({
  icon,
  title,
  detail,
  cta,
  onClick
}: {
  icon: JSX.Element
  title: string
  detail: string
  cta: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:border-primary/40 hover:bg-card/80 transition-colors"
    >
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail && <p className="text-xs text-muted-foreground truncate mt-0.5">{detail}</p>}
      </div>
      <span className="shrink-0 flex items-center gap-1 text-xs text-primary">
        {cta} <ArrowRight size={13} />
      </span>
    </button>
  )
}
