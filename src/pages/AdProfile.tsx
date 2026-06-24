import { Megaphone, Search, Target } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

// The non-timeline "how advertisers see you" snapshot — fed by the Facebook ad-profile
// recognizer into `snapshot_facts` (category `ad-profile`), grouped by `label`:
// the advertisers that uploaded/used your info, and the targeting categories Meta
// inferred about you. The eye-opener: drop `advertisers_using_your_activity…` and
// `other_categories_used_to_reach_you.html` from your Facebook export on the Timeline.

const MAX_SHOWN = 500 // cap the rendered list (advertiser lists run to thousands)

type Group = { label: string; items: SnapshotFactRecord[] }

export default function AdProfile(): JSX.Element {
  const [facts, setFacts] = useState<SnapshotFactRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!window.api) return
    window.api.snapshot
      .list({ source: 'facebook', category: 'ad-profile' })
      .then(setFacts)
      .finally(() => setLoaded(true))
  }, [])

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase()
    const byLabel = new Map<string, SnapshotFactRecord[]>()
    for (const f of facts) {
      if (q && !f.value.toLowerCase().includes(q)) continue
      const key = f.label ?? 'Other'
      const arr = byLabel.get(key)
      if (arr) arr.push(f)
      else byLabel.set(key, [f])
    }
    // Advertisers (the big list) first, then categories, then anything else.
    const order = (l: string) => (l === 'Advertiser' ? 0 : l === 'Category' ? 1 : 2)
    return [...byLabel.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label))
  }, [facts, query])

  const total = facts.length

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Target size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Ad Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {total > 0 ? (
            <>
              <span className="font-semibold text-foreground">{total.toLocaleString()}</span> things
              advertisers know about you — pulled from your Facebook export
            </>
          ) : (
            'How advertisers see you — drop your Facebook ad files on the Timeline to fill this in'
          )}
        </p>
      </div>

      {total > 0 && (
        <div className="relative mb-5">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter advertisers and categories…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-card/40 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
        </div>
      )}

      {loaded && total === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
          <Megaphone size={22} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">No ad-profile data yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            From your Facebook "Download Your Information" export, drop{' '}
            <code className="text-foreground">
              advertisers_using_your_activity_or_information.html
            </code>{' '}
            and <code className="text-foreground">other_categories_used_to_reach_you.html</code> on
            the Timeline. Nothing leaves your machine.
          </p>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => {
          const shown = g.items.slice(0, MAX_SHOWN)
          return (
            <section key={g.label}>
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-sm font-semibold text-foreground">
                  {g.label === 'Advertiser'
                    ? 'Advertisers with your info'
                    : g.label === 'Category'
                      ? 'Categories used to reach you'
                      : g.label}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {g.items.length.toLocaleString()}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {shown.map((f) => (
                  <span
                    key={f.id}
                    className="px-2.5 py-1 rounded-md bg-card/60 border border-border text-xs text-foreground"
                  >
                    {f.value}
                  </span>
                ))}
              </div>
              {g.items.length > MAX_SHOWN && (
                <p className="text-xs text-muted-foreground mt-2">
                  Showing first {MAX_SHOWN.toLocaleString()} of {g.items.length.toLocaleString()} —
                  filter to narrow.
                </p>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
