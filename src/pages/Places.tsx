import { Check, MapPin, Plus, Search, Store } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** "Mar 2022" for a touchpoint timestamp (UTC, matching the Timeline span rendering). */
function fmtMonth(ms: number | null): string {
  if (ms == null) return ''
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

export default function Places(): JSX.Element {
  const [merchants, setMerchants] = useState<DerivedEntity[]>([])
  const [places, setPlaces] = useState<DerivedEntity[]>([])
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [promoting, setPromoting] = useState<string | null>(null)
  const navigate = useNavigate()
  const { toast } = useToast()

  useEffect(() => {
    if (!isElectron()) {
      setLoaded(true)
      return
    }
    Promise.all([
      window.api.entities.list({ kind: 'merchant', limit: 500 }),
      window.api.entities.list({ kind: 'place', limit: 500 })
    ])
      .then(([m, p]) => {
        setMerchants(m)
        setPlaces(p)
      })
      .catch(() => toast('Could not load your merchants & places', 'error'))
      .finally(() => setLoaded(true))
  }, [toast])

  async function save(e: DerivedEntity): Promise<void> {
    if (!isElectron() || promoting) return
    setPromoting(e.key)
    try {
      const res = await window.api.entities.promote({ kind: e.kind, key: e.key })
      if (res.success) {
        const patch = (list: DerivedEntity[]): DerivedEntity[] =>
          list.map((x) => (x.key === e.key ? { ...x, promotedKind: 'place' } : x))
        if (e.kind === 'merchant') setMerchants(patch)
        else setPlaces(patch)
        toast(`Saved ${e.name}`, 'success')
      } else {
        toast(res.error ?? 'Could not save', 'error')
      }
    } catch {
      toast('Could not save', 'error')
    } finally {
      setPromoting(null)
    }
  }

  const shownMerchants = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? merchants.filter((e) => e.key.includes(q)) : merchants
  }, [merchants, query])
  const shownPlaces = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? places.filter((e) => e.key.includes(q)) : places
  }, [places, query])
  const total = merchants.length + places.length

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Store size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Merchants &amp; Places</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {total > 0
            ? 'The businesses you buy from and the places you go, derived from your timeline'
            : 'The businesses you buy from and the places you go — import PayPal, Amazon, Google Pay, or your calendar on the Timeline to see them here'}
        </p>
      </div>

      {total > 0 && (
        <div className="relative mb-4">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a merchant or place…"
            aria-label="Find a merchant or place"
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      )}

      {loaded && total === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          No merchants or places yet. Import a <span className="text-foreground">PayPal</span>,{' '}
          <span className="text-foreground">Amazon</span>, or{' '}
          <span className="text-foreground">Google Pay</span> export — or your{' '}
          <span className="text-foreground">calendar</span> — on the Timeline.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Section
            title="Merchants"
            icon={<Store size={13} />}
            items={shownMerchants}
            onSave={save}
            onOpen={(e) => navigate(`/timeline?q=${encodeURIComponent(e.name)}`)}
            promoting={promoting}
            fmtMonth={fmtMonth}
          />
          <Section
            title="Places"
            icon={<MapPin size={13} />}
            items={shownPlaces}
            onSave={save}
            onOpen={(e) => navigate(`/timeline?q=${encodeURIComponent(e.name)}`)}
            promoting={promoting}
            fmtMonth={fmtMonth}
          />
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  icon,
  items,
  onSave,
  onOpen,
  promoting,
  fmtMonth
}: {
  title: string
  icon: JSX.Element
  items: DerivedEntity[]
  onSave: (e: DerivedEntity) => void
  onOpen: (e: DerivedEntity) => void
  promoting: string | null
  fmtMonth: (ms: number | null) => string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
        {icon} {title} ({items.length})
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((e) => (
          <li
            key={e.key}
            className="flex items-center gap-2 rounded-lg border border-border bg-card pr-2 hover:border-primary/40 hover:bg-card/80 transition-colors"
          >
            <button
              type="button"
              onClick={() => onOpen(e)}
              title={`See everything involving ${e.name} on the timeline`}
              className="flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 text-left"
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
            {e.promotedKind === 'place' ? (
              <span className="shrink-0 flex items-center gap-1 text-[11px] text-primary px-2 py-1">
                <Check size={12} /> Saved
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSave(e)}
                disabled={promoting === e.key}
                title={`Save ${e.name}`}
                aria-label={`Save ${e.name}`}
                className="shrink-0 flex items-center gap-1 text-[11px] text-primary border border-primary/30 rounded px-2 py-1 hover:bg-primary/10 disabled:opacity-50 transition-colors"
              >
                <Plus size={12} /> Save
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
