/**
 * Subscription detail panel (subscriptions redesign, phase 1) — mirrors
 * MerchantDetail.tsx: everything Compass knows about one tracked
 * subscription, cross-referencing the existing ledger-audit
 * (`auditSubscriptions`) and usage-record (`detectUnusedSubscriptions`)
 * detectors via `subscriptions:profile` rather than recomputing anything.
 *
 * Web enrichment (pricing/plans/cancellation steps/alternatives) is a
 * deliberately separate phase-2 follow-up — omitted here, not stubbed.
 */
import {
  AlertTriangle,
  Calendar,
  ExternalLink,
  FileText,
  Heart,
  Layers,
  Paperclip,
  Pencil,
  Receipt,
  Trash2,
  TrendingUp,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'
import { useConfirm } from './ui/ConfirmDialog'
import { useToast } from './ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semi-annual', 'yearly']
const STATUSES = ['active', 'paused', 'cancelled']

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-400',
  paused: 'bg-amber-500/15 text-amber-500',
  cancelled: 'bg-muted text-muted-foreground'
}

const USAGE_OPTIONS: Array<{ value: UsageRating; label: string }> = [
  { value: 'love', label: 'Love it' },
  { value: 'use', label: 'Use it' },
  { value: 'rarely', label: 'Rarely' },
  { value: 'barely', label: 'Barely' }
]

const fmtDate = (iso: string | null): string =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—'

/** Calendar days until an ISO 'YYYY-MM-DD' date; null when unset/unparseable. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const target = new Date(`${iso}T00:00:00`).getTime()
  if (Number.isNaN(target)) return null
  return Math.ceil((target - Date.now()) / 86_400_000)
}

export default function SubscriptionDetail({
  subscriptionId,
  onChanged,
  onDeleted
}: {
  subscriptionId: number
  /** Fired after an edit or usage rating persisted — the parent list refreshes. */
  onChanged: () => void
  onDeleted: () => void
}): JSX.Element {
  const [profile, setProfile] = useState<SubscriptionProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<SubscriptionInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [ratingBusy, setRatingBusy] = useState(false)
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
      setProfile(await window.api.subscriptions.profile(subscriptionId))
    } catch {
      toast('Could not load this subscription', 'error')
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [subscriptionId, toast])

  useEffect(() => {
    setEditing(false)
    void load()
  }, [load])

  function startEdit(): void {
    if (!profile) return
    const s = profile.subscription
    setDraft({
      name: s.name,
      cost: s.cost,
      cadence: s.cadence,
      category: s.category ?? '',
      status: s.status,
      nextRenewal: s.nextRenewal ?? '',
      trialEndsAt: s.trialEndsAt ?? '',
      paymentAccount: s.paymentAccount ?? '',
      cancelUrl: s.cancelUrl ?? '',
      notes: s.notes ?? ''
    })
    setEditing(true)
  }

  async function saveEdit(): Promise<void> {
    if (!draft || !isElectron()) return
    if (!draft.name?.trim()) {
      toast('A subscription needs a name.', 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.subscriptions.update(subscriptionId, draft)
      toast('Subscription saved.', 'success')
      setEditing(false)
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!profile) return
    const ok = await confirm({
      title: `Delete ${profile.subscription.name}?`,
      description: 'It will be removed from your tracked list.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok || !isElectron()) return
    await window.api.subscriptions.delete(subscriptionId)
    onDeleted()
  }

  async function rate(rating: UsageRating): Promise<void> {
    if (!isElectron() || ratingBusy) return
    setRatingBusy(true)
    try {
      await window.api.subscriptions.setUsage(subscriptionId, rating)
      await load()
      onChanged()
    } finally {
      setRatingBusy(false)
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
          targetKind: 'subscription',
          targetId: profile.subscription.externalId
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
    return <p className="text-sm text-muted-foreground">Could not load this subscription.</p>
  }

  const { subscription: s, totalPaid, signals, documents } = profile
  const trialDays = daysUntil(s.trialEndsAt)
  const renewalDays = daysUntil(s.nextRenewal)
  // Only an UPCOMING trial end is actionable — a past trialEndsAt (the
  // common case once a trial has already converted) must never claim the
  // date is "today" or hide a genuine upcoming renewal below.
  const trialUpcoming = trialDays != null && trialDays >= 0 && trialDays <= 14
  const usageRating = s.meta?.usage?.rating ?? null
  const hasSignalBanner =
    signals.priceHike ||
    signals.auditStatus === 'zombie' ||
    signals.auditStatus === 'expired' ||
    signals.isDuplicate ||
    (signals.unusedTrackable && signals.unused)

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header + quick actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-foreground truncate">{s.name}</h2>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full capitalize',
                STATUS_STYLE[s.status] ?? 'bg-muted text-muted-foreground'
              )}
            >
              {s.status}
            </span>
            {s.category && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                {s.category}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {formatMoney(s.cost, totalPaid.currency)} / {s.cadence}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {s.cancelUrl && (
            <a
              href={s.cancelUrl}
              target="_blank"
              rel="noreferrer"
              title="Cancel page"
              aria-label={`Cancel page for ${s.name}`}
              className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            >
              <ExternalLink size={16} />
            </a>
          )}
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : startEdit())}
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
            onClick={remove}
            title="Delete"
            aria-label={`Delete ${s.name}`}
            className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {editing && draft && (
        <EditForm
          draft={draft}
          setDraft={setDraft}
          onSave={saveEdit}
          onCancel={() => setEditing(false)}
          busy={busy}
        />
      )}

      {/* Trial / renewal countdown */}
      {trialUpcoming && (
        <Banner tone={trialDays! <= 3 ? 'destructive' : 'amber'} icon={<Calendar size={14} />}>
          {trialDays === 0
            ? 'Free trial ends today'
            : `Free trial ends in ${trialDays} day${trialDays === 1 ? '' : 's'}`}{' '}
          ({fmtDate(s.trialEndsAt)}) — decide before it converts to a paid plan.
        </Banner>
      )}
      {!trialUpcoming && renewalDays != null && renewalDays >= 0 && renewalDays <= 14 && (
        <Banner tone="secondary" icon={<Calendar size={14} />}>
          Renews in {renewalDays} day{renewalDays === 1 ? '' : 's'} ({fmtDate(s.nextRenewal)})
        </Banner>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Each charge"
          value={formatMoney(s.cost, totalPaid.currency)}
          sub={s.cadence}
        />
        <StatCard label="Annual cost" value={formatMoney(s.annualCost, totalPaid.currency)} />
        <StatCard
          label={totalPaid.estimated ? 'Paid to date (est.)' : 'Paid to date'}
          value={formatMoney(totalPaid.totalSpend, totalPaid.currency)}
          sub={
            totalPaid.estimated
              ? 'no ledger match'
              : `${totalPaid.txnCount} charge${totalPaid.txnCount === 1 ? '' : 's'}`
          }
        />
        <StatCard label="Last charged" value={fmtDate(totalPaid.lastTxnDate)} />
      </div>

      {/* Signals cross-referenced from the ledger audit + usage detector */}
      {hasSignalBanner && (
        <div className="space-y-2">
          {signals.priceHike && (
            <Banner tone="amber" icon={<TrendingUp size={14} />}>
              Price recently increased{' '}
              <span className="font-medium">+{signals.priceHikePct.toFixed(0)}%</span> — was{' '}
              {formatMoney(signals.historicalMedian, totalPaid.currency)}, now{' '}
              {formatMoney(signals.recentMedian, totalPaid.currency)}.
            </Banner>
          )}
          {(signals.auditStatus === 'zombie' || signals.auditStatus === 'expired') && (
            <Banner tone="amber" icon={<AlertTriangle size={14} />}>
              Compass hasn't seen a charge for this recently — verify it's still active, or mark it
              cancelled.
            </Banner>
          )}
          {signals.isDuplicate && (
            <Banner tone="secondary" icon={<Layers size={14} />}>
              Billed on multiple accounts: {signals.duplicateAccounts.join(', ')} — combined{' '}
              {formatMoney(signals.duplicateCombinedAnnual, totalPaid.currency)}/yr. Possible
              duplicate.
            </Banner>
          )}
          {signals.unusedTrackable && signals.unused && (
            <Banner tone="amber" icon={<AlertTriangle size={14} />}>
              No activity seen in the last {signals.unusedWindowDays} days. Worth a cancel or a
              pause?
            </Banner>
          )}
        </div>
      )}

      {/* Worth it? — manual self-check-in, no usage-tracking API involved */}
      <Section icon={<Heart size={14} />} title="Is this worth it?">
        <div className="flex flex-wrap gap-1.5">
          {USAGE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={ratingBusy}
              onClick={() => void rate(o.value)}
              className={cn(
                'text-xs px-3 py-1.5 rounded-full border transition-colors disabled:opacity-50',
                usageRating === o.value
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/30'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {s.meta?.usage?.ratedAt && (
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Last rated{' '}
            {new Date(s.meta.usage.ratedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
          </p>
        )}
      </Section>

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
        {documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Receipts, contracts, cancellation confirmations — attach anything worth keeping with
            this subscription.
          </p>
        ) : (
          <ul className="space-y-1">
            {documents.map((d) => (
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

      {/* Details (read view) */}
      {!editing && (s.notes || s.paymentAccount) && (
        <Section icon={<Receipt size={14} />} title="Details">
          <div className="space-y-1.5 text-sm">
            {s.paymentAccount && <DetailLine label="Account">{s.paymentAccount}</DetailLine>}
            {s.notes && (
              <DetailLine label="Notes">
                <span className="whitespace-pre-wrap">{s.notes}</span>
              </DetailLine>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

function Banner({
  tone,
  icon,
  children
}: {
  tone: 'amber' | 'secondary' | 'destructive'
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const toneClass = {
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    secondary: 'border-border bg-secondary/40 text-muted-foreground',
    destructive: 'border-destructive/30 bg-destructive/10 text-destructive'
  }[tone]
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm', toneClass)}>
      <span className="shrink-0 mt-0.5">{icon}</span>
      <div>{children}</div>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-foreground mt-0.5 tabular-nums truncate">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 capitalize">{sub}</p>}
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

/** Shared by Subscriptions.tsx for the "Add new" flow — same field set,
 * whether creating a manual subscription or editing a tracked one. */
export function EditForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy
}: {
  draft: SubscriptionInput
  setDraft: (d: SubscriptionInput) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
}): JSX.Element {
  const input =
    'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'
  return (
    <div className="bg-card border border-primary/30 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Edit subscription</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close form"
          className="text-muted-foreground hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            className={input}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Cost">
          <input
            className={input}
            type="number"
            step="0.01"
            value={draft.cost ?? 0}
            onChange={(e) => setDraft({ ...draft, cost: Number(e.target.value) })}
          />
        </Field>
        <Field label="Cadence">
          <select
            className={input}
            value={draft.cadence}
            onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className={input}
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            {STATUSES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <input
            className={input}
            value={draft.category ?? ''}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          />
        </Field>
        <Field label="Next renewal">
          <input
            className={input}
            placeholder="YYYY-MM-DD"
            value={draft.nextRenewal ?? ''}
            onChange={(e) => setDraft({ ...draft, nextRenewal: e.target.value })}
          />
        </Field>
        <Field label="Trial ends">
          <input
            className={input}
            placeholder="YYYY-MM-DD"
            value={draft.trialEndsAt ?? ''}
            onChange={(e) => setDraft({ ...draft, trialEndsAt: e.target.value })}
          />
        </Field>
        <Field label="Payment account">
          <input
            className={input}
            value={draft.paymentAccount ?? ''}
            onChange={(e) => setDraft({ ...draft, paymentAccount: e.target.value })}
          />
        </Field>
        <Field label="Cancel URL">
          <input
            className={input}
            value={draft.cancelUrl ?? ''}
            onChange={(e) => setDraft({ ...draft, cancelUrl: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <textarea
            className={input}
            rows={2}
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex gap-2 justify-end mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped by this label — association is correct, biome just can't see through {children}
    <label className="block">
      <span className="text-xs text-muted-foreground mb-1 block">{label}</span>
      {children}
    </label>
  )
}
