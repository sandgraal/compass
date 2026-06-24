import { Bookmark, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

// The static "things you've saved" snapshot from Google Takeout — fed into
// `snapshot_facts` (category `google-saved`), grouped by `label`: your YouTube
// subscriptions and your Chrome bookmarks. Drop `subscriptions.csv` and
// `Bookmarks.html` from your Google Takeout export on the Timeline. Local-only.

const MAX_SHOWN = 600 // cap the rendered list (bookmarks run to the hundreds)

type Group = { label: string; items: SnapshotFactRecord[] }

export default function GoogleSaved(): JSX.Element {
  const [facts, setFacts] = useState<SnapshotFactRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!window.api) return
    window.api.snapshot
      .list({ source: 'google', category: 'google-saved' })
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
    const order = (l: string) => (l === 'YouTube subscription' ? 0 : l === 'Bookmark' ? 1 : 2)
    return [...byLabel.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label))
  }, [facts, query])

  const total = facts.length

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Bookmark size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Saved</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {total > 0
            ? 'The channels you follow and the pages you bookmarked, from your Google export'
            : 'Your subscriptions & bookmarks — drop your Google Takeout files on the Timeline'}
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
            aria-label="Filter subscriptions and bookmarks"
            placeholder="Filter subscriptions and bookmarks…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-card/40 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
        </div>
      )}

      {loaded && total === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
          <Bookmark size={22} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">No saved data yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            From your Google Takeout export, drop{' '}
            <code className="text-foreground">subscriptions.csv</code> and{' '}
            <code className="text-foreground">Bookmarks.html</code> on the Timeline. Nothing leaves
            your machine.
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
                  {g.label === 'YouTube subscription'
                    ? 'YouTube subscriptions'
                    : g.label === 'Bookmark'
                      ? 'Bookmarks'
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
