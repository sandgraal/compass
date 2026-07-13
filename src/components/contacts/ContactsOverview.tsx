/**
 * The "hub" pane shown when contacts exist but none is open: headline stats,
 * a clickable per-source breakdown (sets the list's source filter), a
 * duplicates badge (opens the review panel), and the most recently active
 * people (from crossSource enrichment). Everything is computed from state the
 * page already holds — no extra IPC.
 */
import { Activity, GitMerge, Mail, Phone, Users } from 'lucide-react'
import { useMemo } from 'react'
import { formatRelative } from '../../lib/utils'

export default function ContactsOverview({
  contacts,
  dupeCount,
  sourceLabel,
  onFilterSource,
  onOpenContact,
  onReviewDupes
}: {
  contacts: ContactRecord[]
  dupeCount: number
  sourceLabel: (source: string) => string
  onFilterSource: (source: string) => void
  onOpenContact: (id: number) => void
  onReviewDupes: () => void
}): JSX.Element {
  const stats = useMemo(() => {
    let withEmail = 0
    let withPhone = 0
    const bySource = new Map<string, number>()
    for (const c of contacts) {
      if (c.emails.length > 0) withEmail++
      if (c.phones.length > 0) withPhone++
      bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1)
    }
    const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1])
    const recentlyActive = contacts
      .filter((c) => c.lastSeen != null)
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .slice(0, 5)
    return { withEmail, withPhone, sources, recentlyActive }
  }, [contacts])

  return (
    <div className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={<Users size={15} />} label="Contacts" value={contacts.length} />
        <StatTile icon={<Mail size={15} />} label="With email" value={stats.withEmail} />
        <StatTile icon={<Phone size={15} />} label="With phone" value={stats.withPhone} />
        <button
          type="button"
          onClick={onReviewDupes}
          disabled={dupeCount === 0}
          title={dupeCount > 0 ? 'Review possible duplicates' : 'No duplicates waiting'}
          className="rounded-lg border border-border bg-card/40 p-3 text-left transition-colors enabled:hover:border-primary/40 disabled:cursor-default"
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitMerge size={15} className={dupeCount > 0 ? 'text-amber-500' : undefined} />
            Duplicates
          </span>
          <span className="block mt-1 text-xl font-semibold text-foreground">{dupeCount}</span>
        </button>
      </div>

      {stats.sources.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Where they came from
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {stats.sources.map(([source, count]) => (
              <button
                key={source}
                type="button"
                onClick={() => onFilterSource(source)}
                title={`Show only ${sourceLabel(source)} contacts`}
                className="text-xs px-2.5 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
              >
                {sourceLabel(source)} <span className="text-foreground font-medium">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {stats.recentlyActive.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Activity size={13} className="text-primary" /> Recently active
          </h3>
          <ul className="space-y-1">
            {stats.recentlyActive.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenContact(c.id)}
                  className="w-full flex items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2 text-left hover:border-primary/40 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground truncate">
                      {c.displayName}
                    </span>
                    {(c.org || c.relationship) && (
                      <span className="block text-xs text-muted-foreground truncate">
                        {[c.org, c.relationship].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(c.lastSeen)}
                    {c.touchpointCount > 0 && ` · ${c.touchpointCount} touchpoints`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground/70">
        Select a contact on the left to see everything you know about them — or tick several to
        merge, tag, delete, or export them together.
      </p>
    </div>
  )
}

function StatTile({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: number
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon} {label}
      </span>
      <span className="block mt-1 text-xl font-semibold text-foreground">{value}</span>
    </div>
  )
}
