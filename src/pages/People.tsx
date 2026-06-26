import {
  Facebook,
  Linkedin,
  MessageSquare,
  Network,
  Search,
  User,
  UserCheck,
  Wallet
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const SOURCE_META: Record<string, { label: string; icon: JSX.Element }> = {
  linkedin: { label: 'LinkedIn', icon: <Linkedin size={12} /> },
  facebook: { label: 'Facebook', icon: <Facebook size={12} /> },
  imessage: { label: 'Messages', icon: <MessageSquare size={12} /> },
  paypal: { label: 'PayPal', icon: <Wallet size={12} /> }
}
function sourceMeta(s: string): { label: string; icon: JSX.Element } {
  return SOURCE_META[s] ?? { label: s, icon: <User size={12} /> }
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

export default function People(): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const navigate = useNavigate()
  const { toast } = useToast()

  useEffect(() => {
    if (!isElectron()) {
      setLoaded(true)
      return
    }
    // `loaded` must flip even if the IPC rejects, or the page renders a blank area
    // (neither the empty state nor the list).
    void window.api.people
      .list()
      .then(setPeople)
      .catch(() => toast('Could not load your people directory', 'error'))
      .finally(() => setLoaded(true))
  }, [toast])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? people.filter((p) => p.key.includes(q)) : people
  }, [people, query])

  const inContacts = people.filter((p) => p.contactId != null).length

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Network size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">People</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {people.length > 0 ? (
            <>
              <span className="font-semibold text-foreground">{people.length}</span>{' '}
              {people.length === 1 ? 'person' : 'people'} across your data
              {inContacts > 0 && ` · ${inContacts} in your contacts`}
            </>
          ) : (
            'The people in your imported data — who you connect with, message, and pay, in one place'
          )}
        </p>
      </div>

      {people.length > 0 && (
        <div className="relative mb-4">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person…"
            aria-label="Find a person"
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      )}

      {loaded && people.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          No people yet. Drop a <span className="text-foreground">LinkedIn</span>,{' '}
          <span className="text-foreground">Facebook</span>, or{' '}
          <span className="text-foreground">PayPal</span> export on the Timeline to see everyone you
          connect with, message, and pay.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => navigate(`/timeline?q=${encodeURIComponent(p.name)}`)}
                title={`See everything involving ${p.name} on the timeline`}
                className="w-full flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-left hover:border-primary/40 hover:bg-card/80 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate">{p.name}</span>
                    {p.contactId != null && (
                      <span className="flex items-center gap-1 text-[11px] text-primary shrink-0">
                        <UserCheck size={12} /> In contacts
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {p.sources.map((s) => (
                      <span
                        key={s}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground bg-muted rounded px-1.5 py-0.5"
                      >
                        {sourceMeta(s).icon}
                        {sourceMeta(s).label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-foreground">{p.count}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {p.count === 1 ? 'touchpoint' : 'touchpoints'}
                    {p.lastSeen != null && ` · ${fmtMonth(p.lastSeen)}`}
                  </div>
                </div>
              </button>
            </li>
          ))}
          {shown.length === 0 && query && (
            <li className="text-sm text-muted-foreground px-4 py-3">No one matches "{query}".</li>
          )}
        </ul>
      )}
    </div>
  )
}
