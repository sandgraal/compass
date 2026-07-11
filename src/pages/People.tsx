import {
  EyeOff,
  Facebook,
  Linkedin,
  MessageSquare,
  Network,
  Phone,
  Search,
  User,
  UserPlus,
  Wallet,
  X
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

function fmtMoney(n: number, currency?: string | null): string {
  const rounded = Math.round(n).toLocaleString('en-US')
  return currency && currency !== 'USD' ? `${rounded} ${currency}` : `$${rounded}`
}

export default function People(): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [promotedCount, setPromotedCount] = useState(0)
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [excluding, setExcluding] = useState(false)
  const navigate = useNavigate()
  const { toast } = useToast()

  /**
   * Promote a derived person into the owned contacts table. Once they're a
   * contact they LEAVE this page — Contacts is their home now (their info keeps
   * flowing into the contact record via enrichment).
   */
  async function addToContacts(p: Person): Promise<void> {
    if (!isElectron() || promoting) return
    setPromoting(p.key)
    try {
      const res = await window.api.entities.promote({ kind: 'person', key: p.key })
      if (res.success && res.promotedId != null) {
        setPeople((prev) => prev.filter((x) => x.key !== p.key))
        setPromotedCount((n) => n + 1)
        setSelected((prev) => {
          if (!prev.has(p.key)) return prev
          const next = new Set(prev)
          next.delete(p.key)
          return next
        })
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

  /** Permanently hide the selected people — they never reappear on any rebuild. */
  async function excludeSelected(): Promise<void> {
    if (!isElectron() || selected.size === 0) return
    setExcluding(true)
    try {
      const items = [...selected].map((key) => ({ kind: 'person' as const, key }))
      const r = await window.api.entities.exclude(items)
      if (r.success) {
        setPeople((prev) => prev.filter((p) => !selected.has(p.key)))
        toast(
          `Hidden ${r.excluded} ${r.excluded === 1 ? 'entry' : 'entries'} — they won't come back. (Undo in Settings → Hidden people.)`,
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

  useEffect(() => {
    if (!isElectron()) {
      setLoaded(true)
      return
    }
    // `loaded` must flip even if the IPC rejects, or the page renders a blank area
    // (neither the empty state nor the list).
    void window.api.people
      .list()
      .then((r) => {
        setPeople(r.people)
        setPromotedCount(r.promotedCount)
      })
      .catch(() => toast('Could not load your people directory', 'error'))
      .finally(() => setLoaded(true))
  }, [toast])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? people.filter((p) => p.key.includes(q)) : people
  }, [people, query])

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Network size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">People</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {people.length > 0 || promotedCount > 0 ? (
            <>
              <span className="font-semibold text-foreground">{people.length}</span>{' '}
              {people.length === 1 ? 'person' : 'people'} across your data
              {promotedCount > 0 && ` · ${promotedCount} already in your contacts`}
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

      {selected.size > 0 && (
        <div className="sticky top-12 z-10 mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm">
          <span className="text-sm text-foreground">{selected.size} selected</span>
          <button
            type="button"
            onClick={excludeSelected}
            disabled={excluding}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            <EyeOff size={12} />
            {excluding ? 'Hiding…' : `Not interested (${selected.size})`}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={12} /> Clear
          </button>
        </div>
      )}

      {loaded && people.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          {promotedCount > 0 ? (
            <>Everyone here is already in your contacts. New people show up as your data grows.</>
          ) : (
            <>
              No people yet. Import a <span className="text-foreground">LinkedIn</span>,{' '}
              <span className="text-foreground">Facebook</span>, or{' '}
              <span className="text-foreground">PayPal</span> export — or your{' '}
              <span className="text-foreground">Messages</span> — on the Timeline to see everyone
              you connect with, message, and pay.
            </>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((p) => (
            <li
              key={p.key}
              className="flex items-center gap-2 rounded-lg border border-border bg-card pr-2 hover:border-primary/40 hover:bg-card/80 transition-colors"
            >
              <label className="pl-3 py-2.5 shrink-0 flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(p.key)}
                  onChange={() => toggleSelect(p.key)}
                  aria-label={`Select ${p.name}`}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))] cursor-pointer"
                />
              </label>
              <button
                type="button"
                onClick={() => navigate(`/timeline?q=${encodeURIComponent(p.name)}`)}
                title={`See everything involving ${p.name} on the timeline`}
                className="flex-1 min-w-0 flex items-center gap-3 pr-4 py-2.5 text-left"
              >
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-foreground truncate block">{p.name}</span>
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
                  {p.totalSpend != null && p.totalSpend > 0 && (
                    <div
                      className="text-[11px] text-emerald-500 mt-0.5"
                      title="Money exchanged via Venmo / PayPal"
                    >
                      {fmtMoney(p.totalSpend, p.currency)} exchanged
                    </div>
                  )}
                </div>
              </button>
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
