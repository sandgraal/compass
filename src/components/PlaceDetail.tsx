/**
 * Tracked-place profile panel (places redesign) — the right side of the
 * Places master–detail. Renders everything `places:profile` knows about one
 * place: visit stats, the visits-over-time chart, recent visits (calendar
 * events, rides, trips), cross-source timeline activity, attached documents,
 * and the inline-editable details (category / website / address / notes).
 */
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Car,
  Clock,
  EyeOff,
  FileText,
  Globe,
  MapPin,
  Paperclip,
  Pencil,
  Plane,
  RefreshCw,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { cn } from '../lib/utils'
import { useConfirm } from './ui/ConfirmDialog'
import { useToast } from './ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const fmtTs = (ts: number | null): string =>
  ts ? new Date(ts).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—'

/** '2026-03' → 'Mar 26' for the chart axis. */
const fmtMonthTick = (month: string): string => {
  const [y, m] = month.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  return `${d.toLocaleDateString('en-US', { month: 'short' })} ${y.slice(2)}`
}

/** How each visit source reads in lists ("calendar event", "Uber ride", …). */
const VISIT_SOURCE_META: Record<string, { label: string; icon: JSX.Element }> = {
  gcal: { label: 'Calendar', icon: <Calendar size={12} /> },
  uber: { label: 'Uber', icon: <Car size={12} /> },
  lyft: { label: 'Lyft', icon: <Car size={12} /> },
  travel: { label: 'Trip', icon: <Plane size={12} /> }
}

const visitSourceLabel = (source: string): string => VISIT_SOURCE_META[source]?.label ?? source

export default function PlaceDetail({
  placeId,
  onChanged,
  onUntracked
}: {
  placeId: number
  /** Fired after an edit persisted — the parent list refreshes names/categories. */
  onChanged: () => void
  onUntracked: () => void
}): JSX.Element {
  const [profile, setProfile] = useState<PlaceProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { toast } = useToast()
  // Monotonic token so a slow profile load can't overwrite a newer selection.
  const loadSeq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!isElectron()) {
      setProfile(null)
      setLoading(false)
      return
    }
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const p = await window.api.places.profile(placeId)
      if (seq === loadSeq.current) setProfile(p)
    } catch {
      if (seq === loadSeq.current) {
        toast('Could not load this place', 'error')
        setProfile(null)
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [placeId, toast])

  useEffect(() => {
    setEditing(false)
    void load()
  }, [load])

  async function untrack(): Promise<void> {
    if (!profile) return
    const ok = await confirm({
      title: `Stop tracking ${profile.place.name}?`,
      description:
        'The place moves back to Discovered. Your saved details are removed. Attached documents stay linked and reappear if you track it again.',
      confirmLabel: 'Untrack',
      destructive: true
    })
    if (!ok) return
    try {
      await window.api.places.untrack(placeId)
      toast(`Untracked ${profile.place.name}`, 'success')
      onUntracked()
    } catch {
      toast('Could not untrack', 'error')
    }
  }

  async function attachDocument(): Promise<void> {
    if (!profile) return
    try {
      const res = await window.api.documents.import()
      const ids = res.perFile.map((f) => f.id).filter((id): id is number => id != null)
      if (ids.length === 0) return
      for (const documentId of ids) {
        await window.api.documents.attach({
          documentId,
          targetKind: 'place',
          targetId: profile.place.externalId
        })
      }
      toast(`Attached ${ids.length} document${ids.length === 1 ? '' : 's'}`, 'success')
      void load()
    } catch {
      toast('Could not attach the document', 'error')
    }
  }

  async function detachDocument(linkId: number): Promise<void> {
    try {
      await window.api.documents.detach(linkId)
      void load()
    } catch {
      toast('Could not remove the attachment', 'error')
    }
  }

  if (loading && !profile) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-24 bg-secondary/30 rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }
  if (!profile) {
    return <p className="text-sm text-muted-foreground">Could not load this place.</p>
  }

  const { place, stats, monthly } = profile
  const sourceBreakdown = stats.bySource
    .map((s) => `${s.count} ${visitSourceLabel(s.source).toLowerCase()}`)
    .join(' · ')

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header + quick actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-foreground capitalize truncate">
            {place.name}
          </h2>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {place.category && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                {place.category}
              </span>
            )}
            {stats.cadence && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary flex items-center gap-1">
                <RefreshCw size={10} /> {stats.cadence}
              </span>
            )}
            {stats.firstVisit && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar size={11} /> since {fmtTs(stats.firstVisit)}
              </span>
            )}
          </div>
          {place.address && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1 truncate">
              <MapPin size={11} className="shrink-0" /> {place.address}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {place.url && (
            <a
              href={place.url}
              target="_blank"
              rel="noreferrer"
              title="Visit website"
              aria-label={`Visit ${place.name} website`}
              className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            >
              <Globe size={16} />
            </a>
          )}
          <button
            type="button"
            onClick={() => navigate(`/timeline?q=${encodeURIComponent(place.name)}`)}
            title="See everything on the timeline"
            aria-label="See on timeline"
            className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
          >
            <Clock size={16} />
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            title="Edit details"
            aria-label="Edit details"
            className={cn(
              'p-2 rounded-lg transition-colors',
              editing
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-primary hover:bg-secondary'
            )}
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            onClick={untrack}
            title="Stop tracking"
            aria-label="Stop tracking"
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <EyeOff size={16} />
          </button>
        </div>
      </div>

      {editing && (
        <EditDetails
          profile={profile}
          onSaved={() => {
            setEditing(false)
            void load()
            onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard
          label="Visits"
          value={String(stats.visitCount)}
          sub={sourceBreakdown || undefined}
        />
        <StatCard
          label="This year"
          value={String(stats.thisYearVisits)}
          sub={
            stats.trendPct != null
              ? `${stats.trendPct >= 0 ? '+' : ''}${stats.trendPct.toFixed(0)}% vs last year`
              : undefined
          }
          subIcon={
            stats.trendPct == null ? undefined : stats.trendPct >= 0 ? (
              <ArrowUpRight size={11} />
            ) : (
              <ArrowDownRight size={11} />
            )
          }
        />
        <StatCard label="Last visit" value={fmtTs(stats.lastVisit)} />
      </div>

      {/* Visits over time */}
      {monthly.length > 1 && (
        <Section icon={<Activity size={14} />} title="Visits over time">
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="month"
                  tickFormatter={fmtMonthTick}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickMargin={6}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  allowDecimals={false}
                  width={30}
                />
                <Tooltip
                  formatter={(v) => [`${v} visit${Number(v) === 1 ? '' : 's'}`, 'Visits']}
                  labelFormatter={(label) => fmtMonthTick(String(label))}
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: 12
                  }}
                />
                <Bar dataKey="visits" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Recent visits */}
      {profile.visits.length > 0 && (
        <Section icon={<MapPin size={14} />} title={`Recent visits (${stats.visitCount})`}>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {profile.visits.map((v) => (
              <li key={v.recordId} className="flex items-center gap-3 px-3 py-2">
                <span className="shrink-0 text-muted-foreground" title={visitSourceLabel(v.source)}>
                  {VISIT_SOURCE_META[v.source]?.icon ?? <MapPin size={12} />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{v.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {visitSourceLabel(v.source)}
                    {v.occurredAt ? ` · ${fmtTs(v.occurredAt)}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => navigate(`/timeline?q=${encodeURIComponent(place.name)}`)}
            className="mt-2 text-xs text-primary hover:underline"
          >
            See all on the Timeline →
          </button>
        </Section>
      )}

      {/* Cross-source activity */}
      {profile.activity.length > 0 && (
        <Section icon={<Activity size={14} />} title="Across your timeline">
          <div className="space-y-1">
            {profile.activity.map((a) => (
              <button
                type="button"
                key={a.recordId}
                onClick={() => navigate(`/timeline?q=${encodeURIComponent(place.name)}`)}
                className="w-full flex items-baseline justify-between gap-3 text-left rounded-md px-2 py-1 -mx-2 hover:bg-secondary/60 transition-colors"
              >
                <span className="text-sm text-foreground truncate">{a.title}</span>
                <span className="text-xs text-muted-foreground shrink-0 capitalize">
                  {a.source}
                  {a.occurredAt ? ` · ${new Date(a.occurredAt).toLocaleDateString()}` : ''}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Documents */}
      <Section
        icon={<FileText size={14} />}
        title="Documents"
        action={
          <button
            type="button"
            onClick={attachDocument}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Paperclip size={11} /> Attach
          </button>
        }
      >
        {profile.documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Leases, menus, tickets, reservations — attach anything worth keeping with this place.
          </p>
        ) : (
          <ul className="space-y-1">
            {profile.documents.map((d) => (
              <li key={d.linkId} className="flex items-center gap-2 group">
                <button
                  type="button"
                  onClick={() => void window.api.documents.open(d.documentId)}
                  className="flex-1 min-w-0 text-left text-sm text-foreground hover:text-primary truncate transition-colors"
                  title={`Open ${d.title}`}
                >
                  {d.title}
                  {d.docDate && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {new Date(`${d.docDate}T00:00:00`).toLocaleDateString('en-US', {
                        dateStyle: 'medium'
                      })}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => detachDocument(d.linkId)}
                  title="Remove attachment"
                  aria-label={`Remove ${d.title}`}
                  className="shrink-0 p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Details (read view) */}
      {!editing && (place.address || place.notes || place.url) && (
        <Section icon={<MapPin size={14} />} title="Details">
          <div className="space-y-1.5 text-sm">
            {place.url && (
              <DetailLine label="Website">
                <a
                  href={place.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {place.url}
                </a>
              </DetailLine>
            )}
            {place.address && <DetailLine label="Address">{place.address}</DetailLine>}
            {place.notes && (
              <DetailLine label="Notes">
                <span className="whitespace-pre-wrap">{place.notes}</span>
              </DetailLine>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  subIcon
}: {
  label: string
  value: string
  sub?: string
  subIcon?: React.ReactNode
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-foreground mt-0.5 tabular-nums truncate">{value}</p>
      {sub && (
        <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-0.5">
          {subIcon}
          {sub}
        </p>
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  action,
  children
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          {icon} {title}
        </p>
        {action}
      </div>
      {children}
    </div>
  )
}

function DetailLine({
  label,
  children
}: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="text-foreground min-w-0">{children}</span>
    </div>
  )
}

function EditDetails({
  profile,
  onSaved,
  onCancel
}: {
  profile: PlaceProfile
  onSaved: () => void
  onCancel: () => void
}): JSX.Element {
  const { place } = profile
  const [draft, setDraft] = useState({
    name: place.name,
    category: place.category ?? '',
    url: place.url ?? '',
    address: place.address ?? '',
    notes: place.notes ?? ''
  })
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  async function save(): Promise<void> {
    if (!draft.name.trim()) {
      toast('Name is required', 'error')
      return
    }
    if (draft.url.trim() && !/^https?:\/\//i.test(draft.url.trim())) {
      toast('Website must start with http:// or https://', 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.places.update(place.id, {
        name: draft.name,
        category: draft.category.trim() || null,
        url: draft.url.trim() || null,
        address: draft.address.trim() || null,
        notes: draft.notes.trim() || null
      })
      toast('Saved', 'success')
      onSaved()
    } catch {
      toast('Could not save the changes', 'error')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Category</span>
          <input
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            placeholder="Gym, Café, School…"
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Website</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://…"
            className={field}
          />
        </label>
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Address</span>
          <input
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            className={field}
          />
        </label>
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={3}
            placeholder="Parking tips, who to ask for, hours that actually apply…"
            className={field}
          />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-sm px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
