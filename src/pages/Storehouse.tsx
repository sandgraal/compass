import { CalendarClock, ChevronRight, CreditCard, Home, Layers, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const TYPE_LABEL: Record<string, string> = {
  insurance: 'Insurance',
  vehicle: 'Vehicles',
  property: 'Property',
  membership: 'Memberships',
  warranty: 'Warranties',
  pet: 'Pets',
  other: 'Other'
}

export default function Storehouse(): JSX.Element {
  const [summary, setSummary] = useState<StorehouseSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    window.api.storehouse
      .summary()
      .then(setSummary)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-center gap-2.5 mb-1">
        <Layers size={22} className="text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">Your Storehouse</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
        Everything you've brought into Compass, in one place — owned, local, and yours. Click any
        tile to dive in.
      </p>

      {loading ? (
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-24 bg-secondary/30 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Tile
              icon={<Users size={16} className="text-primary" />}
              label="Contacts"
              value={`${summary?.contacts.count ?? 0}`}
              sub="people"
              onClick={() => navigate('/contacts')}
            />
            <Tile
              icon={<CreditCard size={16} className="text-primary" />}
              label="Subscriptions"
              value={money(summary?.subscriptions.annualTotal ?? 0)}
              sub={`${summary?.subscriptions.activeCount ?? 0} active /yr`}
              onClick={() => navigate('/subscriptions')}
            />
            <Tile
              icon={<Home size={16} className="text-primary" />}
              label="Assets"
              value={money(summary?.assets.totalValue ?? 0)}
              sub={`${summary?.assets.count ?? 0} item(s)`}
              onClick={() => navigate('/assets')}
            />
          </div>

          {summary && summary.assets.byType.length > 0 && (
            <div className="mt-6">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Assets by type
              </h2>
              <div className="rounded-xl border border-border bg-card divide-y divide-border">
                {summary.assets.byType.map((t) => (
                  <button
                    key={t.type}
                    type="button"
                    onClick={() => navigate('/assets')}
                    className="w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-secondary/40 transition-colors"
                  >
                    <span className="text-foreground">
                      {TYPE_LABEL[t.type] ?? t.type}{' '}
                      <span className="text-muted-foreground">· {t.count}</span>
                    </span>
                    <span className="text-muted-foreground">{money(t.value)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <CalendarClock size={12} /> Coming up (next 60 days)
            </h2>
            {summary && summary.upcomingRenewals.length > 0 ? (
              <div className="rounded-xl border border-border bg-card divide-y divide-border">
                {summary.upcomingRenewals.map((r) => (
                  <div
                    key={`${r.source}:${r.name}:${r.date}`}
                    className="flex items-center justify-between px-4 py-2.5 text-sm"
                  >
                    <span className="text-foreground">
                      {r.name}{' '}
                      <span className="text-xs text-muted-foreground capitalize">· {r.source}</span>
                    </span>
                    <span
                      className={cn(
                        'text-xs',
                        r.daysUntil <= 7 ? 'text-amber-500' : 'text-muted-foreground'
                      )}
                    >
                      {r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`} · {r.date}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground px-1">
                No renewals or expiries in the next 60 days.
              </p>
            )}
          </div>

          <div className="mt-8 grid grid-cols-2 gap-2">
            <DomainLink label="Export everything" to="/export" />
            <DomainLink label="Vault (secrets)" to="/vault" />
          </div>
        </>
      )}
    </div>
  )
}

function Tile({
  icon,
  label,
  value,
  sub,
  onClick
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-xl border border-border bg-card hover:border-primary/40 px-4 py-3 text-left transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon} {label}
      </div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </button>
  )
}

function DomainLink({ label, to }: { label: string; to: string }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="flex items-center justify-between px-4 py-2.5 rounded-xl border border-border bg-card hover:border-primary/40 text-sm text-foreground transition-colors"
    >
      {label}
      <ChevronRight size={14} className="text-muted-foreground" />
    </button>
  )
}
