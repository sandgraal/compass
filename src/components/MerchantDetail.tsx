/**
 * Tracked-merchant profile panel (merchants redesign) — the right side of the
 * Merchants master–detail. Renders everything `merchants:profile` knows about
 * one merchant: live stats, price-trend banner, monthly spend chart, linked
 * subscription, recent transactions, cross-source activity, attached
 * documents, tax rollup, and the inline-editable details (category / website /
 * address / support contacts / notes).
 */
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Clock,
  CreditCard,
  ExternalLink,
  EyeOff,
  FileText,
  Globe,
  Landmark,
  Paperclip,
  Pencil,
  Receipt,
  RefreshCw,
  Sparkles,
  Store,
  TrendingDown,
  TrendingUp,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'
import PlaceWebEnrichDialog from './places/PlaceWebEnrichDialog'
import WebPresenceCard from './places/WebPresenceCard'
import { useConfirm } from './ui/ConfirmDialog'
import { useToast } from './ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const fmtDate = (iso: string | null): string =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—'

/** '2026-03' → 'Mar 26' for the chart axis. */
const fmtMonthTick = (month: string): string => {
  const [y, m] = month.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  return `${d.toLocaleDateString('en-US', { month: 'short' })} ${y.slice(2)}`
}

export default function MerchantDetail({
  merchantId,
  onChanged,
  onUntracked
}: {
  merchantId: number
  /** Fired after an edit persisted — the parent list refreshes names/categories. */
  onChanged: () => void
  onUntracked: () => void
}): JSX.Element {
  const [profile, setProfile] = useState<MerchantProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [webEnrichOpen, setWebEnrichOpen] = useState(false)
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { toast } = useToast()

  const load = useCallback(async (): Promise<void> => {
    if (!isElectron()) {
      setProfile(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setProfile(await window.api.merchants.profile(merchantId))
    } catch {
      toast('Could not load this merchant', 'error')
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [merchantId, toast])

  useEffect(() => {
    setEditing(false)
    void load()
  }, [load])

  async function untrack(): Promise<void> {
    if (!profile) return
    const ok = await confirm({
      title: `Stop tracking ${profile.place.name}?`,
      description:
        'The merchant moves back to Discovered. Your saved details are removed. Attached documents stay linked and reappear if you track it again.',
      confirmLabel: 'Untrack',
      destructive: true
    })
    if (!ok) return
    try {
      await window.api.merchants.untrack(merchantId)
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
          targetKind: 'merchant',
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
    return <p className="text-sm text-muted-foreground">Could not load this merchant.</p>
  }

  const { place, stats, monthly, priceTrend, subscription } = profile
  const cur = stats.currency

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
            {stats.firstTxnDate && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar size={11} /> since {fmtDate(stats.firstTxnDate)}
              </span>
            )}
          </div>
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
          {subscription && (
            <button
              type="button"
              onClick={() => navigate('/subscriptions')}
              title="Open in Subscriptions"
              aria-label="Open in Subscriptions"
              className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            >
              <CreditCard size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setWebEnrichOpen(true)}
            title="Enrich from web (uses your Anthropic key, review before saving)"
            aria-label="Enrich from web"
            className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
          >
            <Sparkles size={16} />
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

      {/* Price trend banner */}
      {priceTrend && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm',
            priceTrend.direction === 'up'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-primary/30 bg-primary/10 text-primary'
          )}
        >
          {priceTrend.direction === 'up' ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
          Average charge {priceTrend.direction === 'up' ? 'up' : 'down'}{' '}
          {Math.abs(priceTrend.pct).toFixed(0)}% vs your history —{' '}
          {formatMoney(priceTrend.historicalMedian, cur)} →{' '}
          {formatMoney(priceTrend.recentMedian, cur)}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="Total spent" value={formatMoney(stats.totalSpend, cur)} />
        <StatCard
          label="Transactions"
          value={String(stats.txnCount)}
          sub={
            stats.refundTotal > 0 ? `${formatMoney(stats.refundTotal, cur)} refunded` : undefined
          }
        />
        <StatCard label="Average charge" value={formatMoney(stats.avgTxn, cur)} />
        <StatCard label="Last seen" value={fmtDate(stats.lastTxnDate)} />
        <StatCard
          label="This year"
          value={formatMoney(stats.thisYearSpend, cur)}
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
        {stats.monthlyMedian != null && (
          <StatCard label="Typical month" value={`~${formatMoney(stats.monthlyMedian, cur)}`} />
        )}
      </div>

      {/* Spend over time */}
      {monthly.length > 1 && (
        <Section icon={<Activity size={14} />} title="Spend over time">
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
                  tickFormatter={(v) =>
                    formatMoney(v as number, cur, { decimals: 0, compact: true })
                  }
                  width={54}
                />
                <Tooltip
                  formatter={(v) => [formatMoney(Number(v), cur), 'Spend']}
                  labelFormatter={(label) => fmtMonthTick(String(label))}
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: 12
                  }}
                />
                <Bar dataKey="spend" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Subscription */}
      {subscription && (
        <Section icon={<CreditCard size={14} />} title="Subscription">
          <div className="rounded-lg border border-border bg-card px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {formatMoney(subscription.cost, cur)} / {subscription.cadence}
                <span
                  className={cn(
                    'ml-2 text-[11px] px-1.5 py-0.5 rounded-full capitalize',
                    subscription.status === 'active'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-secondary text-muted-foreground'
                  )}
                >
                  {subscription.status}
                </span>
              </p>
              {subscription.nextRenewal && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Renews {fmtDate(subscription.nextRenewal)}
                </p>
              )}
            </div>
            {subscription.cancelUrl && (
              <a
                href={subscription.cancelUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline flex items-center gap-1"
              >
                Cancel page <ExternalLink size={11} />
              </a>
            )}
          </div>
        </Section>
      )}

      {/* Transactions */}
      {profile.transactions.length > 0 && (
        <Section icon={<Receipt size={14} />} title={`Recent transactions (${stats.txnCount})`}>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {profile.transactions.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{t.description}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {fmtDate(t.date)}
                    {t.category && t.category !== 'Uncategorized' && ` · ${t.category}`}
                    {t.taxTag !== 'tax:none' && (
                      <span className="ml-1.5 px-1 py-px rounded bg-secondary text-muted-foreground">
                        {t.taxTag.replace('tax:', '')}
                      </span>
                    )}
                  </p>
                </div>
                <span
                  className={cn(
                    'text-sm font-medium shrink-0 tabular-nums',
                    t.amount > 0 ? 'text-primary' : 'text-foreground'
                  )}
                >
                  {formatMoney(t.amount, t.currency)}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => navigate('/finance')}
            className="mt-2 text-xs text-primary hover:underline"
          >
            See all in Finance →
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

      {/* Web presence (accepted web-enrichment findings) */}
      {profile.place.meta?.enrichment?.web && (
        <Section icon={<Globe size={14} />} title="Web presence">
          <WebPresenceCard web={profile.place.meta.enrichment.web} />
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
            Receipts, warranties, manuals — attach anything worth keeping with this merchant.
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
                    <span className="text-xs text-muted-foreground ml-2">{fmtDate(d.docDate)}</span>
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

      {/* Tax */}
      {profile.tax.length > 0 && (
        <Section icon={<Landmark size={14} />} title="Tax">
          <ul className="space-y-1">
            {profile.tax.map((t) => (
              <li
                key={`${t.taxTag}|${t.taxYear}`}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="text-foreground">
                  {t.taxTag.replace('tax:', '')}
                  {t.taxYear && <span className="text-muted-foreground ml-1.5">{t.taxYear}</span>}
                </span>
                <span className="text-foreground font-medium tabular-nums">
                  {formatMoney(t.total, cur)}
                  <span className="text-xs text-muted-foreground ml-1.5">({t.count})</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Details (read view) */}
      {!editing && (place.address || place.notes || profile.place.meta?.support || place.url) && (
        <Section icon={<Store size={14} />} title="Details">
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
            {profile.place.meta?.support?.email && (
              <DetailLine label="Support">
                <a
                  href={`mailto:${profile.place.meta.support.email}`}
                  className="text-primary hover:underline"
                >
                  {profile.place.meta.support.email}
                </a>
              </DetailLine>
            )}
            {profile.place.meta?.support?.phone && (
              <DetailLine label="Phone">{profile.place.meta.support.phone}</DetailLine>
            )}
            {place.notes && (
              <DetailLine label="Notes">
                <span className="whitespace-pre-wrap">{place.notes}</span>
              </DetailLine>
            )}
          </div>
        </Section>
      )}

      <PlaceWebEnrichDialog
        place={{
          id: place.id,
          name: place.name,
          kind: place.kind,
          category: place.category,
          address: place.address
        }}
        open={webEnrichOpen}
        onClose={() => setWebEnrichOpen(false)}
        onApplied={async () => {
          await load()
          onChanged()
        }}
      />
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
  profile: MerchantProfile
  onSaved: () => void
  onCancel: () => void
}): JSX.Element {
  const { place } = profile
  const [draft, setDraft] = useState({
    name: place.name,
    category: place.category ?? '',
    url: place.url ?? '',
    address: place.address ?? '',
    notes: place.notes ?? '',
    supportEmail: profile.place.meta?.support?.email ?? '',
    supportPhone: profile.place.meta?.support?.phone ?? ''
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
      await window.api.merchants.update(place.id, {
        name: draft.name,
        category: draft.category.trim() || null,
        url: draft.url.trim() || null,
        address: draft.address.trim() || null,
        notes: draft.notes.trim() || null,
        meta: {
          support:
            draft.supportEmail.trim() || draft.supportPhone.trim()
              ? { email: draft.supportEmail.trim(), phone: draft.supportPhone.trim() }
              : undefined
        }
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
            placeholder="Coffee, Groceries…"
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
        <label className="block">
          <span className="text-xs text-muted-foreground">Support email</span>
          <input
            value={draft.supportEmail}
            onChange={(e) => setDraft({ ...draft, supportEmail: e.target.value })}
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Support phone</span>
          <input
            value={draft.supportPhone}
            onChange={(e) => setDraft({ ...draft, supportPhone: e.target.value })}
            className={field}
          />
        </label>
        <label className="block col-span-2">
          <span className="text-xs text-muted-foreground">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={3}
            placeholder="Account numbers to avoid, return policy, who to ask for…"
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
