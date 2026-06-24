import { Blocks } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

// The off-Meta app inventory — fed by the Facebook apps recognizer into
// `snapshot_facts` (category `apps`), grouped by `label`: the third-party apps you've
// connected to Facebook, and the apps you've blocked. (The dated connections also
// land on the Timeline as off-Facebook events; this is the at-a-glance inventory.)
// Drop `connected_apps_and_websites.html` + `permissions_you_have_granted_to_apps.html`
// from your Facebook export on the Timeline.

type Group = { label: string; items: SnapshotFactRecord[] }

export default function Apps(): JSX.Element {
  const [facts, setFacts] = useState<SnapshotFactRecord[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!window.api) return
    window.api.snapshot
      .list({ source: 'facebook', category: 'apps' })
      .then(setFacts)
      .finally(() => setLoaded(true))
  }, [])

  const groups = useMemo<Group[]>(() => {
    const byLabel = new Map<string, SnapshotFactRecord[]>()
    for (const f of facts) {
      const key = f.label ?? 'Other'
      const arr = byLabel.get(key)
      if (arr) arr.push(f)
      else byLabel.set(key, [f])
    }
    // Connected apps first, then blocked.
    const order = (l: string) => (l === 'Connected app' ? 0 : l === 'Blocked app' ? 1 : 2)
    return [...byLabel.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label))
  }, [facts])

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Blocks size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Apps &amp; Websites</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {facts.length > 0
            ? 'Third-party apps connected to — or blocked from — your Facebook account'
            : 'Apps connected to your account — drop your Facebook apps files on the Timeline'}
        </p>
      </div>

      {loaded && facts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
          <Blocks size={22} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">No apps data yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            From your Facebook "Download Your Information" export, drop{' '}
            <code className="text-foreground">connected_apps_and_websites.html</code> and{' '}
            <code className="text-foreground">permissions_you_have_granted_to_apps.html</code> on
            the Timeline. Nothing leaves your machine.
          </p>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.label}>
            <div className="flex items-baseline gap-2 mb-2">
              <h2 className="text-sm font-semibold text-foreground">
                {g.label === 'Connected app'
                  ? 'Connected apps'
                  : g.label === 'Blocked app'
                    ? 'Blocked apps'
                    : g.label}
              </h2>
              <span className="text-xs text-muted-foreground">{g.items.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((f) => (
                <span
                  key={f.id}
                  className="px-2.5 py-1 rounded-md bg-card/60 border border-border text-xs text-foreground"
                >
                  {f.value}
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
