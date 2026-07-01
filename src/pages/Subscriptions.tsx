import {
  AlertTriangle,
  CreditCard,
  Download,
  ExternalLink,
  History,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semi-annual', 'yearly']
const STATUSES = ['active', 'paused', 'cancelled']

const EMPTY: SubscriptionInput = {
  name: '',
  cost: 0,
  cadence: 'monthly',
  category: '',
  status: 'active',
  nextRenewal: '',
  paymentAccount: '',
  cancelUrl: '',
  notes: ''
}

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function Subscriptions(): JSX.Element {
  const [subs, setSubs] = useState<SubscriptionRecord[]>([])
  const [detected, setDetected] = useState<DetectedSubscriptions | null>(null)
  const [candidates, setCandidates] = useState<DerivedEntity[]>([])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<SubscriptionInput>(EMPTY)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    if (!isElectron()) return
    const [list, det, cand] = await Promise.all([
      window.api.subscriptions.list(),
      window.api.subscriptions.getDetected().catch(() => null),
      window.api.entities.list({ kind: 'subscription-candidate' }).catch(() => [])
    ])
    setSubs(list)
    setDetected(det)
    setCandidates(cand)
  }

  const activeAnnual = subs
    .filter((s) => s.status === 'active')
    .reduce((sum, s) => sum + s.annualCost, 0)

  const untrackedDetected = (detected?.active ?? []).filter((d) => !d.tracked)
  // Records-derived subscription candidates the user hasn't tracked yet. Exclude
  // any already promoted (engine flags `promotedKind==='subscription'`), any the
  // finance audit already surfaces above (same normalized merchant key), and any
  // the user already curates in the owned list (manual subs the engine can't flag,
  // matched by name) — so a service is never listed twice.
  const detectedMerchants = new Set((detected?.active ?? []).map((d) => d.merchant))
  const ownedSubNames = new Set(subs.map((s) => s.name.trim().toLowerCase()))
  const untrackedCandidates = candidates.filter(
    (c) =>
      c.promotedKind !== 'subscription' &&
      !detectedMerchants.has(c.key) &&
      !ownedSubNames.has(c.key) &&
      !ownedSubNames.has(c.name.trim().toLowerCase())
  )

  function startAdd(): void {
    setDraft({ ...EMPTY })
    setEditing('new')
  }
  function startEdit(s: SubscriptionRecord): void {
    setDraft({
      name: s.name,
      cost: s.cost,
      cadence: s.cadence,
      category: s.category ?? '',
      status: s.status,
      nextRenewal: s.nextRenewal ?? '',
      paymentAccount: s.paymentAccount ?? '',
      cancelUrl: s.cancelUrl ?? '',
      notes: s.notes ?? ''
    })
    setEditing(s.id)
  }

  async function save(): Promise<void> {
    if (!isElectron()) return
    if (!draft.name?.trim()) {
      toast('A subscription needs a name.', 'error')
      return
    }
    setBusy(true)
    try {
      if (editing === 'new') {
        await window.api.subscriptions.create(draft)
        toast('Subscription added.', 'success')
      } else if (typeof editing === 'number') {
        await window.api.subscriptions.update(editing, draft)
        toast('Subscription saved.', 'success')
      }
      setEditing(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function remove(s: SubscriptionRecord): Promise<void> {
    const ok = await confirm({
      title: 'Delete subscription?',
      description: `${s.name} will be removed from your tracked list.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok || !isElectron()) return
    await window.api.subscriptions.delete(s.id)
    await load()
  }

  async function track(d: DetectedSubscription): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      await window.api.subscriptions.trackDetected({
        merchant: d.merchant,
        account: d.account,
        category: d.category,
        cadence: d.cadence,
        medianAmount: d.medianAmount
      })
      toast(`Now tracking ${d.merchant}.`, 'success')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function trackCandidate(c: DerivedEntity): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      const res = await window.api.entities.promote({ kind: 'subscription-candidate', key: c.key })
      if (res.success) toast(`Now tracking ${c.name}.`, 'success')
      else toast(res.error ?? 'Could not track this subscription.', 'error')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv(): Promise<void> {
    if (!isElectron()) return
    const r = await window.api.subscriptions.exportCsv()
    if (r.canceled) return
    if (r.success) toast(`Exported ${r.count ?? 0} subscription(s).`, 'success')
    else toast(`Export failed: ${r.error}`, 'error')
  }

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <CreditCard size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Subscriptions</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{money(activeAnnual)}</span>/yr across{' '}
            {subs.filter((s) => s.status === 'active').length} active
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors"
          >
            <Download size={12} /> CSV
          </button>
          <button
            type="button"
            onClick={startAdd}
            className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {editing !== null && (
        <SubscriptionForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setEditing(null)}
          busy={busy}
        />
      )}

      {subs.length === 0 && editing === null ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
            <CreditCard size={26} />
          </div>
          <p className="text-sm text-muted-foreground max-w-sm">
            Track every recurring cost in one place — even the ones Compass can't see in your
            transactions. Add one, or pull from what we detected below.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {subs.map((s) => (
            <SubscriptionCard
              key={s.id}
              sub={s}
              onEdit={() => startEdit(s)}
              onDelete={() => remove(s)}
            />
          ))}
        </div>
      )}

      {untrackedDetected.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Sparkles size={12} /> Detected in your transactions ({untrackedDetected.length})
          </h2>
          <p className="text-xs text-muted-foreground/70 mb-3">
            Recurring charges Compass spotted but you're not tracking yet.
          </p>
          <div className="space-y-2">
            {untrackedDetected.map((d) => (
              <div
                key={`${d.merchant}::${d.account}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground capitalize flex items-center gap-2">
                    {d.merchant}
                    {d.priceHike && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500">
                        <AlertTriangle size={9} /> +{d.priceHikePct.toFixed(0)}%
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {d.cadence} · {money(d.medianAmount)} · {money(d.annualCost)}/yr · {d.account}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => track(d)}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                >
                  <Plus size={11} /> Track
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {untrackedCandidates.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <History size={12} /> From your timeline ({untrackedCandidates.length})
          </h2>
          <p className="text-xs text-muted-foreground/70 mb-3">
            Recurring services Compass found across your imported data (PayPal, Amazon, Netflix…) —
            not just your bank transactions.
          </p>
          <div className="space-y-2">
            {untrackedCandidates.map((c) => (
              <div
                key={c.key}
                className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground capitalize">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.attrs.cadence ?? 'recurring'}
                    {c.attrs.medianAmount != null && ` · ${money(c.attrs.medianAmount)}`}
                    {c.attrs.annualCost != null && ` · ${money(c.attrs.annualCost)}/yr`}
                    {c.sources.length > 0 && ` · ${c.sources.join(', ')}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => trackCandidate(c)}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                >
                  <Plus size={11} /> Track
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-400',
  paused: 'bg-amber-500/15 text-amber-500',
  cancelled: 'bg-muted text-muted-foreground'
}

function SubscriptionCard({
  sub,
  onEdit,
  onDelete
}: {
  sub: SubscriptionRecord
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 group">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground flex items-center gap-2">
          {sub.name}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full capitalize',
              STATUS_STYLE[sub.status] ?? 'bg-muted text-muted-foreground'
            )}
          >
            {sub.status}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {sub.cadence} · {money(sub.cost)} · {money(sub.annualCost)}/yr
          {sub.category ? ` · ${sub.category}` : ''}
          {sub.nextRenewal ? ` · renews ${sub.nextRenewal}` : ''}
        </p>
      </div>
      {sub.cancelUrl && (
        <a
          href={sub.cancelUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-primary transition-colors"
          title="Cancel page"
          aria-label={`Open cancel page for ${sub.name}`}
        >
          <ExternalLink size={14} />
        </a>
      )}
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${sub.name}`}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${sub.name}`}
        className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function SubscriptionForm({
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
    <div className="bg-card border border-primary/30 rounded-xl p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Subscription</h3>
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
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
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
