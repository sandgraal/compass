import {
  Facebook,
  Linkedin,
  MessageSquare,
  Network,
  Phone,
  Search,
  User,
  UserCheck,
  UserPlus,
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
  paypal: { label: 'PayPal', icon: <Wallet size={12} /> },
  venmo: { label: 'Venmo', icon: <Wallet size={12} /> },
  'google-voice': { label: 'Voice', icon: <Phone size={12} /> }
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
  const [promoting, setPromoting] = useState<string | null>(null)
  const navigate = useNavigate()
  const { toast } = useToast()

  /** Promote a derived person into the owned contacts table (idempotent). */
  async function addToContacts(p: Person): Promise<void> {
    if (!isElectron() || promoting) return
    setPromoting(p.key)
    try {
      const res = await window.api.entities.promote({ kind: 'person', key: p.key })
      // Only mark "in contacts" with a REAL contact id — never a `-1` sentinel that
      // would point the UI at a non-existent row.
      if (res.success && res.promotedId != null) {
        const id = res.promotedId
        setPeople((prev) => prev.map((x) => (x.key === p.key ? { ...x, contactId: id } : x)))
        toast(`Added ${p.name} to your contacts`, 'success')
      } else {
        toast(res.error ?? 'Could not add to contacts', 'error')
      }
    } catch {
      toast('Could not add to contacts', 'error')
    } finally {
      setPromoting(null)
    }
  }

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
          No people yet. Import a <span className="text-foreground">LinkedIn</span>,{' '}
          <span className="text-foreground">Facebook</span>, or{' '}
          <span className="text-foreground">PayPal</span> export — or your{' '}
          <span className="text-foreground">Messages</span> — on the Timeline to see everyone you
          connect with, message, and pay.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((p) => (
            <li
              key={p.key}
              className="flex items-center gap-2 rounded-lg border border-border bg-card pr-2 hover:border-primary/40 hover:bg-card/80 transition-colors"
            >
              <button
                type="button"
                onClick={() => navigate(`/timeline?q=${encodeURIComponent(p.name)}`)}
                title={`See everything involving ${p.name} on the timeline`}
                className="flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 text-left"
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
              {p.contactId == null && (
                <button
                  type="button"
                  onClick={() => addToContacts(p)}
                  disabled={promoting === p.key}
                  title={`Add ${p.name} to your contacts`}
                  aria-label={`Add ${p.name} to your contacts`}
                  className="shrink-0 flex items-center gap-1 text-[11px] text-primary border border-primary/30 rounded px-2 py-1 hover:bg-primary/10 disabled:opacity-50 transition-colors"
                >
                  <UserPlus size={12} /> Add
                </button>
              )}
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
